import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createService } from '../src/service.mjs';
import { ENDPOINTS } from '../src/client.mjs';

async function setup(t, fetchImpl) {
  const home = await mkdtemp(join(tmpdir(), 'wikivibe-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stores = { secrets: new Map(), storage: new Map() };
  const host = { async call(method, { key, value }) {
    const [name, action] = method.split('.');
    if (action === 'get') return { value: stores[name].get(key) ?? null };
    if (action === 'set') stores[name].set(key, value);
    if (action === 'delete') stores[name].delete(key);
    return { ok: true };
  } };
  return { service: createService(host, { home, fetchImpl }), stores, home };
}

async function configFile(home, rel, value) {
  const path = join(home, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}

const response = ids => Response.json({ data: ids.map(id => ({ id })) });

test('connect rotates only opted-in agents, preserves edits, isolates failures and reports saved separately', async t => {
  const { service, stores, home } = await setup(t, async () => response(['allowed']));
  const untouched = await configFile(home, '.qwen/settings.json', { env: { WIKIVIBE_API_KEY: 'user-owned' } });
  const before = await readFile(untouched, 'utf8');
  await service.request('connect', { apiKey: 'old-fixture', baseUrl: ENDPOINTS[0] });
  await service.request('apply', { agentIds: ['opencode', 'pi', 'codex'], confirmed: true });
  const file = join(home, '.config/opencode/opencode.json');
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.model = 'other/custom';
  config.provider.wikivibe.options.timeout = 123;
  await writeFile(file, JSON.stringify(config));
  const blocked = join(home, '.codex/wikivibe-models.json');
  await writeFile(blocked, '{"models":[],"user":"keep"}');
  const result = await service.request('connect', { apiKey: 'new-fixture', baseUrl: ENDPOINTS[1] });
  const updated = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(updated.provider.wikivibe.options.apiKey, 'new-fixture');
  assert.equal(updated.provider.wikivibe.options.baseURL, ENDPOINTS[1]);
  assert.equal(updated.provider.wikivibe.options.timeout, 123);
  assert.equal(updated.model, 'other/custom');
  assert.equal(JSON.parse(await readFile(join(home, '.pi/agent/models.json'), 'utf8')).providers.wikivibe.apiKey, 'new-fixture');
  assert.equal(stores.secrets.get('apiKey'), 'new-fixture');
  assert.equal(result.saved, true);
  assert.deepEqual(result.sync.failures.map(item => item.agentId), ['codex']);
  assert.deepEqual(result.sync.outcomes.map(item => item.agentId), ['opencode', 'pi']);
  assert.equal(await readFile(untouched, 'utf8'), before);
  assert.equal(await readFile(blocked, 'utf8'), '{"models":[],"user":"keep"}');
  assert.equal(JSON.stringify(result).includes('new-fixture'), false);
  // A later sync must not regenerate away edits, and restore must not discard them.
  await service.request('preferences', { baseUrl: ENDPOINTS[0] });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).model, 'other/custom');
  const restore = await service.request('restore', { agentIds: ['opencode'], confirmed: true });
  assert.equal(restore.failures.length, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).model, 'other/custom');
});

test('failed connect leaves managed agent credentials unchanged', async t => {
  let denied = false;
  const { service, home } = await setup(t, async () => denied ? new Response('', { status: 401 }) : response(['allowed']));
  await service.request('connect', { apiKey: 'old-fixture', baseUrl: ENDPOINTS[0] });
  await service.request('apply', { agentIds: ['opencode'], confirmed: true });
  const file = join(home, '.config/opencode/opencode.json');
  const before = await readFile(file, 'utf8');
  denied = true;
  await assert.rejects(service.request('connect', { apiKey: 'new-fixture', baseUrl: ENDPOINTS[1] }));
  assert.equal(await readFile(file, 'utf8'), before);
});

