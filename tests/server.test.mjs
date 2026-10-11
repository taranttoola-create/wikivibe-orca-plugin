import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startControlServer } from '../src/server.mjs';
import { ConnectionError } from '../src/connection-errors.mjs';

test('control API rejects unauthenticated, cross-origin and DNS rebinding requests', async t => {
  let mutations = 0;
  const control = await startControlServer({ request: async () => { mutations++; return { connected: false }; } });
  t.after(() => control.close());
  const token = new URL(control.url).hash.slice(7);
  const auth = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${control.origin}/api/state`)).status, 401);
  assert.equal((await fetch(`${control.origin}/api/state`, { headers: { ...auth, Origin: 'https://attacker.invalid' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${control.origin}/api/state`, { headers: { ...auth, Host: 'attacker.invalid' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal(mutations, 0);
  const valid = await fetch(`${control.origin}/api/state`, { headers: auth });
  assert.deepEqual(await valid.json(), { connected: false });
  assert.equal(mutations, 1);
});

test('UI policy is nonce based, non-cacheable and does not embed session token', async t => {
  const control = await startControlServer({ request: async () => ({}) });
  t.after(() => control.close());
  const response = await fetch(control.origin);
  const html = await response.text();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(!html.includes(new URL(control.url).hash.slice(7)));
  assert.ok(!html.includes('__NONCE__'));
});

test('oversize and invalid JSON never reach mutation service', async t => {
  let called = false;
  const control = await startControlServer({ request: async () => { called = true; } });
  t.after(() => control.close());
  const headers = { Authorization: `Bearer ${new URL(control.url).hash.slice(7)}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${control.origin}/api/connect`, { method: 'POST', headers, body: 'not-json' })).status, 400);
  assert.equal((await fetch(`${control.origin}/api/connect`, { method: 'POST', headers, body: JSON.stringify({ apiKey: 'x'.repeat(20000) }) })).status, 413);
  assert.equal(called, false);
});

test('connect returns only trusted categories, never reflected upstream or host secrets', async t => {
  let failure = new ConnectionError('api_auth');
  const control = await startControlServer({ request: async () => { throw failure; } });
  t.after(() => control.close());
  const headers = { Authorization: `Bearer ${new URL(control.url).hash.slice(7)}`, 'Content-Type': 'application/json' };
  async function connect() {
    const response = await fetch(`${control.origin}/api/connect`, { method: 'POST', headers, body: JSON.stringify({ apiKey: 'secret-fixture' }) });
    assert.equal(response.status, 400);
    const value = await response.json();
    assert.ok(!JSON.stringify(value).includes('secret-fixture'));
    return value;
  }
  for (const code of ['api_auth', 'api_network', 'api_catalog', 'storage']) {
    failure = new ConnectionError(code);
    failure.message = 'secret-fixture';
    assert.equal((await connect()).code, code);
  }
  failure = Object.assign(new Error('secret-fixture'), { code: 'api_auth' });
  assert.equal((await connect()).code, 'unknown');
  failure = new ConnectionError('secret-fixture');
  assert.equal((await connect()).code, 'unknown');
});
