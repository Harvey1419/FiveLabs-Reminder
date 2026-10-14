import { describe, expect, it, vi } from 'vitest';
import { createSubscriptionPersistence, type SubscriptionQuery, type SubscriptionRow, type SubscriptionPersistenceClient, type SubscriptionQueryResult } from '../../../src/infrastructure/database/subscription-persistence.js';
import { createSubscriptionPolicy } from '../../../src/infrastructure/database/subscription-policy.js';
const NOW = Date.parse('2026-10-13T12:00:00Z');
const row = { id: 'subscription-id', user_id: 'owner', mp_preapproval_id: 'mp-id', plan: 'pro', status: 'authorized' };
function fixture(results: (SubscriptionQueryResult<SubscriptionRow> | Error)[] = []) {
  const queue = results.slice();
  const result = vi.fn(async () => { const next = queue.shift(); if (next instanceof Error) throw next; return next || { data: null, error: null }; });
  const query: SubscriptionQuery<SubscriptionRow> = { select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query), limit: vi.fn(() => query), insert: vi.fn(() => query), update: vi.fn(() => query), maybeSingle: result, single: result };
  const client: SubscriptionPersistenceClient = { from: vi.fn(() => query) };
  const deps = { getClient: vi.fn(() => client), cancelSubscription: vi.fn(async () => ({})), now: () => new Date(NOW), logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  return { query, deps, client, ...createSubscriptionPersistence(deps) };
}
describe('typed subscription access policy', () => {
  it('preserves active grace and paid-period expiry boundaries with no persistence dependency', () => {
    const policy = createSubscriptionPolicy({ now: () => NOW, getEnvironment: () => ({}) });
    expect(policy.hasProAccess({ plan: 'pro', status: 'active', next_payment_date: NOW - 172800000 })).toBe(false);
    expect(policy.hasProAccess({ plan: 'pro', status: 'active', next_payment_date: NOW - 172799999 })).toBe(true);
    expect(policy.hasProAccess({ plan: 'pro', status: 'cancelled', next_payment_date: NOW })).toBe(false);
    expect(policy.hasProAccess({ plan: 'pro', status: 'paused', next_payment_date: NOW + 1 })).toBe(true);
    expect(policy.hasProAccess({ plan: 'pro', status: 'authorized', next_payment_date: 'invalid' })).toBe(false);
    expect(policy.hasProAccess(null, { is_admin: true })).toBe(true); expect(policy.hasProAccess({ plan: 'free' })).toBe(false);
  });
  it('keeps experimental gates live and literal while admins remain exempt', () => {
    const env = { ENFORCE_BILLING: 'false' }; const policy = createSubscriptionPolicy({ now: () => NOW, getEnvironment: () => env });
    expect(policy.shouldEnforceBillingForUser({ phone_number: '15550001111' })).toBe(false);
    env.ENFORCE_BILLING = 'true'; expect(policy.shouldEnforceBillingForUser({ phone_number: '15550001111' })).toBe(true);
    expect(policy.shouldEnforceBillingForUser({ is_admin: true })).toBe(false); env.ENFORCE_BILLING = 'TRUE'; expect(policy.shouldEnforceBillingForUser({ phone_number: '15550001111' })).toBe(false);
  });
});
describe('typed subscription persistence boundaries', () => {
  it('retains lazy client access, user filter and bounded latest-row lookup', async () => {
    const f = fixture([{ data: row, error: null }]); expect(f.deps.getClient).not.toHaveBeenCalled(); expect(await f.getUserSubscription(null)).toBeNull(); expect(f.deps.getClient).not.toHaveBeenCalled();
    expect(await f.getUserSubscription('owner')).toBe(row); expect(f.client.from).toHaveBeenCalledWith('subscriptions'); expect(f.query.eq).toHaveBeenCalledWith('user_id', 'owner'); expect(f.query.order).toHaveBeenCalledWith('created_at', { ascending: false }); expect(f.query.limit).toHaveBeenCalledWith(1);
  });
  it('keeps no-row, storage-error and thrown-read fallbacks distinct from write exceptions', async () => {
    const f = fixture([{ data: null, error: { code: 'PGRST116' } }, { data: null, error: { code: 'FAILED', message: 'read failed' } }, new Error('transport failed')]);
    expect(await f.getUserSubscription('owner')).toBeNull(); expect(f.deps.logger.error).not.toHaveBeenCalled();
    expect(await f.getUserSubscription('owner')).toBeNull(); expect(await f.getUserSubscription('owner')).toBeNull(); expect(f.deps.logger.error).toHaveBeenCalledTimes(2);
  });
  it('resolves provider ID then linked user without broadening either predicate', async () => {
    const user = { id: 'owner', display_name: 'Owner' }; const f = fixture([{ data: row, error: null }, { data: user, error: null }]);
    expect(await f.getSubscriptionByMpId('mp-id')).toEqual({ subscription: row, user }); expect(f.query.eq).toHaveBeenNthCalledWith(1, 'mp_preapproval_id', 'mp-id'); expect(f.query.eq).toHaveBeenNthCalledWith(2, 'id', 'owner');
  });
  it('inserts the original pending payload and propagates the same storage error object', async () => {
    const error = { code: 'WRITE_FAILED', message: 'insert failed' }; const f = fixture([{ data: null, error }]);
    await expect(f.createPendingSubscription('owner', { mpPreapprovalId: 'mp-id', amount: 0 })).rejects.toBe(error);
    expect(f.query.insert).toHaveBeenCalledWith({ user_id: 'owner', mp_preapproval_id: 'mp-id', plan: 'pro', status: 'pending', amount: 0, updated_at: new Date(NOW).toISOString() });
  });
  it('preserves direct webhook matching then fallback plan matching with shared update data', async () => {
    const f = fixture([{ data: null, error: { message: 'first lookup' } }, { data: row, error: null }]);
    expect(await f.updateSubscriptionFromWebhook({ mpPreapprovalId: 'mp-id', preapprovalPlanId: 'plan-id', status: 'authorized', nextPaymentDate: null })).toBe(row);
    expect(f.query.eq).toHaveBeenNthCalledWith(1, 'mp_preapproval_id', 'mp-id'); expect(f.query.eq).toHaveBeenNthCalledWith(2, 'mp_preapproval_id', 'plan-id');
    const payload = vi.mocked(f.query.update).mock.calls[0]![0]; expect(vi.mocked(f.query.update).mock.calls[1]![0]).toBe(payload); expect(payload).not.toHaveProperty('next_payment_date');
  });
  it('preserves cancellation timestamps and performs no webhook query without either identifier', async () => {
    const f = fixture([{ data: row, error: null }]); expect(await f.updateSubscriptionFromWebhook({ status: 'cancelled' })).toBeNull(); expect(f.client.from).not.toHaveBeenCalled();
    await f.updateSubscriptionFromWebhook({ mpPreapprovalId: 'mp-id', status: 'cancelled' }); expect(f.query.update).toHaveBeenCalledWith(expect.objectContaining({ canceled_at: new Date(NOW).toISOString() }));
  });
  it('does not remotely cancel or update already-cancelled, absent or missing-user subscriptions', async () => {
    const cancelled = { ...row, status: 'cancelled' }; const f = fixture([{ data: cancelled, error: null }, { data: null, error: null }]);
    expect(await f.cancelUserSubscription(null)).toEqual({ success: false, error: 'User ID is required' }); expect(await f.cancelUserSubscription('owner')).toEqual({ success: true, subscription: cancelled, alreadyCancelled: true });
    expect(await f.cancelUserSubscription('owner')).toEqual({ success: false, error: 'No subscription found for user' }); expect(f.deps.cancelSubscription).not.toHaveBeenCalled(); expect(f.query.update).not.toHaveBeenCalled();
  });
  it('never updates local cancellation after an unconfirmed remote attempt', async () => {
    const f = fixture([{ data: row, error: null }]); const error = Error('remote failed'); vi.mocked(f.deps.cancelSubscription).mockRejectedValue(error);
    await expect(f.cancelUserSubscription('owner')).rejects.toBe(error); expect(f.deps.cancelSubscription).toHaveBeenCalledTimes(1); expect(f.query.update).not.toHaveBeenCalled();
  });
  it('propagates local cancellation failure after a remote attempt without replay', async () => {
    const error = { message: 'local failed' }; const f = fixture([{ data: row, error: null }, { data: null, error }]); await expect(f.cancelUserSubscription('owner')).rejects.toBe(error); expect(f.deps.cancelSubscription).toHaveBeenCalledTimes(1); expect(f.query.update).toHaveBeenCalledTimes(1);
  });

});