test('invalid backup marker cannot enroll an unmanaged config during connect', async t => {
  const { service, home } = await setup(t, async () => response(['allowed']));
  const marker = join(home, '.config/opencode/.wikivibe-gateway-backups/opencode.jsonc.json');
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, '{}', { mode: 0o600 });
  const result = await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  assert.equal(result.saved, true);
  assert.deepEqual(result.sync.failures.map(item => item.agentId), ['opencode']);
  await assert.rejects(readFile(join(home, '.config/opencode/opencode.json')), { code: 'ENOENT' });
});

test('connect uses only the authenticated accessible roster and persists the endpoint alone', async t => {
  const calls = [];
  const { service, stores } = await setup(t, async (url, options) => {
    calls.push({ url, authorization: options.headers.Authorization });
    assert.equal(url, `${ENDPOINTS[0]}/models`);
    return response(['group-b', 'group-a', 'group-b']);
  });
  stores.storage.set('preferences', { baseUrl: ENDPOINTS[0], model: 'old-selection' });
  const state = await service.request('connect', { apiKey: 'fixture-key', baseUrl: ENDPOINTS[0], model: 'group-a' });
  assert.deepEqual(calls, [{ url: `${ENDPOINTS[0]}/models`, authorization: 'Bearer fixture-key' }]);
  assert.deepEqual(state.models, [{ id: 'group-a' }, { id: 'group-b' }]);
  assert.deepEqual(Object.keys(state).sort(), ['agents', 'baseUrl', 'connected', 'models', 'registrationUrl', 'saved', 'sync']);
  assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[0] });
  assert.equal(stores.secrets.get('apiKey'), 'fixture-key');
  assert.equal(JSON.stringify(state).includes('fixture-key'), false);
});

test('failed new credential validation preserves old vault and preferences', async t => {
  let reject = false;
  const { service, stores } = await setup(t, async () => reject ? new Response('', { status: 401 }) : response(['a']));
  await service.request('connect', { apiKey: 'old-fixture', baseUrl: ENDPOINTS[0] });
  reject = true;
  await assert.rejects(service.request('connect', { apiKey: 'new-fixture', baseUrl: ENDPOINTS[1] }), error => error.code === 'api_auth');
  assert.equal(stores.secrets.get('apiKey'), 'old-fixture');
  assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[0] });
  assert.deepEqual((await service.request('state')).models, [{ id: 'a' }]);
});

test('model refresh for another endpoint does not contaminate saved state', async t => {
  const { service, stores } = await setup(t, async url => response([url.startsWith(ENDPOINTS[0]) ? 'a' : 'b']));
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  assert.deepEqual((await service.request('models', { baseUrl: ENDPOINTS[1] })).models, [{ id: 'b' }]);
  const state = await service.request('state');
  assert.equal(state.baseUrl, ENDPOINTS[0]);
  assert.deepEqual(state.models, []);
  assert.equal(Object.hasOwn(state, 'model'), false);
  assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[0] });
  await assert.rejects(service.request('apply', { agentIds: ['opencode'], confirmed: false }));
});

test('preferences revalidates authenticated access before saving only the endpoint', async t => {
  let denied = false;
  const calls = [];
  const { service, stores } = await setup(t, async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    return denied ? new Response('', { status: 403 }) : response(['allowed']);
  });
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  denied = true;
  await assert.rejects(service.request('preferences', { baseUrl: ENDPOINTS[1] }), error => error.code === 'api_auth');
  assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[0] });
  denied = false;
  const state = await service.request('preferences', { baseUrl: ENDPOINTS[1], model: 'ignored-old-selection' });
  assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[1] });
  assert.deepEqual(state.models, [{ id: 'allowed' }]);
  assert.equal(Object.hasOwn(state, 'model'), false);
  assert.deepEqual(calls, [`${ENDPOINTS[0]}/models`, `${ENDPOINTS[1]}/models`, `${ENDPOINTS[1]}/models`]);
});

