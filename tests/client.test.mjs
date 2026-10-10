import test from 'node:test';
import assert from 'node:assert/strict';
import { apiKey, endpoint, listModels, ENDPOINTS } from '../src/client.mjs';

test('fixed hosts reject credential exfiltration endpoints', async () => {
  assert.throws(() => endpoint('https://attacker.invalid/v1'));
  assert.throws(() => apiKey('key\r\nInjected: true'));
  let called = false;
  await assert.rejects(listModels('http://localhost/v1', 'fixture', { fetchImpl: () => { called = true; } }));
  assert.equal(called, false);
});

test('models are authenticated, deduplicated and sorted', async () => {
  const result = await listModels(ENDPOINTS[1], 'fixture-key', { fetchImpl: async (url, options) => {
    assert.equal(url, `${ENDPOINTS[1]}/models`);
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    assert.equal(options.redirect, 'error');
    return Response.json({ data: [{ id: 'z' }, { id: 'a' }, { id: 'z' }] });
  } });
  assert.deepEqual(result, [{ id: 'a' }, { id: 'z' }]);
});

test('upstream auth failure or reflected key never appears in diagnostics', async () => {
  await assert.rejects(listModels(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => new Response('secret-fixture', { status: 401 }) }), e => !e.message.includes('secret-fixture') && e.message.includes('Ключ'));
  await assert.rejects(listModels(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => Response.json({ data: [{ id: 'secret-fixture' }] }) }), e => !e.message.includes('secret-fixture'));
});
