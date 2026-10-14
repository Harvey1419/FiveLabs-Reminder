import { describe,expect,it,vi } from 'vitest';
import type { DomainPersistenceQuery,DomainStorageError } from '../../../src/infrastructure/database/domain-persistence-client.js';
import type { UserProfileRow,IntegrationQuery,IntegrationRow } from '../../../src/infrastructure/database/profile-integration-client.js';
import { createUserProfilePersistence } from '../../../src/infrastructure/database/user-profile-persistence.js';
import { createIntegrationPersistence } from '../../../src/infrastructure/database/integration-persistence.js';
function profile() {
  let row: UserProfileRow | null = { id: 'owner',phone_number: '573001234567',timezone: 'America/Bogota',locale: 'es-CO' };
  let error: DomainStorageError | null = null;
  const query: DomainPersistenceQuery<UserProfileRow> = { select: vi.fn(() => query),insert: vi.fn(() => query),upsert: vi.fn(() => query),update: vi.fn(() => query),delete: vi.fn(() => query),
    eq: vi.fn(() => query),in: vi.fn(() => query),or: vi.fn(() => query),is: vi.fn(() => query),ilike: vi.fn(() => query),lte: vi.fn(() => query),limit: vi.fn(() => query),order: vi.fn(() => query),
    single: vi.fn(async () => ({ data: row,error })),maybeSingle: vi.fn(async () => ({ data: row,error })),then: (resolve,reject) => Promise.resolve({ data: row ? [row] : [],error }).then(resolve,reject) };
  const getClient = vi.fn(() => ({ from: vi.fn(() => query) }));
  const store = createUserProfilePersistence(getClient,{ detectTimezoneFromPhone: () => 'America/Bogota',detectLocaleFromPhone: () => 'es-CO' });
  return { store,query,getClient,set: (value: UserProfileRow | null) => { row = value; },fail: () => { row = null;error = { message: 'Unavailable' }; } };
}
function integration() {
  const row: IntegrationRow = { id: 'integration',user_id: 'owner',provider: 'google',access_token: 'fixture-only',metadata: { channelId: 'owned',keep: true } };
  const query: IntegrationQuery = { select: vi.fn(() => query),insert: vi.fn(() => query),upsert: vi.fn(() => query),update: vi.fn(() => query),delete: vi.fn(() => query),
    eq: vi.fn(() => query),not: vi.fn(() => query),in: vi.fn(() => query),or: vi.fn(() => query),is: vi.fn(() => query),ilike: vi.fn(() => query),lte: vi.fn(() => query),limit: vi.fn(() => query),order: vi.fn(() => query),
    single: vi.fn(async () => ({ data: row,error: null })),maybeSingle: vi.fn(async () => ({ data: row,error: null })),then: (resolve,reject) => Promise.resolve({ data: [row],error: null }).then(resolve,reject) };
  const getClient = vi.fn(() => ({ from: vi.fn(() => query) }));return { store: createIntegrationPersistence(getClient),query,getClient,row };
}
describe('typed profile/integration persistence',() => {
  it('keeps both shared client constructors lazy',() => { const p=profile(),i=integration();expect(p.getClient).not.toHaveBeenCalled();expect(i.getClient).not.toHaveBeenCalled(); });
  it('normalizes phone numbers while preserving BSUID identity',() => { const f=profile();expect(f.store.normalizeUserPhone(' +57 300-123-4567 ')).toBe('573001234567');expect(f.store.normalizeUserPhone(' CO.1552339023039755 ')).toBe('CO.1552339023039755'); });
  it('uses a persisted cached profile until a foreground fresh read requests new state',async () => {
    const f=profile();await f.store.getOrCreateUserByPhone('573001234567');f.set({ id:'owner',phone_number:'573001234567',timezone:'America/Los_Angeles',locale:'en-US' });
    expect((await f.store.getOrCreateUserByPhone('573001234567')).timezone).toBe('America/Bogota');
    expect((await f.store.getOrCreateUserByPhone('573001234567',null,'es-CO',null,{fresh:true})).timezone).toBe('America/Los_Angeles');
  });
  it('keeps the Map delete alias bound and isolates constructed stores',async () => {
    const f=profile(),g=profile();await f.store.getOrCreateUserByPhone('573001234567');expect(g.store.userCache.size).toBe(0);
    const del=f.store.userCache.del;expect(del('573001234567')).toBe(true);expect(f.store.userCache.size).toBe(0);
  });
  it('an unpersisted fallback never becomes a cached authenticated profile',async () => {
    const f=profile();f.fail();expect(await f.store.getOrCreateUserByPhone('573001234567')).toMatchObject({id:null});expect(f.store.userCache.size).toBe(0);
  });
  it('preferences write by exact ID and refresh the matching cached profile',async () => {
    const f=profile();f.set({id:'owner',phone_number:'573001234567',timezone:'America/Lima',locale:'es-PE'});
    await f.store.updateUserPreferences('owner',{timezone:'America/Lima',locale:'es-PE'});expect(f.query.eq).toHaveBeenCalledWith('id','owner');expect(f.store.userCache.get('573001234567')?.user.locale).toBe('es-PE');
  });
  it('updates the local WhatsApp window immediately using the normalized phone',async () => {
    const f=profile();await f.store.touchUserLastActive('owner','+57 300 123 4567');expect(f.store.userCache.get('573001234567')?.user.last_user_message_at).toBeTruthy();expect(f.query.eq).toHaveBeenCalledWith('id','owner');
  });
  it('never removes a refresh token by omission on reauthorization',async () => {
    const f=integration();await f.store.saveUserIntegration('owner',{accessToken:'new-fixture',tokenExpiry:new Date('2026-10-14T12:00:00Z')});
    const payload=vi.mocked(f.query.upsert).mock.calls[0]?.[0];expect(payload).toMatchObject({user_id:'owner',provider:'google',access_token:'new-fixture',token_expiry:'2026-10-14T12:00:00.000Z'});expect(payload).not.toHaveProperty('refresh_token');
  });
  it('persists a supplied refresh token and binds its conflict identity',async () => {
    const f=integration();await f.store.saveUserIntegration('owner',{accessToken:'new-fixture',refreshToken:'refresh-fixture'});expect(f.query.upsert).toHaveBeenCalledWith(expect.objectContaining({refresh_token:'refresh-fixture'}),{onConflict:'user_id,provider'});
  });
  it('owner/provider predicates survive metadata updates and disconnects',async () => {
    const f=integration();await f.store.updateUserIntegrationMetadata('owner','google',{channelId:'next'});expect(f.query.update).toHaveBeenCalledWith(expect.objectContaining({metadata:{channelId:'next',keep:true}}));
    expect(await f.store.deleteUserIntegration('owner','google')).toBe(true);expect(f.query.eq).toHaveBeenCalledWith('user_id','owner');expect(f.query.eq).toHaveBeenCalledWith('provider','google');
  });
  it('channel lookup retains provider scope and active scanning excludes missing refresh tokens',async () => {
    const f=integration();expect((await f.store.getUserIntegrationByChannelId('owned','google'))?.id).toBe('integration');expect(await f.store.getUserIntegrationByChannelId('foreign','google')).toBeNull();
    await f.store.getAllActiveIntegrations('google');expect(f.query.not).toHaveBeenCalledWith('refresh_token','is',null);
  });
});