test('preview refreshes authenticated roster without choosing a model or changing files', async t => {
  let roster = ['old'];
  let calls = 0;
  const { service, home } = await setup(t, async url => {
    assert.equal(url, `${ENDPOINTS[0]}/models`);
    calls++;
    return response(roster);
  });
  const path = await configFile(home, '.config/opencode/opencode.json', { model: 'other/active' });
  const before = await readFile(path, 'utf8');
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  roster = ['new-a', 'new-b'];
  const preview = await service.request('preview', { agentIds: ['opencode'] });
  assert.deepEqual(preview.models, [{ id: 'new-a' }, { id: 'new-b' }]);
  assert.equal(preview.changes.length, 1);
  assert.equal(calls, 2);
  assert.deepEqual((await service.request('state')).models, preview.models);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('apply replaces implicit OpenCode auth routing with the saved key and its authenticated catalog', async t => {
  const { service, home } = await setup(t, async () => response(['permitted-for-plugin-key']));
  const file = await configFile(home, '.config/opencode/opencode.json', {
    provider: { wikiwibe: { options: { baseURL: ENDPOINTS[0] }, models: { permitted: {} } } }
  });
  const before = await readFile(file, 'utf8');
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  const preview = await service.request('preview', { agentIds: ['opencode'] });
  assert.equal(JSON.stringify(preview).includes('fixture'), false);
  assert.equal(await readFile(file, 'utf8'), before);
  await service.request('apply', { agentIds: ['opencode'], confirmed: true });
  const changed = JSON.parse(await readFile(file, 'utf8')).provider.wikiwibe;
  assert.equal(changed.options.apiKey, 'fixture');
  assert.deepEqual(Object.keys(changed.models), ['permitted-for-plugin-key']);
});

test('apply refreshes revoked and newly available models and preserves active selections and defaults', async t => {
  let roster = ['revoked', 'retained'];
  let calls = 0;
  const { service, home, stores } = await setup(t, async (url, options) => {
    assert.equal(url, `${ENDPOINTS[0]}/models`);
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    calls++;
    return response(roster);
  });
  const opencode = await configFile(home, '.config/opencode/opencode.json', { model: 'other/active', provider: { other: { name: 'Other' } } });
  const piSettings = await configFile(home, '.pi/agent/settings.json', { defaultProvider: 'other', defaultModel: 'active', enabledModels: ['other/active'] });
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  await service.request('apply', { agentIds: ['opencode', 'pi'], confirmed: true });
  roster = ['retained', 'new-b', 'new-a'];
  const preview = await service.request('preview', { agentIds: ['opencode', 'pi'] });
  assert.deepEqual(preview.models, [{ id: 'new-a' }, { id: 'new-b' }, { id: 'retained' }]);
  roster = ['new-c', 'retained'];
  const result = await service.request('apply', { agentIds: ['opencode', 'pi'], confirmed: true });
  const expected = [{ id: 'new-c' }, { id: 'retained' }];
  assert.deepEqual(result.models, expected);
  assert.deepEqual((await service.request('state')).models, expected);
  assert.equal(calls, 4);
  const openConfig = JSON.parse(await readFile(opencode, 'utf8'));
  assert.deepEqual(Object.keys(openConfig.provider.wikivibe.models).sort(), ['new-c', 'retained']);
  assert.equal(openConfig.model, 'other/active');
  assert.deepEqual(openConfig.provider.other, { name: 'Other' });
  const piConfig = JSON.parse(await readFile(join(home, '.pi/agent/models.json'), 'utf8'));
  assert.deepEqual(piConfig.providers.wikivibe.models.map(model => model.id), ['new-c', 'retained']);
  assert.deepEqual(JSON.parse(await readFile(piSettings, 'utf8')), { defaultProvider: 'other', defaultModel: 'active', enabledModels: ['other/active', 'wikivibe/new-c', 'wikivibe/retained'] });
  assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[0] });
});

