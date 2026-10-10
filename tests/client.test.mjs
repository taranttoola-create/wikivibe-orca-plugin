import test from 'node:test';
import assert from 'node:assert/strict';
import { apiKey, endpoint, listModels, listCatalog, ENDPOINTS } from '../src/client.mjs';

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
  await assert.rejects(listModels(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => new Response('secret-fixture', { status: 401 }) }), e => !e.message.includes('secret-fixture'));
  await assert.rejects(listModels(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => Response.json({ data: [{ id: 'secret-fixture' }] }) }), e => !e.message.includes('secret-fixture'));
});

test('full catalog retains all groups and key-only models without granting access', async () => {
  const result = await listCatalog(ENDPOINTS[0], 'fixture-secret', { fetchImpl: async (url, options) => {
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'private-model' }, { id: 'shared-model' }] });
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ data: [
      { models: [{ id: 'shared-model' }, { id: 'gpt-image-2.5' }] },
      { models: [{ id: 'other-group-model' }, { id: 'shared-model' }] }
    ] });
  } });
  assert.deepEqual(new Map(result.map(model => [model.id, model.available])), new Map([
    ['gpt-image-2.5', false], ['other-group-model', false], ['private-model', true], ['shared-model', true]
  ]));
});

test('public catalog failure does not silently return a partial list or leak reflected credentials', async () => {
  for (const publicResponse of [new Response('', { status: 503 }), Response.json({ data: [{ models: [{ id: 'fixture-secret' }] }] })]) {
    await assert.rejects(listCatalog(ENDPOINTS[0], 'fixture-secret', { fetchImpl: async url =>
      url.endsWith('/v1/models') ? Response.json({ data: [{ id: 'accessible' }] }) : publicResponse
    }), error => !error.message.includes('fixture-secret'));
  }
});
