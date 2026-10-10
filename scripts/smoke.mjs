import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';
import { startControlServer } from '../src/server.mjs';

// Verification harness only: temporary host storage and fixture catalog. Not
// shipped as a provider fallback. Production uses Orca vault and native fetch.
const home = await mkdtemp(join(tmpdir(), 'wikivibe-smoke-'));
const storage = new Map();
const secrets = new Map();
const host = { async call(method, { key, value }) {
  const store = method.startsWith('secrets.') ? secrets : storage;
  if (method.endsWith('.get')) return { value: store.get(key) ?? null };
  if (method.endsWith('.set')) store.set(key, value);
  if (method.endsWith('.delete')) store.delete(key);
  return { ok: true };
} };
const fixture = process.argv.includes('--fixture');
const service = createService(host, { home, ...(fixture ? { fetchImpl: async () => Response.json({ data: [{ id: 'fixture-model' }] }) } : {}) });
const control = await startControlServer(service, { idleMs: 10 * 60_000 });
console.log(JSON.stringify({ url: control.url, home, mode: fixture ? 'isolated-fixture' : 'real-network' }));
async function cleanup() { await control.close(); await rm(home, { recursive: true, force: true }); }
if (process.argv.includes('--serve')) {
  process.once('SIGINT', async () => { await cleanup(); process.exit(0); });
  process.once('SIGTERM', async () => { await cleanup(); process.exit(0); });
} else {
  try {
    const headers = { Authorization: `Bearer ${new URL(control.url).hash.slice(7)}`, 'Content-Type': 'application/json' };
    async function post(action, body) {
      const response = await fetch(`${control.origin}/api/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: response.status, value: await response.json() };
    }
    assert.equal((await fetch(`${control.origin}/api/state`)).status, 401);
    if (!fixture) {
      const result = await post('connect', { apiKey: 'invalid-smoke-credential', baseUrl: 'https://api.wikivibe.dev/v1' });
      assert.equal(result.status, 400);
      assert.equal(secrets.size, 0);
      console.log('Real WikiVibe invalid-key rejection; vault remains empty.');
    } else {
      assert.equal((await post('connect', { apiKey: 'fixture-credential', baseUrl: 'https://api.wikivibe.dev/v1' })).value.connected, true);
      assert.equal((await post('preferences', { baseUrl: 'https://api.wikivibe.dev/v1', model: 'fixture-model' })).status, 200);
      const preview = await post('preview', { agentIds: ['opencode'] });
      assert.equal(preview.status, 200);
      assert.equal((await post('apply', { agentIds: ['opencode'], confirmed: false })).status, 400);
      assert.equal((await post('apply', { agentIds: ['opencode'], confirmed: true })).status, 200);
      assert.equal((await post('restore', { agentIds: ['opencode'], confirmed: true })).status, 200);
      assert.equal((await post('disconnect', {})).value.connected, false);
      console.log('Isolated fixture: connect → preferences → preview → consent → apply → restore → disconnect.');
    }
  } finally { await cleanup(); }
}