test('empty authenticated roster cannot save credentials or preferences or preview or apply', async t => {
  let roster = [];
  const { service, stores, home } = await setup(t, async () => response(roster));
  await assert.rejects(service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] }), error => error.code === 'api_catalog');
  assert.equal(stores.secrets.size, 0);
  assert.equal(stores.storage.size, 0);
  roster = ['a'];
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  const path = await configFile(home, '.config/opencode/opencode.json', { model: 'other/active' });
  const before = await readFile(path, 'utf8');
  roster = [];
  await assert.rejects(service.request('preferences', { baseUrl: ENDPOINTS[1] }), error => error.code === 'api_catalog');
  await assert.rejects(service.request('preview', { agentIds: ['opencode'] }), error => error.code === 'api_catalog');
  await assert.rejects(service.request('apply', { agentIds: ['opencode'], confirmed: true }), error => error.code === 'api_catalog');
  assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[0] });
  assert.equal(await readFile(path, 'utf8'), before);
});

test('revoked authentication blocks apply even after a successful preview', async t => {
  let revoked = false;
  const { service, home } = await setup(t, async () => revoked ? new Response('', { status: 401 }) : response(['a', 'b']));
  const path = await configFile(home, '.config/opencode/opencode.json', { model: 'other/active' });
  const before = await readFile(path, 'utf8');
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  await service.request('preview', { agentIds: ['opencode'] });
  revoked = true;
  await assert.rejects(service.request('apply', { agentIds: ['opencode'], confirmed: true }), error => error.code === 'api_auth');
  assert.equal(await readFile(path, 'utf8'), before);
});

test('restore reports user edits made after provider application and leaves the file untouched', async t => {
  const { service, home } = await setup(t, async () => response(['a']));
  const path = await configFile(home, '.config/opencode/opencode.json', { model: 'other/active' });
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  await service.request('apply', { agentIds: ['opencode'], confirmed: true });
  const edited = (await readFile(path, 'utf8')) + '\n';
  await writeFile(path, edited);
  const result = await service.request('restore', { agentIds: ['opencode'], confirmed: true });
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.failures.map(item => item.agentId), ['opencode']);
  assert.match(result.failures[0].message, /конфликт/i);
  assert.equal(await readFile(path, 'utf8'), edited);
});

test('disconnect clears credential and roster but backup restoration still works without a key', async t => {
  let calls = 0;
  const { service, stores, home } = await setup(t, async () => { calls++; return response(['a', 'b']); });
  const path = await configFile(home, '.config/opencode/opencode.json', { model: 'other/active' });
  const before = await readFile(path, 'utf8');
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  await service.request('apply', { agentIds: ['opencode'], confirmed: true });
  const applied = await readFile(path, 'utf8');
  const state = await service.request('disconnect');
  assert.equal(state.connected, false);
  assert.deepEqual(state.models, []);
  assert.equal(stores.secrets.size, 0);
  assert.equal(await readFile(path, 'utf8'), applied);
  await assert.rejects(service.request('preview', { agentIds: ['opencode'] }));
  await assert.rejects(service.request('restore', { agentIds: ['opencode'], confirmed: false }));
  await service.request('restore', { agentIds: ['opencode'], confirmed: true });
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(calls, 2);
});

