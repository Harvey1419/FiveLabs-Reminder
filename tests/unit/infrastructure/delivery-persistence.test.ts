import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => db) }));
import { updateReminderDeliveryStatus } from '../../../src/infrastructure/database/index.js';
import { getAssistantMessageById } from '../../../src/infrastructure/database/messages.js';
type Result = { data: null | { id: string }; error: null | { message: string } };
function makeQuery() { return { update: vi.fn(), select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn<() => Promise<Result>>().mockResolvedValue({ data: null, error: null }) }; }
let query: ReturnType<typeof makeQuery>;
beforeEach(() => {
  vi.clearAllMocks();
  query = makeQuery();
  for (const key of ['update', 'select', 'eq'] as const) query[key].mockReturnValue(query);
  vi.mocked(db.from, { partial: true }).mockReturnValue(query);
});
describe('delivery correlation persistence', () => {
  it('returns null only for an unmatched reminder, not a database error', async () => {
    expect(await updateReminderDeliveryStatus({ deliveryId: 'wamid.R', deliveryStatus: 'delivered' })).toBeNull();
    expect(query.eq).toHaveBeenCalledWith('delivery_id', 'wamid.R');
    vi.mocked(query.maybeSingle, { partial: true }).mockResolvedValueOnce({ data: null, error: { message: 'storage failed' } });
    await expect(updateReminderDeliveryStatus({ deliveryId: 'wamid.R', deliveryStatus: 'read' })).rejects.toMatchObject({ message: 'storage failed' });
  });
  it('correlates only assistant messages and does not fetch private content', async () => {
    vi.mocked(query.maybeSingle, { partial: true }).mockResolvedValueOnce({ data: { id: 'message-row' }, error: null });
    expect(await getAssistantMessageById('wamid.C')).toEqual({ id: 'message-row' });
    expect(db.from).toHaveBeenCalledWith('messages');
    expect(query.select).toHaveBeenCalledWith('id');
    expect(query.eq).toHaveBeenCalledWith('role', 'assistant');
    expect(query.eq).toHaveBeenCalledWith('message_id', 'wamid.C');
  });
  it('does not disguise a failed message lookup as an unmatched id', async () => {
    vi.mocked(query.maybeSingle, { partial: true }).mockResolvedValueOnce({ data: null, error: { message: 'read failed' } });
    await expect(getAssistantMessageById('wamid.C')).rejects.toMatchObject({ message: 'read failed' });
  });
});
