import { supabase, getDailyOverview } from '../db/index.js';
import { sendReminderConfirmation, isWithin24HourWindow } from '../utils/kapso.js';
import { callChatCompletion } from '../ai/client.js';

const BRIEFING_CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

export function startMorningBriefingWorker() {
  console.log('[morningBriefing] worker started (monitoring 6:00 AM local briefings)');

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
    const localTimeStr = timeFormatter.format(now); // e.g. "06:00"

    const targetTime = user.morning_briefing_time || '06:00';

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

      // Cost & Anti-Spam Guard: Only dispatch morning briefing if user is active in 24h window
      const isUserActive = await isWithin24HourWindow(user.phone_number);
      if (!isUserActive) {
        console.log(`[morningBriefing] Skipping briefing for ${user.phone_number}: outside active 24h window.`);
        continue;
      }

      await dispatchBriefingForUser(user, todayStr, tz);
    }
  }
}

async function dispatchBriefingForUser(user, todayStr, timezone) {
  try {
    const overview = await getDailyOverview({ userId: user.id, phoneNumber: user.phone_number, timezone });

    const pendingItems = overview.pendingToday || [];

    let messageText = '';
    if (pendingItems.length === 0) {
      messageText = `🌅 *¡Buenos días!* ☕\n\nHoy no tienes compromisos urgentes ni tareas pendientes para hoy. ¡Que tengas una excelente jornada! 🚀`;
    } else {
      const itemsList = pendingItems.map(item => {
        if (item.localTime) {
          return `• ⏰ *${item.localTime}*: ${item.content}`;
        }
        return `• 📋 *Tarea*: ${item.content}`;
      }).join('\n');

      messageText = `🌅 *¡Buenos días! Aquí tienes tus pendientes y agenda para hoy (${todayStr}):*\n\n${itemsList}\n\n💡 *Tip ejecutivo*: Si necesitas mover alguna cita o agregar una nueva, solo dímelo. ¡Con toda hoy! 🎯`;
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
