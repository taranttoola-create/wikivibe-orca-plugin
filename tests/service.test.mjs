import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  return { service: createService(host, { home, fetchImpl }), stores };
}

test('failed new credential validation preserves old vault and preferences', async t => {
  let reject = false;
  const { service, stores } = await setup(t, async url => reject ? new Response('', { status: 401 }) : Response.json({ data: url.endsWith('/marketplace/models') ? [] : [{ id: 'a' }] }));
  await service.request('connect', { apiKey: 'old-fixture', baseUrl: ENDPOINTS[0] });
  await service.request('preferences', { baseUrl: ENDPOINTS[0], model: 'a' });
  reject = true;
  await assert.rejects(service.request('connect', { apiKey: 'new-fixture', baseUrl: ENDPOINTS[1] }));
  assert.equal(stores.secrets.get('apiKey'), 'old-fixture');
  assert.deepEqual(stores.storage.get('preferences'), { baseUrl: ENDPOINTS[0], model: 'a' });
});

test('model refresh for another endpoint does not contaminate saved state', async t => {
  const { service } = await setup(t, async url => Response.json({ data: url.endsWith('/marketplace/models') ? [] : [{ id: url.startsWith(ENDPOINTS[0]) ? 'a' : 'b' }] }));
  await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  assert.deepEqual((await service.request('models', { baseUrl: ENDPOINTS[1] })).models, [{ id: 'b', available: true }]);
  assert.deepEqual((await service.request('state')).models, []);
  await assert.rejects(service.request('preferences', { baseUrl: ENDPOINTS[0], model: 'b' }));
  await assert.rejects(service.request('apply', { agentIds: ['opencode'], confirmed: false }));
});

test('published models unavailable to a key are visible but cannot overwrite preferences', async t => {
  const { service, stores } = await setup(t, async url => Response.json({ data:
    url.endsWith('/marketplace/models') ? [{ models: [{ id: 'allowed' }, { id: 'other-group' }] }] : [{ id: 'allowed' }]
  }));
  const state = await service.request('connect', { apiKey: 'fixture', baseUrl: ENDPOINTS[0] });
  assert.deepEqual(state.models, [{ id: 'allowed', available: true }, { id: 'other-group', available: false }]);
  await service.request('preferences', { baseUrl: ENDPOINTS[0], model: 'allowed' });
  await assert.rejects(service.request('preferences', { baseUrl: ENDPOINTS[0], model: 'other-group' }));
  assert.equal(stores.storage.get('preferences').model, 'allowed');
});
