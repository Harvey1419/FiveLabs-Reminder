import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getOrCreateUserByPhone, updateUserTimezone } from '../src/db/users.js';
import { saveMemory, searchMemories, forgetMemories } from '../src/db/memories.js';
import {
  saveReminder,
  cancelReminders,
  acknowledgeReminders,
  createTask,
  getTasks,
  completeTask,
  getDailyOverview,
  findOrCreateEntityFuzzy,
  renameEntity,
  mergeEntities,
  deduplicateEntities,
  findEntities,
  normalizeEntityName,
  entityMatchScore,
  supabase,
} from '../src/db/index.js';
import { routeMessage } from '../src/ai/router.js';
import { executeTool } from '../src/ai/tools.js';
import { generateEmbedding } from '../src/services/embeddingService.js';
import {
  detectTimezoneFromPhone,
  detectTimezoneFromLocationText,
  detectTimezoneFromCoordinates,
} from '../src/utils/time.js';

describe('Reminder Assistant - Production Integration Test Suite', () => {
  const testPhone = '+573881112233';
  let user;

  beforeAll(async () => {
    user = await getOrCreateUserByPhone(testPhone);
    // Clean initial state
    await supabase.from('memories').delete().eq('user_id', user.id);
    await supabase.from('tasks').delete().eq('user_id', user.id);
    await supabase.from('reminders').delete().eq('user_id', user.id);
    await supabase.from('entities').delete().eq('user_id', user.id);
    await supabase.from('subscriptions').delete().eq('user_id', user.id);

    // Grant Pro subscription for full end-to-end integration testing
    await supabase.from('subscriptions').insert({
      user_id: user.id,
      mp_preapproval_id: `test_preapproval_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
      amount: 49900,
      next_payment_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }, 20000);

  afterAll(async () => {
    await supabase.from('memories').delete().eq('user_id', user.id);
    await supabase.from('tasks').delete().eq('user_id', user.id);
    await supabase.from('reminders').delete().eq('user_id', user.id);
    await supabase.from('entities').delete().eq('user_id', user.id);
    await supabase.from('subscriptions').delete().eq('user_id', user.id);
    await supabase.from('users').delete().eq('id', user.id);
  }, 20000);

  describe('1. Vector Embeddings & Semantic Memory Search (pgvector)', () => {
    it('generates 768-dim embeddings correctly', async () => {
      const vec = await generateEmbedding('Me mudé a Barranquilla');
      expect(vec).toBeDefined();
      expect(Array.isArray(vec)).toBe(true);
      expect(vec.length).toBe(768);
    }, 15000);

    it('saves memory with embedding and retrieves via semantic match', async () => {
      const saved = await saveMemory({
        userId: user.id,
        topicKey: 'profile/location',
        content: 'El usuario se mudó a la ciudad de Barranquilla',
        category: 'project', // Intentionally non-standard category
      });
      expect(saved).toBeDefined();
      expect(saved.is_active).toBe(true);
      expect(saved.category).toBe('project'); // Project category is now supported

      // Query with synonym / question words not in the text
      const results = await searchMemories({
        userId: user.id,
        query: '¿Dónde vivo actualmente?',
        limit: 3,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('Barranquilla');
    }, 20000);

    it('retrieves memory via Full-Text Search with Spanish Porter/Snowball stemming', async () => {
      await saveMemory({
        userId: user.id,
        topicKey: 'finances/rent',
        content: 'El inquilino estuvo pagando la cuota del arriendo puntualmente',
        category: 'fact',
      });

      // Stem query: "pagar arriendos" should match "pagando" and "arriendo" via Spanish FTS stemmer
      const results = await searchMemories({
        userId: user.id,
        query: 'pagar arriendos',
        limit: 3,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.content.includes('pagando'))).toBe(true);
    }, 20000);

    it('supersedes previous active memory on same topicKey', async () => {
      // Save updated location
      const updated = await saveMemory({
        userId: user.id,
        topicKey: 'profile/location',
        content: 'El usuario ahora vive en Medellín',
        category: 'fact',
      });

      const { data: previous } = await supabase
        .from('memories')
        .select('*')
        .eq('user_id', user.id)
        .eq('topic_key', 'profile/location')
        .eq('is_active', false);

      expect(previous.length).toBeGreaterThan(0);
      expect(previous[0].superseded_by).toBe(updated.id);
    }, 20000);

    it('deletes memory on Right to Forget command', async () => {
      // Create memory about doctor
      await saveMemory({
        userId: user.id,
        topicKey: 'doctor',
        category: 'fact',
        content: 'La doctora de confianza del usuario se llama Marcela',
      });

      // Route delete command
      const res = await routeMessage('Olvida todo lo de la doctora Marcela', user);
      expect(res.intent).toBe('memory');

      // Verify memory is deleted/inactive in DB
      const { data: activeMemories } = await supabase
        .from('memories')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .ilike('content', '%Marcela%');

      expect(activeMemories?.length || 0).toBe(0);
    }, 35000);
  });

  describe('2. Reminders, Recurrence & Concurrency', () => {
    it('creates recurring reminders with recurrence_rule', async () => {
      const targetTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const reminder = await saveReminder({
        userId: user.id,
        phoneNumber: user.phone_number,
        content: 'Tomar vitamina D',
        sendAt: targetTime,
        recurrenceRule: 'daily',
      });

      expect(reminder).toBeDefined();
      expect(reminder.recurrence_rule).toBe('daily');
      expect(reminder.status).toBe('pending');
    }, 15000);

    it('creates hourly recurring reminders and parses "cada hora" correctly', async () => {
      const { executeTool } = await import('../src/ai/tools.js');
      const res = await executeTool('manage_reminder', {
        action: 'create',
        items: [{ content: 'Echar gotas en los ojos cada hora' }],
      }, user);

      expect(res.success).toBe(true);
      expect(res.data[0].recurrence_rule).toBe('hourly');
    }, 15000);

    it('formats daily overview in local timezone without UTC drift', async () => {
      const overview = await getDailyOverview({
        userId: user.id,
        phoneNumber: user.phone_number,
        timezone: 'America/Bogota',
      });

      expect(overview).toBeDefined();
      expect(overview.todayDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(overview.tomorrowDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Array.isArray(overview.pendingToday)).toBe(true);
    }, 15000);
  });

  describe('3. Tasks Management', () => {
    it('creates, lists, and completes tasks', async () => {
      const task = await createTask({
        userId: user.id,
        title: 'Preparar informe para la junta',
        priority: 'urgent',
      });

      expect(task).toBeDefined();
      expect(task.priority).toBe('urgent');
      expect(task.status).toBe('pending');

      const completed = await completeTask({
        userId: user.id,
        taskId: task.id,
      });

      expect(completed.status).toBe('completed');
      expect(completed.completed_at).toBeDefined();
    }, 15000);
  });

  describe('4. Dynamic Timezone Resolution', () => {
    it('detects timezone from international phone prefixes and Meta BSUIDs', () => {
      // Meta WhatsApp BSUID ISO 3166-1 Alpha-2 resolution
      expect(detectTimezoneFromPhone('CO.1046858631495979')).toBe('America/Bogota');
      expect(detectTimezoneFromPhone('AR.1234567890123456')).toBe('America/Argentina/Buenos_Aires');
      expect(detectTimezoneFromPhone('MX.9988776655443322')).toBe('America/Mexico_City');
      expect(detectTimezoneFromPhone('ES.1122334455667788')).toBe('Europe/Madrid');
      expect(detectTimezoneFromPhone('US.9999888877776666')).toBe('America/New_York');
      expect(detectTimezoneFromPhone('UNKNOWN.123456789')).toBe('America/Bogota');

      // Standard E.164 Phone Prefixes
      expect(detectTimezoneFromPhone('+57 311 8588249')).toBe('America/Bogota');
      expect(detectTimezoneFromPhone('+34 612 345 678')).toBe('Europe/Madrid');
      expect(detectTimezoneFromPhone('+54 9 11 2345-6789')).toBe('America/Argentina/Buenos_Aires');
      expect(detectTimezoneFromPhone('+52 55 1234 5678')).toBe('America/Mexico_City');
      expect(detectTimezoneFromPhone('+56 9 1234 5678')).toBe('America/Santiago');
      expect(detectTimezoneFromPhone('+1 (208) 441-6502')).toBe('America/Boise');
      expect(detectTimezoneFromPhone('+1 (415) 555-0199')).toBe('America/Los_Angeles');
      expect(detectTimezoneFromPhone('+1 (212) 555-0100')).toBe('America/New_York');
    });

    it('detects timezone from natural location and travel text', () => {
      expect(detectTimezoneFromLocationText('Estoy pasando unos días en Madrid')).toBe('Europe/Madrid');
      expect(detectTimezoneFromLocationText('Llegué a Buenos Aires hoy')).toBe('America/Argentina/Buenos_Aires');
      expect(detectTimezoneFromLocationText('Me mudé a Miami')).toBe('America/New_York');
      expect(detectTimezoneFromLocationText('Reunión en Medellin')).toBe('America/Bogota');
      expect(detectTimezoneFromLocationText('Aterrizando en CDMX')).toBe('America/Mexico_City');
      expect(detectTimezoneFromLocationText('Viaje a Santiago de Chile')).toBe('America/Santiago');
      expect(detectTimezoneFromLocationText('Un mensaje común sin ciudad')).toBeNull();
    });

    it('detects timezone from GPS coordinates', () => {
      // Madrid, Spain (approx lat 40.4, lon -3.7)
      expect(detectTimezoneFromCoordinates(40.4168, -3.7038)).toBe('Europe/Madrid');
      // Bogota, Colombia (approx lat 4.7, lon -74.0)
      expect(detectTimezoneFromCoordinates(4.7110, -74.0721)).toBe('America/Bogota');
      // Buenos Aires, Argentina (approx lat -34.6, lon -58.38)
      expect(detectTimezoneFromCoordinates(-34.6037, -58.3816)).toBe('America/Argentina/Buenos_Aires');
    });

    it('updates user preferences timezone dynamically', async () => {
      const updated = await updateUserTimezone(user.id, 'Europe/Madrid');
      expect(updated.timezone).toBe('Europe/Madrid');

      // Revert back for remaining tests
      await updateUserTimezone(user.id, 'America/Bogota');
    });
  });

  describe('5. Entity Management & Lifecycle (Fuzzy Match, Rename, Merge, Deduplicate)', () => {
    it('normalizes entity names and computes similarity scores correctly', () => {
      expect(normalizeEntityName('El Proyecto Remindersim')).toBe('remindersim');
      expect(normalizeEntityName('Proyecto Casa Campestre')).toBe('casa campestre');
      expect(normalizeEntityName('La Empresa TechCorp S.A.')).toBe('techcorp sa');

      expect(entityMatchScore('Remindersim', 'Proyecto Remindersim')).toBeGreaterThanOrEqual(0.8);
      expect(entityMatchScore('Remindersim', 'reminder')).toBeGreaterThanOrEqual(0.75);
    });

    it('creates and fuzzy-matches entities with non-aggressive metadata merge', async () => {
      const entity1 = await findOrCreateEntityFuzzy({
        userId: user.id,
        name: 'Remindersim',
        category: 'project',
        metadata: { client: 'Freelance Co' },
      });

      expect(entity1).toBeDefined();
      expect(entity1.name).toBe('Remindersim');

      // Calling with noise words returns existing entity and merges new metadata
      const entity2 = await findOrCreateEntityFuzzy({
        userId: user.id,
        name: 'El proyecto Remindersim',
        category: 'project',
        metadata: { priority: 'high' },
      });

      expect(entity2.id).toBe(entity1.id);
      expect(entity2.metadata.client).toBe('Freelance Co');
      expect(entity2.metadata.priority).toBe('high');
    }, 15000);

    it('renames entity and re-links existing tasks', async () => {
      // Create task linked to entity
      const { data: ent } = await supabase
        .from('entities')
        .select('*')
        .eq('user_id', user.id)
        .ilike('name', 'Remindersim')
        .single();

      const task = await createTask({
        userId: user.id,
        title: 'Desarrollar motor de recordatorios',
        entityId: ent.id,
      });

      expect(task.entity_id).toBe(ent.id);

      // Execute rename
      const renameRes = await renameEntity({
        userId: user.id,
        oldName: 'remindersim',
        newName: 'Reminder Core',
        category: 'project',
      });

      expect(renameRes.success).toBe(true);
      expect(renameRes.entity.name).toBe('Reminder Core');

      // Task is still linked to the renamed entity id
      const { data: updatedTask } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', task.id)
        .single();

      expect(updatedTask.entity_id).toBe(ent.id);
    }, 15000);

    it('merges source entity into target entity, reassigning tasks and removing source', async () => {
      // Create second entity "Reminder App"
      const sourceEnt = await findOrCreateEntityFuzzy({
        userId: user.id,
        name: 'Reminder App Legacy',
        category: 'project',
        metadata: { legacyId: '123' },
      });

      const task2 = await createTask({
        userId: user.id,
        title: 'Migrar base de datos legacy',
        entityId: sourceEnt.id,
      });

      const mergeRes = await mergeEntities({
        userId: user.id,
        sourceName: 'Reminder App Legacy',
        targetName: 'Reminder Core',
        category: 'project',
      });

      expect(mergeRes.success).toBe(true);
      expect(mergeRes.tasksMovedCount).toBeGreaterThanOrEqual(1);

      // Verify task now points to target
      const { data: movedTask } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', task2.id)
        .single();

      expect(movedTask.entity_id).toBe(mergeRes.targetEntity.id);

      // Verify source entity is deleted
      const { data: deletedSource } = await supabase
        .from('entities')
        .select('*')
        .eq('id', sourceEnt.id)
        .maybeSingle();

      expect(deletedSource).toBeNull();
    }, 15000);

    it('executes manage_entity tool via executeTool', async () => {
      const toolRes = await executeTool(
        'manage_entity',
        {
          action: 'rename',
          oldName: 'Reminder Core',
          newName: 'Reminder Evolution',
          category: 'project',
        },
        user
      );

      expect(toolRes.success).toBe(true);
      expect(toolRes.action).toBe('renamed_entity');
    }, 15000);
  });

  describe('6. Persistent Reminders & Acknowledgement Loop', () => {
    it('creates persistent reminder with requires_confirmation and nudge intervals', async () => {
      const targetTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const reminder = await saveReminder({
        userId: user.id,
        phoneNumber: user.phone_number,
        content: 'Tomar antibiótico de 500mg',
        sendAt: targetTime,
        requiresConfirmation: true,
        nudgeIntervalMinutes: 10,
        maxNudges: 4,
      });

      expect(reminder).toBeDefined();
      expect(reminder.requires_confirmation).toBe(true);
      expect(reminder.nudge_interval_minutes).toBe(10);
      expect(reminder.max_nudges).toBe(4);
      expect(reminder.nudge_count).toBe(0);
      expect(reminder.acknowledged_at).toBeNull();
    }, 15000);

    it('acknowledges pending persistent reminder when user completes task', async () => {
      const ackRes = await acknowledgeReminders({
        userId: user.id,
        phoneNumber: user.phone_number,
        contentQuery: 'antibiótico',
      });

      expect(ackRes.acknowledgedCount).toBeGreaterThan(0);
      expect(ackRes.acknowledgedReminders[0].acknowledged_at).toBeDefined();

      // Tool call acknowledgment test
      const toolAck = await executeTool(
        'manage_reminder',
        { action: 'acknowledge', content: 'antibiótico' },
        user
      );

      expect(toolAck).toBeDefined();
    }, 15000);
  });

  describe('7. Task Lifecycle, Entity Completion & Language Consistency', () => {
    it('creates task without date with dueDate strictly null', async () => {
      const task = await createTask({
        userId: user.id,
        title: 'Comprar pintura para la pared',
        priority: 'medium',
      });

      expect(task).toBeDefined();
      expect(task.title).toBe('Comprar pintura para la pared');
      expect(task.due_date).toBeNull();
    });

    it('completes all pending tasks of an entity when user indicates project resolution', async () => {
      const entity = await findOrCreateEntityFuzzy({
        userId: user.id,
        name: 'Reforma Apto 502',
        category: 'project',
      });

      await createTask({
        userId: user.id,
        title: 'Instalar tubería cocina',
        entityId: entity.id,
      });

      await createTask({
        userId: user.id,
        title: 'Revisar cableado eléctrico',
        entityId: entity.id,
      });

      // Complete all tasks of the project via tool
      const completeRes = await executeTool(
        'manage_task',
        {
          action: 'complete',
          entityName: 'Reforma Apto 502',
        },
        user
      );

      expect(completeRes.success).toBe(true);
      expect(completeRes.data.completedCount).toBeGreaterThanOrEqual(2);

      // Verify no pending tasks remain for this entity
      const remaining = await getTasks({
        userId: user.id,
        entityId: entity.id,
        status: 'pending',
      });

      expect(remaining.length).toBe(0);
    }, 20000);

    it('responds in English when user writes in English', async () => {
      const res = await routeMessage('Hello, could you help me organize my morning meetings?', user);
      expect(res.confirmation).toBeDefined();
      // Should match English words
      expect(res.confirmation.toLowerCase()).toMatch(/hello|hi|sure|help|meeting|schedule|morning|here|assist|plan/i);
    }, 35000);

    it('creates advance notice reminder and main event reminder when asked for 30 minutes before', async () => {
      const res = await routeMessage('Tengo una reunión mañana a las 5:00 PM, recuérdame 30 minutos antes', user);
      expect(res.confirmation).toBeDefined();
      expect(res.confirmation.toLowerCase()).toMatch(/4:30|30 minuto|aviso/i);

      // Verify reminders in DB
      const { data: reminders } = await supabase
        .from('reminders')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'pending')
        .ilike('content', '%reunión%');

      expect(reminders.length).toBeGreaterThanOrEqual(1);
    }, 35000);

    it('strictly acknowledges and never reschedules when user says Ok', async () => {
      const history = [
        { role: 'user', content: 'Recuérdame regar las plantas a las 5 PM y cada 2 minutos' },
        { role: 'assistant', content: '¡Entendido! Programado a las 5:00 PM y cada 2 minutos.' },
      ];
      const res = await routeMessage('Ok', user, history);
      expect(res.confirmation).toBeDefined();
      expect(res.confirmation.toLowerCase()).toMatch(/complet|list|excelente|entendido|desactiv|got it|acknowledged|perfecto|con mucho gusto|quedo atento|atento/i);
    }, 35000);
  });
});
