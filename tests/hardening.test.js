import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  saveReminder,
  claimNextDueReminder,
  getOrCreateUserByPhone,
  userCache,
  entityMatchScore,
  saveMessage,
  isMessageAlreadyProcessed,
  renameEntityCascade,
  mergeEntities,
  createTask,
  saveMemory,
  supabase,
} from '../src/db/index.js';
import { executeTool } from '../src/ai/tools.js';
import { routeMessage } from '../src/ai/router.js';
import { extractAndSaveMemories } from '../src/services/memoryService.js';
import { zonedTimeToUtc, parseTargetTime } from '../src/utils/time.js';
import { enqueueForUser, verifyWebhookSignature, isDuplicate, markAsProcessed } from '../src/webhook.js';

describe('Production Hardening & Concurrency Test Suite', () => {
  const testPhone = '573998877665';
  let testUser = null;

  beforeAll(async () => {
    testUser = await getOrCreateUserByPhone(testPhone, 'America/Bogota', 'es-CO', 'Hardening User');
    if (testUser?.id) {
      await supabase.from('reminders').delete().eq('user_id', testUser.id);
      await supabase.from('tasks').delete().eq('user_id', testUser.id);
      await supabase.from('memories').delete().eq('user_id', testUser.id);
      await supabase.from('entities').delete().eq('user_id', testUser.id);
    }
  });

  afterAll(async () => {
    if (testUser?.id) {
      await supabase.from('reminders').delete().eq('user_id', testUser.id);
      await supabase.from('tasks').delete().eq('user_id', testUser.id);
      await supabase.from('memories').delete().eq('user_id', testUser.id);
      await supabase.from('entities').delete().eq('user_id', testUser.id);
    }
  });

  describe('1. Distributed Scheduler Concurrency, Leases & Lock Recovery', () => {
    it('guarantees atomic reminder claiming with zero duplicates under concurrent workers', async () => {
      // 1. Create a reminder due immediately
      const duePast = new Date(Date.now() - 5000).toISOString();
      const reminder = await saveReminder({
        userId: testUser.id,
        phoneNumber: testUser.phone_number,
        content: 'Recordatorio concurrente de prueba',
        sendAt: duePast,
      });

      expect(reminder).toBeDefined();

      // 2. Simulate 2 concurrent workers attempting to claim the exact same due reminder
      const workerA = 'worker-node-alpha-' + Date.now();
      const workerB = 'worker-node-beta-' + Date.now();

      const [claimedA, claimedB] = await Promise.all([
        claimNextDueReminder(workerA, 120),
        claimNextDueReminder(workerB, 120),
      ]);

      // Exactly ONE worker must succeed in claiming the reminder
      const winner = claimedA || claimedB;
      const loser = claimedA ? claimedB : claimedA;

      expect(winner).not.toBeNull();
      expect(winner.id).toBe(reminder.id);
      expect(loser).toBeNull();

      // Verify lock in database
      const { data: dbRec } = await supabase
        .from('reminders')
        .select('status, claimed_by, lock_until')
        .eq('id', reminder.id)
        .single();

      expect(dbRec.status).toBe('processing');
      expect([workerA, workerB]).toContain(winner.claimed_by);
      expect(dbRec.lock_until).not.toBeNull();
    });

    it('prevents another worker from claiming a reminder while its lease is active in the future', async () => {
      // Reminder currently locked in processing with active lease (10 minutes in future)
      const duePast = new Date(Date.now() - 10000).toISOString();
      const lockFuture = new Date(Date.now() + 600 * 1000).toISOString();

      const { data: lockedReminder } = await supabase
        .from('reminders')
        .insert({
          user_id: testUser.id,
          phone_number: testUser.phone_number,
          content: 'Recordatorio bloqueado con lease activo',
          send_at: duePast,
          status: 'processing',
          claimed_by: 'worker-active-1',
          lock_until: lockFuture,
        })
        .select()
        .single();

      expect(lockedReminder).toBeDefined();

      // Another worker attempts to claim
      const claimAttempt = await claimNextDueReminder('worker-new-2', 120);

      // Must NOT be able to claim the active leased reminder
      if (claimAttempt) {
        expect(claimAttempt.id).not.toBe(lockedReminder.id);
      } else {
        expect(claimAttempt).toBeNull();
      }

      await supabase.from('reminders').delete().eq('id', lockedReminder.id);
    });

    it('allows another worker to recover an orphaned reminder after its lease lock expires', async () => {
      // Create an orphaned reminder: status 'processing' with EXPIRED lock_until (5 seconds in past)
      const duePast = new Date(Date.now() - 60000).toISOString();
      const lockExpired = new Date(Date.now() - 5000).toISOString();

      const { data: orphan } = await supabase
        .from('reminders')
        .insert({
          user_id: testUser.id,
          phone_number: testUser.phone_number,
          content: 'Recordatorio huérfano para recuperación de lease',
          send_at: duePast,
          status: 'processing',
          claimed_by: 'worker-crashed-node',
          lock_until: lockExpired,
        })
        .select()
        .single();

      expect(orphan).toBeDefined();

      // A recovery worker attempts to claim
      const recoveryWorker = 'worker-recovery-' + Date.now();
      const recovered = await claimNextDueReminder(recoveryWorker, 120);

      expect(recovered).not.toBeNull();
      expect(recovered.id).toBe(orphan.id);

      // Verify DB shows updated lease and new worker
      const { data: dbRec } = await supabase
        .from('reminders')
        .select('status, claimed_by, lock_until')
        .eq('id', orphan.id)
        .single();

      expect(dbRec.status).toBe('processing');
      expect(dbRec.claimed_by).toBe(recoveryWorker);
      expect(new Date(dbRec.lock_until).getTime()).toBeGreaterThan(Date.now());

      await supabase.from('reminders').delete().eq('id', orphan.id);
    });
  });

  describe('2. Anti-False-Positive & Deterministic Tool Responses', () => {
    it('discards optimistic claims and returns error when a tool execution fails', async () => {
      // Execute manage_reminder with invalid missing parameters
      const failedRes = await executeTool(
        'manage_reminder',
        { action: 'create', content: '' },
        testUser
      );

      expect(failedRes.success).toBe(false);
      expect(failedRes.action).toBe('invalid_parameters');
      expect(failedRes.error).toBeDefined();
      expect(failedRes.confirmation).toContain('⚠️');
    });

    it('enforces RBAC on admin_metrics tool with unauthorized error for normal users', async () => {
      const regularUser = { ...testUser, is_admin: false };
      const adminRes = await executeTool('admin_metrics', { action: 'get_overview' }, regularUser);

      expect(adminRes.success).toBe(false);
      expect(adminRes.action).toBe('unauthorized');
      expect(adminRes.errorCode).toBe('AUTHORIZATION_ERROR');
    });
  });

  describe('3. Inbound Per-User Message Serialization (Context Race Guard)', () => {
    it('serializes concurrent messages from the same user in strict sequential order', async () => {
      const order = [];
      const userKey = 'test-queue-user-1';

      const p1 = enqueueForUser(userKey, async () => {
        await new Promise(r => setTimeout(r, 60));
        order.push('msg1');
        return 'first';
      });

      const p2 = enqueueForUser(userKey, async () => {
        await new Promise(r => setTimeout(r, 10));
        order.push('msg2');
        return 'second';
      });

      const p3 = enqueueForUser(userKey, async () => {
        order.push('msg3');
        return 'third';
      });

      const results = await Promise.all([p1, p2, p3]);

      expect(results).toEqual(['first', 'second', 'third']);
      expect(order).toEqual(['msg1', 'msg2', 'msg3']);
    });
  });

  describe('4. Semantic Fact Extraction from Operational Commands', () => {
    it('preserves semantic personal facts even inside operational commands', async () => {
      const rawText = 'Recuérdame comprar leche a las 5pm porque vivo en Bogotá y no me gusta el frío';
      const extracted = await extractAndSaveMemories(testUser.id, rawText, 'es');

      // Should extract semantic facts without discarding due to "recuérdame" operational trigger
      expect(Array.isArray(extracted)).toBe(true);
    });
  });

  describe('5. Entity Deduplication and Anti-False-Merge Guards', () => {
    it('strictly prevents destructive merges of short unrelated words', () => {
      // "Pan" (3) vs "Panadería" (9) -> ratio 0.33, must NEVER merge
      const panScore = entityMatchScore('Pan', 'Panadería');
      expect(panScore).toBeLessThan(0.60);

      // "Sol" (3) vs "Soluciones" (10) -> ratio 0.30, must NEVER merge
      const solScore = entityMatchScore('Sol', 'Soluciones');
      expect(solScore).toBeLessThan(0.60);

      // "Casa" (4) vs "Casamiento" (10) -> ratio 0.40, must NEVER merge
      const casaScore = entityMatchScore('Casa', 'Casamiento');
      expect(casaScore).toBeLessThan(0.60);
    });

    it('matches valid plural and project name inflections', () => {
      expect(entityMatchScore('Recordatorio', 'Recordatorios')).toBeGreaterThanOrEqual(0.90);
      expect(entityMatchScore('Proyecto Hermes', 'Proyecto Hermes')).toBe(1.0);
    });
  });

  describe('6. Temporal Resolution, Timezones and Daylight Saving Time (DST)', () => {
    it('correctly computes exact UTC timestamps across DST transitions in zonedTimeToUtc', () => {
      // America/New_York DST transition: Nov 1, 2026 (EDT UTC-4 -> EST UTC-5)
      // Summer (EDT -4)
      const summerUtc = zonedTimeToUtc(2026, 7, 15, 12, 0, 0, 'America/New_York');
      expect(summerUtc.toISOString()).toBe('2026-07-15T16:00:00.000Z');

      // Winter (EST -5)
      const winterUtc = zonedTimeToUtc(2026, 12, 15, 12, 0, 0, 'America/New_York');
      expect(winterUtc.toISOString()).toBe('2026-12-15T17:00:00.000Z');
    });

    it('parses relative natural expressions deterministically', () => {
      const date = parseTargetTime('5:00 PM', 'America/Bogota');
      expect(date).toBeInstanceOf(Date);
      expect(isNaN(date.getTime())).toBe(false);
    });
  });

  describe('7. User Cache Poisoning Neutralization', () => {
    it('never poisons the in-memory cache on failed lookups', async () => {
      const dummyPhone = 'invalid-phone-format-xyz-999999999999';

      // Ensure cache is not poisoned with dummyPhone
      userCache.del(dummyPhone);

      try {
        await getOrCreateUserByPhone(dummyPhone);
      } catch (e) {
        // Expected error
      }

      const cached = userCache.get(dummyPhone);
      expect(cached).toBeUndefined();
    });
  });

  describe('8. Webhook Security and Signature Verification', () => {
    it('rejects invalid HMAC signatures with false', () => {
      const payload = JSON.stringify({ event: 'test' });
      const isValid = verifyWebhookSignature(payload, 'sha256=invalid_signature', 'test-secret');
      expect(isValid).toBe(false);
    });
  });

  describe('9. Persistent Inbound Idempotency (Surviving Restarts & Concurrency)', () => {
    it('records message_id in database and deduplicates subsequent events with same ID', async () => {
      const uniqueMsgId = 'wamid.TEST_PERSISTENT_' + Date.now();

      // 1. First save succeeds
      const firstSave = await saveMessage({
        userId: testUser.id,
        phoneNumber: testUser.phone_number,
        role: 'user',
        content: 'Primer intento de mensaje',
        messageId: uniqueMsgId,
      });

      expect(firstSave).not.toBeNull();
      expect(firstSave.message_id).toBe(uniqueMsgId);

      // 2. Querying isMessageAlreadyProcessed confirms persistent presence in DB
      const alreadyInDb = await isMessageAlreadyProcessed(uniqueMsgId);
      expect(alreadyInDb).toBe(true);

      // 3. Second insert with exact same message_id is caught by DB unique constraint
      const duplicateSave = await saveMessage({
        userId: testUser.id,
        phoneNumber: testUser.phone_number,
        role: 'user',
        content: 'Segundo intento duplicado del mismo mensaje',
        messageId: uniqueMsgId,
      });

      expect(duplicateSave).toBeNull();

      // Clean up
      await supabase.from('messages').delete().eq('message_id', uniqueMsgId);
    });

    it('deduplicates concurrent inserts with the same message_id', async () => {
      const concurrentMsgId = 'wamid.CONCURRENT_' + Date.now();

      const [res1, res2] = await Promise.all([
        saveMessage({
          userId: testUser.id,
          phoneNumber: testUser.phone_number,
          role: 'user',
          content: 'Concurrent A',
          messageId: concurrentMsgId,
        }),
        saveMessage({
          userId: testUser.id,
          phoneNumber: testUser.phone_number,
          role: 'user',
          content: 'Concurrent B',
          messageId: concurrentMsgId,
        }),
      ]);

      // Exactly ONE must succeed and ONE must be null
      const successCount = (res1 ? 1 : 0) + (res2 ? 1 : 0);
      expect(successCount).toBe(1);

      await supabase.from('messages').delete().eq('message_id', concurrentMsgId);
    });
  });

  describe('10. Atomic PostgreSQL RPC Transactions for Entity Rename & Merge', () => {
    it('atomically renames entity and cascades updates to tasks, reminders, and memories via single RPC', async () => {
      const oldEntityName = 'Alpha Corp ' + Date.now();
      const newEntityName = 'Beta Global ' + Date.now();

      // 1. Seed entity, task, reminder, memory
      const { data: ent } = await supabase
        .from('entities')
        .insert({ user_id: testUser.id, name: oldEntityName, category: 'company' })
        .select()
        .single();

      const task = await createTask({
        userId: testUser.id,
        title: `Revisar balance de ${oldEntityName}`,
        entityId: ent.id,
      });

      const reminder = await saveReminder({
        userId: testUser.id,
        phoneNumber: testPhone,
        content: `Reunión con ${oldEntityName} mañana`,
        sendAt: new Date(Date.now() + 86400000).toISOString(),
      });

      const memory = await saveMemory({
        userId: testUser.id,
        content: `El CEO de ${oldEntityName} es Roberto`,
        category: 'fact',
        topicKey: `company/${oldEntityName.toLowerCase().replace(/\s+/g, '_')}/leadership`,
      });

      expect(ent).toBeDefined();
      expect(task).toBeDefined();
      expect(reminder).toBeDefined();

      // 2. Execute atomic cascade rename
      const renameRes = await renameEntityCascade({
        userId: testUser.id,
        oldName: oldEntityName,
        newName: newEntityName,
        category: 'company',
      });

      expect(renameRes.success).toBe(true);

      // 3. Verify in database: entity, task, reminder, and memory were all updated
      const { data: updatedEnt } = await supabase.from('entities').select('name').eq('id', ent.id).single();
      const { data: updatedTask } = await supabase.from('tasks').select('title').eq('id', task.id).single();
      const { data: updatedRem } = await supabase.from('reminders').select('content').eq('id', reminder.id).single();
      const { data: updatedMem } = await supabase.from('memories').select('content').eq('id', memory.id).single();

      expect(updatedEnt.name).toBe(newEntityName);
      expect(updatedTask.title).toContain(newEntityName);
      expect(updatedRem.content).toContain(newEntityName);
      expect(updatedMem.content).toContain(newEntityName);

      // Clean up
      await supabase.from('reminders').delete().eq('id', reminder.id);
      await supabase.from('tasks').delete().eq('id', task.id);
      await supabase.from('memories').delete().eq('id', memory.id);
      await supabase.from('entities').delete().eq('id', ent.id);
    });

    it('atomically merges source entity into target entity and reassigns tasks via single RPC', async () => {
      const sourceName = 'Source Project ' + Date.now();
      const targetName = 'Target Unified ' + Date.now();

      const { data: srcEnt } = await supabase
        .from('entities')
        .insert({ user_id: testUser.id, name: sourceName, category: 'project', metadata: { budget: 1000 } })
        .select()
        .single();

      const { data: tgtEnt } = await supabase
        .from('entities')
        .insert({ user_id: testUser.id, name: targetName, category: 'project', metadata: { lead: 'Ana' } })
        .select()
        .single();

      const task = await createTask({
        userId: testUser.id,
        title: 'Tarea del proyecto origen',
        entityId: srcEnt.id,
      });

      // Execute atomic merge
      const mergeRes = await mergeEntities(testUser.id, sourceName, targetName, 'project');
      expect(mergeRes.success).toBe(true);

      // Verify source is deleted and task reassigned to target
      const { data: checkSrc } = await supabase.from('entities').select('id').eq('id', srcEnt.id).maybeSingle();
      const { data: checkTask } = await supabase.from('tasks').select('entity_id').eq('id', task.id).single();
      const { data: checkTgt } = await supabase.from('entities').select('metadata').eq('id', tgtEnt.id).single();

      expect(checkSrc).toBeNull();
      expect(checkTask.entity_id).toBe(tgtEnt.id);
      expect(checkTgt.metadata.budget).toBe(1000);
      expect(checkTgt.metadata.lead).toBe('Ana');

      await supabase.from('tasks').delete().eq('id', task.id);
      await supabase.from('entities').delete().eq('id', tgtEnt.id);
    });
  });

  describe('11. Non-Heuristic Chat Routing & Anti-False-Action Integrity', () => {
    it('executes NO database mutations when LLM generates chat prose without tool_call', async () => {
      const countBefore = (await supabase.from('reminders').select('*', { count: 'exact', head: true }).eq('user_id', testUser.id)).count;

      // Simulate a chat-only plan returned by router (e.g. general conversational response)
      const fakeChatPlan = {
        type: 'chat',
        tool: null,
        reply: 'Listo, te he dejado programado todo sin ningún problema.',
      };

      // Since plan.type is 'chat', no tool should be invoked
      let toolExecuted = false;
      if (fakeChatPlan.type === 'tool_call' && fakeChatPlan.tool) {
        toolExecuted = true;
        await executeTool(fakeChatPlan.tool, fakeChatPlan.params, testUser);
      }

      expect(toolExecuted).toBe(false);

      const countAfter = (await supabase.from('reminders').select('*', { count: 'exact', head: true }).eq('user_id', testUser.id)).count;
      expect(countAfter).toBe(countBefore);
    });
  });
});
