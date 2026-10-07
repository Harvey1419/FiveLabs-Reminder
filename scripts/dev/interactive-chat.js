import 'dotenv/config';
import readline from 'readline';
import { getOrCreateUserByPhone, normalizeUserPhone, updateUserTimezone } from '../../src/infrastructure/database/users.js';
import { routeMessage } from '../../src/agent/orchestration/router.js';
import { saveMessage, getRecentMessages } from '../../src/infrastructure/database/messages.js';
import { extractAndSaveMemories } from '../../src/features/memory/service.js';
import { withQueryEmbeddingScope } from '../../src/integrations/ai/embeddings.js';
import { supabase, markReminderAsSent } from '../../src/infrastructure/database/index.js';
import { formatLocalDateTime } from '../../src/shared/time.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function startInteractiveSession() {
  console.log('\n======================================================');
  console.log(`🤖 REMINDER ASSISTANT - TERMINAL TEST BENCH (${process.env.HERMES_CHAT_DISABLE_REMINDER_SCHEDULER === '1' ? 'Scheduler Disabled' : 'Live Scheduler Active'})`);
  console.log('======================================================');
  console.log('Escribe tus mensajes como si estuvieras en WhatsApp.');
  console.log('Comandos especiales:');
  console.log('  /tz <iana> - Cambiar zona horaria (ej: /tz Europe/Madrid)');
  console.log('  /status   - Ver tareas, recordatorios y memorias en DB');
  console.log('  /clean    - Limpiar datos de este usuario de prueba');
  console.log('  /exit     - Salir');
  console.log('======================================================\n');

  const configuredPhone = process.env.HERMES_CHAT_TEST_PHONE;
  const testPhone = configuredPhone === undefined ? '+573009998877' : normalizeUserPhone(configuredPhone);
  if (configuredPhone !== undefined) {
    if (!/^hermes-chat\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(testPhone)) {
      throw new Error('HERMES_CHAT_TEST_PHONE must be a generated hermes-chat UUID identity');
    }
    const representations = [...new Set([configuredPhone, testPhone])];
    for (const phone of representations) {
      for (const table of ['users', 'messages']) {
        const { data, error } = await supabase.from(table).select('id').eq('phone_number', phone).limit(1);
        if (error) throw error;
        if (data?.length) throw new Error(`Synthetic identity already exists in ${table}; refusing to adopt it`);
      }
    }
  }
  const user = await getOrCreateUserByPhone(testPhone);
  if (configuredPhone !== undefined && (!user.id || !user.is_new)) throw new Error('Synthetic identity was not freshly created; refusing session');
  console.log(`👤 Usuario de prueba activo: ${user.phone_number} (ID: ${user.id}, TZ: ${user.timezone})\n`);

  // --- Live Background Scheduler for Test Bench ---
  const checkIntervalMs = 5000;
  if (process.env.HERMES_CHAT_DISABLE_REMINDER_SCHEDULER !== '1') setInterval(async () => {
    try {
      const nowIso = new Date().toISOString();
      const { data: dueReminders } = await supabase
        .from('reminders')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'pending')
        .lte('send_at', nowIso);

      if (dueReminders && dueReminders.length > 0) {
        for (const r of dueReminders) {
          await markReminderAsSent(r.id);
          const timeStr = formatLocalDateTime(new Date(), user.timezone);
          console.log('\n\n🔔 ======================================================');
          console.log(`🔔 RECORDATORIO DISPARADO (${timeStr})`);
          console.log(`🔔 "⏰ ${r.content}"`);
          console.log('🔔 ======================================================\n');
          process.stdout.write('👤 Tú: ');
        }
      }
    } catch (err) {
      // ignore
    }
  }, checkIntervalMs).unref();

  const promptUser = () => {
    rl.question('\n👤 Tú: ', async (input) => {
      const text = input.trim();
      if (!text) {
        promptUser();
        return;
      }

      if (text === '/exit') {
        console.log('👋 ¡Hasta luego!');
        process.exit(0);
      }

      if (text === '/clean' && configuredPhone !== undefined) {
        console.log('La limpieza de la identidad sintética corresponde al runner.');
        promptUser();
        return;
      }

      if (text === '/clean') {
        await supabase.from('memories').delete().eq('user_id', user.id);
        await supabase.from('tasks').delete().eq('user_id', user.id);
        await supabase.from('reminders').delete().eq('user_id', user.id);
        await supabase.from('entities').delete().eq('user_id', user.id);
        await supabase.from('agent_runs').delete().eq('user_id', user.id);
        await supabase.from('messages').delete().eq('user_id', user.id);
        console.log('🧹 Todos los datos de prueba fueron eliminados de Supabase (incluyendo entities y agent_runs).');
        promptUser();
        return;
      }

      if (text.startsWith('/tz ')) {
        const newTz = text.replace('/tz ', '').trim();
        if (newTz) {
          await updateUserTimezone(user.id, newTz);
          user.timezone = newTz;
          console.log(`🌐 Zona horaria actualizada a: ${newTz}`);
        }
        promptUser();
        return;
      }

      if (text === '/status') {
        const { data: tasks } = await supabase.from('tasks').select('*').eq('user_id', user.id);
        const { data: reminders } = await supabase.from('reminders').select('*').eq('user_id', user.id);
        const { data: memories } = await supabase.from('memories').select('*').eq('user_id', user.id);

        console.log('\n📊 ESTADO EN SUPABASE:');
        console.log('📋 Tareas:', tasks?.length ? tasks.map(t => `[${t.status}] ${t.title}`) : '(0)');
        console.log('⏰ Recordatorios:', reminders?.length ? reminders.map(r => `[${r.status}] ${r.content} -> ${r.send_at}`) : '(0)');
        console.log('🧠 Memorias:', memories?.length ? memories.map(m => `[${m.topic_key || 'general'}] ${m.content} (active: ${m.is_active})`) : '(0)');
        promptUser();
        return;
      }

      try {
        await withQueryEmbeddingScope(user.id, async () => {
        // 1. Guardar mensaje usuario
        await saveMessage({ userId: user.id, phoneNumber: user.phone_number, role: 'user', content: text });

        // 2. Obtener historial reciente
        const history = await getRecentMessages(user.phone_number, 40);

        // 3. Procesar turno
        const result = await routeMessage(text, user, history);
        console.log(`\n🤖 Reminder: ${result.confirmation}`);

        // 4. Guardar respuesta asistente
        await saveMessage({
          userId: user.id,
          phoneNumber: user.phone_number,
          role: 'assistant',
          content: result.confirmation,
          intent: result.intent,
          entities: { ...(result.entities || {}), _responseLanguage: result.language || (user.locale?.startsWith('en') ? 'en' : 'es') },
        });

        // 5. Extracción asíncrona de memoria
        await extractAndSaveMemories({
          userId: user.id,
          userText: text,
          currentUserText: text,
          assistantReply: result.confirmation,
          executionFacts: result.executionFacts,
          memoryDisposition: result.memoryDisposition,
        });
        });

      } catch (err) {
        console.error('Error en turno:', err);
      }

      promptUser();
    });
  };

  promptUser();
}

startInteractiveSession().catch(error => { console.error(error); process.exitCode = 1; rl.close(); });