test('accepted key with denied vault permission reports storage failure without the key', async t => {
  const home = await mkdtemp(join(tmpdir(), 'wikivibe-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let validated = false;
  const service = createService({ async call(method) {
    if (method === 'secrets.set') throw new Error('secret-fixture');
    throw new Error('unexpected host call');
  } }, { home, fetchImpl: async url => {
    assert.equal(url, `${ENDPOINTS[0]}/models`);
    validated = true;
    return response(['model']);
  } });
  await assert.rejects(service.request('connect', { apiKey: 'secret-fixture', baseUrl: ENDPOINTS[0] }), error => error.code === 'storage' && !error.message.includes('secret-fixture'));
  assert.equal(validated, true);
});

test('account requests use only the stored endpoint and credential and return a safe timestamped snapshot', async t => {
  const calls = [];
  const { service, stores } = await setup(t, async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer stored-fixture');
    return Response.json({
      status: 'active', isValid: true, balance: 0,
      billing: { source: 'balance', mode: 'auto', available: true, unit: 'USD', remaining: 0, plan_name: 'stored-fixture' },
      usage: { rpm: 0, today: { actual_cost: 0, requests: 0 } },
      capturedAt: 'stored-fixture', apiKey: 'stored-fixture', message: 'stored-fixture'
    });
  });
  stores.secrets.set('apiKey', 'stored-fixture');
  stores.storage.set('preferences', { baseUrl: ENDPOINTS[1] });
  const before = Date.now();
  const account = await service.request('account', { baseUrl: 'https://attacker.invalid/v1', apiKey: 'body-fixture' });
  assert.deepEqual(calls, [`${ENDPOINTS[1]}/usage?days=7`]);
  assert.equal(account.status, 'active');
  assert.equal(account.balance, 0);
  assert.equal(account.billing.remaining, 0);
  assert.equal(account.billing.balance, null);
  assert.equal(account.usage.today.actual_cost, 0);
  assert.equal(account.usage.today.cost, null);
  assert.equal(account.usage.total, null);
  const capturedAt = Date.parse(account.capturedAt);
  assert.ok(capturedAt >= before && capturedAt <= Date.now());
  assert.equal(new Date(capturedAt).toISOString(), account.capturedAt);
  assert.equal(JSON.stringify(account).includes('stored-fixture'), false);
  assert.equal(JSON.stringify(account).includes('body-fixture'), false);
  assert.equal(stores.secrets.get('apiKey'), 'stored-fixture');
  assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[1] });
});

test('optional account auth failures never undo connection, roster or stored preferences', async t => {
  let accountStatus = 401;
  const calls = [];
  const { service, stores } = await setup(t, async url => {
    calls.push(url);
    if (url.endsWith('/models')) return response(['accessible']);
    return new Response('secret-fixture', { status: accountStatus });
  });
  const connected = await service.request('connect', { baseUrl: ENDPOINTS[0], apiKey: 'secret-fixture' });
  assert.equal(connected.connected, true);
  assert.deepEqual(calls, [`${ENDPOINTS[0]}/models`]);
  for (accountStatus of [401, 403]) {
    await assert.rejects(service.request('account'), error => error.code === 'api_auth' && !error.message.includes('secret-fixture'));
    const state = await service.request('state');
    assert.equal(state.connected, true);
    assert.deepEqual(state.models, [{ id: 'accessible' }]);
    assert.equal(stores.secrets.get('apiKey'), 'secret-fixture');
    assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[0] });
  }
  assert.deepEqual((await service.request('models')).models, [{ id: 'accessible' }]);
});

test('account snapshots refresh without stale state and failed requests leave the service usable', async t => {
  let balance = 5;
  let malformed = false;
  const { service } = await setup(t, async url => {
    if (url.endsWith('/models')) return response(['a']);
    return malformed ? Response.json({ error: 'secret-fixture' }) : Response.json({ balance });
  });
  await service.request('connect', { baseUrl: ENDPOINTS[0], apiKey: 'secret-fixture' });
  assert.equal((await service.request('account')).balance, 5);
  malformed = true;
  await assert.rejects(service.request('account'), error => error.code === 'api_account' && !error.message.includes('secret-fixture'));
  malformed = false;
  balance = 0;
  assert.equal((await service.request('account')).balance, 0);
  assert.equal((await service.request('state')).connected, true);
});

test('account never fetches without a stored key, including after disconnect', async t => {
  let calls = 0;
  const { service } = await setup(t, async () => { calls++; return response(['a']); });
  await assert.rejects(service.request('account', { apiKey: 'body-fixture' }), /Сначала проверьте/);
  assert.equal(calls, 0);
  await service.request('connect', { baseUrl: ENDPOINTS[0], apiKey: 'fixture' });
  await service.request('disconnect');
  await assert.rejects(service.request('account'), /Сначала проверьте/);
  assert.equal(calls, 1);
});
