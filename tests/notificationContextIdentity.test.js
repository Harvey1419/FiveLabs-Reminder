import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { supabase, getOrCreateUserByPhone, saveReminder } from '../src/db/index.js';
import { routeMessage } from '../src/ai/router.js';
import { saveWorkingMemory, getWorkingMemory, clearWorkingMemory } from '../src/ai/workingMemory.js';

describe.sequential('Notification Context & Affirmative "Ya" Identity Regression Suite', () => {
  const testPhone = '+573999123456';
  let user;

  beforeAll(async () => {
    user = await getOrCreateUserByPhone(testPhone, 'America/Bogota');
    await supabase.from('subscriptions').upsert({
      user_id: user.id,
      mp_preapproval_id: `test_preapproval_notif_reg_${Date.now()}`,
      plan: 'pro',
      status: 'authorized',
      amount: 49900,
    }, { onConflict: 'user_id' });
  }, 20000);

  beforeEach(async () => {
    clearWorkingMemory(testPhone);
    clearWorkingMemory(user.id);
    await supabase.from('reminders').delete().eq('user_id', user.id);
    await new Promise(r => setTimeout(r, 2000));
  });

  afterAll(async () => {
    if (user?.id) {
      clearWorkingMemory(testPhone);
      clearWorkingMemory(user.id);
      await supabase.from('reminders').delete().eq('user_id', user.id);
      await supabase.from('subscriptions').delete().eq('user_id', user.id);
    }
  });

  it('REGRESSION 1: Multiple pending reminders -> Scheduler nudges CCS Daily -> "Ya" confirms exclusively CCS Daily (not Cita médica)', async () => {
    // 1. Reminder A: Cita médica at 8:00 AM (earlier sent, unacknowledged)
    const remA = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Cita médica de las 8:00 AM',
      sendAt: new Date(Date.now() - 3600000).toISOString(),
      requiresConfirmation: true,
    });
    await supabase.from('reminders').update({
      status: 'sent',
      sent_at: new Date(Date.now() - 3600000).toISOString(),
      acknowledged_at: null,
    }).eq('id', remA.id);

    // 2. Reminder B: [Aviso previo] CCS Daily interna (nudged by scheduler)
    const remB = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: '[Aviso previo] CCS Daily interna',
      sendAt: new Date(Date.now() - 600000).toISOString(),
      requiresConfirmation: true,
      nudgeIntervalMinutes: 10,
      maxNudges: 3,
    });
    await supabase.from('reminders').update({
      status: 'sent',
      sent_at: new Date(Date.now() - 600000).toISOString(),
      last_nudged_at: new Date(Date.now() - 30000).toISOString(),
      nudge_count: 1,
      acknowledged_at: null,
    }).eq('id', remB.id);

    // 3. Reminder C: Tomar suplemento vitamínico (scheduled for later)
    const remC = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Tomar suplemento vitamínico',
      sendAt: new Date(Date.now() + 3600000).toISOString(),
      requiresConfirmation: true,
    });

    // 4. Scheduler dispatches notification for Reminder B:
    const wmPayload = {
      source: 'reminder',
      scope: 'today',
      lastAction: 'nudge',
      notificationReminderId: remB.id,
      notificationContent: 'CCS Daily interna',
      items: [{
        position: 1,
        type: 'reminder',
        internalId: remB.id,
        summary: 'CCS Daily interna',
        raw: remB,
      }],
    };
    saveWorkingMemory(testPhone, wmPayload);
    saveWorkingMemory(user.id, wmPayload);

    // 5. User replies with "Ya"
    const res = await routeMessage('Ya', user);

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('CCS Daily interna');
    expect(res.confirmation).not.toContain('Cita médica');

    // 6. DB assertions: Rem B MUST be acknowledged; Rem A & Rem C MUST remain unacknowledged
    const { data: checkRemA } = await supabase.from('reminders').select('acknowledged_at').eq('id', remA.id).single();
    const { data: checkRemB } = await supabase.from('reminders').select('acknowledged_at').eq('id', remB.id).single();
    const { data: checkRemC } = await supabase.from('reminders').select('acknowledged_at').eq('id', remC.id).single();

    expect(checkRemB.acknowledged_at).not.toBeNull();
    expect(checkRemA.acknowledged_at).toBeNull();
    expect(checkRemC.acknowledged_at).toBeNull();
  }, 45000);

  it('REGRESSION 2: Inverted order -> Scheduler nudges Cita médica -> "ya" confirms exclusively Cita médica (not CCS Daily)', async () => {
    // Reminder A: Cita médica
    const remA = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Cita médica de las 8:00 AM',
      sendAt: new Date(Date.now() - 3600000).toISOString(),
      requiresConfirmation: true,
      nudgeIntervalMinutes: 10,
      maxNudges: 3,
    });
    await supabase.from('reminders').update({
      status: 'sent',
      sent_at: new Date(Date.now() - 3600000).toISOString(),
      last_nudged_at: new Date(Date.now() - 15000).toISOString(),
      nudge_count: 1,
      acknowledged_at: null,
    }).eq('id', remA.id);

    // Reminder B: CCS Daily interna
    const remB = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: '[Aviso previo] CCS Daily interna',
      sendAt: new Date(Date.now() - 600000).toISOString(),
      requiresConfirmation: true,
    });
    await supabase.from('reminders').update({
      status: 'sent',
      sent_at: new Date(Date.now() - 600000).toISOString(),
      acknowledged_at: null,
    }).eq('id', remB.id);

    // Scheduler dispatches notification for Reminder A:
    const wmPayload = {
      source: 'reminder',
      scope: 'today',
      lastAction: 'nudge',
      notificationReminderId: remA.id,
      notificationContent: 'Cita médica de las 8:00 AM',
      items: [{
        position: 1,
        type: 'reminder',
        internalId: remA.id,
        summary: 'Cita médica de las 8:00 AM',
        raw: remA,
      }],
    };
    saveWorkingMemory(testPhone, wmPayload);
    saveWorkingMemory(user.id, wmPayload);

    // User replies with "ya" (lowercase)
    const res = await routeMessage('ya', user);

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('Cita médica');
    expect(res.confirmation).not.toContain('CCS Daily interna');

    const { data: checkRemA } = await supabase.from('reminders').select('acknowledged_at').eq('id', remA.id).single();
    const { data: checkRemB } = await supabase.from('reminders').select('acknowledged_at').eq('id', remB.id).single();

    expect(checkRemA.acknowledged_at).not.toBeNull();
    expect(checkRemB.acknowledged_at).toBeNull();
  }, 45000);

  it('REGRESSION 3: Punctuation affirmative ("Ya.") confirms notification reminder without calling LLM', async () => {
    const rem = await saveReminder({
      userId: user.id,
      phoneNumber: testPhone,
      content: 'Comprar boletos de avión',
      sendAt: new Date(Date.now() - 300000).toISOString(),
      requiresConfirmation: true,
    });
    await supabase.from('reminders').update({
      status: 'sent',
      sent_at: new Date(Date.now() - 300000).toISOString(),
      last_nudged_at: new Date(Date.now() - 20000).toISOString(),
      nudge_count: 1,
      acknowledged_at: null,
    }).eq('id', rem.id);

    const wmPayload = {
      source: 'reminder',
      scope: 'today',
      lastAction: 'nudge',
      notificationReminderId: rem.id,
      notificationContent: 'Comprar boletos de avión',
      items: [{
        position: 1,
        type: 'reminder',
        internalId: rem.id,
        summary: 'Comprar boletos de avión',
        raw: rem,
      }],
    };
    saveWorkingMemory(testPhone, wmPayload);
    saveWorkingMemory(user.id, wmPayload);

    const res = await routeMessage('Ya.', user);

    expect(res.intent).toBe('reminder');
    expect(res.confirmation).toContain('Comprar boletos de avión');

    const { data: checkRem } = await supabase.from('reminders').select('acknowledged_at').eq('id', rem.id).single();
    expect(checkRem.acknowledged_at).not.toBeNull();
  }, 45000);
});
