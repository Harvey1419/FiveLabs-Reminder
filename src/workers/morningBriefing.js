import { supabase, getDailyOverview } from '../db/index.js';
import { sendReminderConfirmation } from '../utils/kapso.js';
import { callChatCompletion } from '../ai/client.js';

const BRIEFING_CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

export function startMorningBriefingWorker() {
  console.log('[morningBriefing] worker started (monitoring 7:30 AM local briefings)');

  setInterval(async () => {
    try {
      await checkAndDispatchBriefings();
    } catch (err) {
      console.error('[morningBriefing] error in cycle:', err);
    }
  }, BRIEFING_CHECK_INTERVAL_MS).unref();
}

async function checkAndDispatchBriefings() {
  const { data: users, error } = await supabase
    .from('users')
    .select('*')
    .eq('morning_briefing_enabled', true);

  if (error || !users || users.length === 0) return;

  const now = new Date();

  for (const user of users) {
    const tz = user.timezone || 'America/Bogota';

    // Get current local time for user (HH:mm)
    const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const localTimeStr = timeFormatter.format(now); // e.g. "07:30"

    const targetTime = user.morning_briefing_time || '07:30';

    // Check if target minute matches
    if (localTimeStr === targetTime) {
      // Check if already dispatched today
      const todayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      const todayStr = todayFormatter.format(now);

      if (user.last_briefing_at) {
        const lastDateStr = todayFormatter.format(new Date(user.last_briefing_at));
        if (lastDateStr === todayStr) {
          continue; // Already sent today
        }
      }

      await dispatchBriefingForUser(user, todayStr, tz);
    }
  }
}

async function dispatchBriefingForUser(user, todayStr, timezone) {
  try {
    const overview = await getDailyOverview({ userId: user.id, phoneNumber: user.phone_number, timezone });

    const totalToday = (overview.pendingToday?.reminders?.length || 0) + (overview.pendingToday?.tasks?.length || 0);

    let messageText = '';
    if (totalToday === 0) {
      messageText = `🌅 *¡Buenos días!* ☕\n\nHoy no tienes compromisos urgentes ni alarmas agendadas en tu calendario. Tienes el día completamente libre para avanzar a tu propio ritmo. ¡Que tengas una excelente jornada! 🚀`;
    } else {
      const itemsList = [
        ...(overview.pendingToday.reminders || []).map(r => `• ⏰ *${r.localTime}*: ${r.content}`),
        ...(overview.pendingToday.tasks || []).map(t => `• 📋 *Tarea*: ${t.content}`),
      ].join('\n');

      messageText = `🌅 *¡Buenos días! Aquí tienes tu agenda para hoy (${todayStr}):*\n\n${itemsList}\n\n💡 *Tip ejecutivo*: Si necesitas mover alguna cita o agregar una nueva, solo dímelo. ¡Con toda hoy! 🎯`;
    }

    await sendReminderConfirmation(user.phone_number, messageText);
    console.log(`[morningBriefing] sent morning briefing to ${user.phone_number}`);

    // Update last_briefing_at
    await supabase.from('users')
      .update({ last_briefing_at: new Date().toISOString() })
      .eq('id', user.id);

  } catch (err) {
    console.error(`[morningBriefing] failed to dispatch for user ${user.id}:`, err);
  }
}
