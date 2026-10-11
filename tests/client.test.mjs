import test from 'node:test';
import assert from 'node:assert/strict';
import { apiKey, endpoint, listModels, listAccount, ENDPOINTS } from '../src/client.mjs';

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


test('credential failures distinguish API access and transport without upstream text', async () => {
  for (const [status, code] of [[401, 'api_auth'], [403, 'api_auth'], [429, 'api_limit'], [503, 'api_http']]) {
    await assert.rejects(listModels(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => new Response('secret-fixture', { status }) }), error => error.code === code && !error.message.includes('secret-fixture'));
  }
  await assert.rejects(listModels(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => { throw new Error('secret-fixture'); } }), error => error.code === 'api_network');
});

const accountMetrics = {
  requests: 0, total_tokens: 0, cost: 0, actual_cost: 0, input_tokens: 0,
  output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0
};

test('account uses only fixed endpoints and authenticated documented usage URL', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(url, `${ENDPOINTS[1]}/usage?days=7`);
    assert.deepEqual(options.headers, { Authorization: 'Bearer fixture-key', Accept: 'application/json' });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({
      status: 'active', isValid: true, mode: 'quota_limited', balance: 3.48422792,
      billing: { available: true, balance: 3.48422792, source: 'balance', mode: 'auto', remaining: 3.48422792, unit: 'USD' },
      quota: { limit: 1, used: 0, remaining: 1, unit: 'USD' },
      rate_limits: [{ window: '1d', limit: 10, used: 3.2, remaining: 6.8 }],
      usage: { rpm: 0, tpm: 0, today: accountMetrics, total: accountMetrics }, daily_usage: []
    });
  };
  await assert.rejects(listAccount('https://attacker.invalid/v1', 'fixture-key', { fetchImpl }), e => e.code === 'endpoint');
  await assert.rejects(listAccount(ENDPOINTS[1], 'key\r\nInjected: true', { fetchImpl }), e => e.code === 'key_format');
  assert.equal(calls, 0);
  assert.deepEqual(await listAccount(ENDPOINTS[1], 'fixture-key', { fetchImpl }), {
    status: 'active', isValid: true, mode: 'quota_limited', balance: 3.48422792,
    billing: { available: true, balance: 3.48422792, source: 'balance', mode: 'auto', remaining: 3.48422792, unit: 'USD' },
    quota: { limit: 1, used: 0, remaining: 1, unit: 'USD' },
    rate_limits: [{ window: '1d', limit: 10, used: 3.2, remaining: 6.8 }],
    usage: { rpm: 0, tpm: 0, today: accountMetrics, total: accountMetrics }, daily_usage: []
  });
  assert.equal(calls, 1);
});

test('account projects known types only and never reflects secrets or unknown strings', async () => {
  const secret = 'secret-fixture';
  const result = await listAccount(ENDPOINTS[0], secret, { fetchImpl: async () => Response.json({
    status: secret, mode: 'invented-mode', isValid: secret, balance: secret,
    billing: { source: secret, mode: secret, available: secret, unit: secret, balance: secret, remaining: secret, plan_name: secret },
    quota: { limit: secret, used: secret, remaining: secret, unit: secret },
    rate_limits: [{ window: secret, limit: 10 }, { window: '1d', limit: 10, used: 0, reset_at: secret, message: secret }],
    usage: { rpm: secret, tpm: secret, today: { cost: secret, message: secret }, total: secret },
    daily_usage: [{ date: secret }, { date: '2026-10-10', requests: 0, actual_cost: 0, label: secret }],
    subscriptions: [{ name: secret }], message: secret, key: secret
  }) });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(Object.keys(result).sort(), ['balance', 'billing', 'daily_usage', 'isValid', 'mode', 'quota', 'rate_limits', 'status', 'usage']);
  assert.equal(result.status, null);
  assert.equal(result.mode, null);
  assert.equal(result.isValid, null);
  assert.equal(result.billing.source, null);
  assert.equal(result.billing.available, null);
  assert.equal(result.quota.unit, null);
  assert.deepEqual(result.rate_limits, [{ window: '1d', limit: 10, used: 0, remaining: null }]);
  assert.equal(result.daily_usage.length, 1);
  assert.equal(result.daily_usage[0].date, '2026-10-10');
  assert.equal(Object.hasOwn(result.daily_usage[0], 'label'), false);
  const shortKey = await listAccount(ENDPOINTS[0], 'active', { fetchImpl: async () => Response.json({ status: 'active' }) });
  assert.equal(shortKey.status, null);
});

test('account rejects negative, nonfinite and coerced amounts while preserving zero and missing', async () => {
  const result = await listAccount(ENDPOINTS[0], 'fixture', { fetchImpl: async () => new Response(`{
    "balance": 1e400, "isValid": false,
    "billing": {"balance": -1, "remaining": 0, "available": false},
    "quota": {"limit": "10", "used": false},
    "rate_limits": [{"window":"5h","limit":-1,"used":1e400,"remaining":0}],
    "usage": {"rpm": 0, "tpm": "5", "today": {"cost": -1, "actual_cost": 0, "requests": 0, "input_tokens": 1e400}}
  }`, { headers: { 'content-type': 'application/json' } }) });
  assert.equal(result.balance, null);
  assert.equal(result.isValid, false);
  assert.equal(result.billing.balance, null);
  assert.equal(result.billing.remaining, 0);
  assert.equal(result.billing.available, false);
  assert.deepEqual(result.quota, { limit: null, used: null, remaining: null, unit: null });
  assert.deepEqual(result.rate_limits, [{ window: '5h', limit: null, used: null, remaining: 0 }]);
  assert.equal(result.usage.rpm, 0);
  assert.equal(result.usage.tpm, null);
  assert.equal(result.usage.today.cost, null);
  assert.equal(result.usage.today.actual_cost, 0);
  assert.equal(result.usage.today.requests, 0);
  assert.equal(result.usage.today.input_tokens, null);
  assert.equal(result.usage.today.output_tokens, null);
  assert.equal(result.usage.total, null);
  assert.equal(result.daily_usage, null);
});

test('documented top-level today normalizes to usage and valid daily rows are typed', async () => {
  const result = await listAccount(ENDPOINTS[0], 'fixture', { fetchImpl: async () => Response.json({
    today: { requests: 128, total_tokens: 245678, cost: 1.42 },
    daily_usage: [null, { date: '2026-02-30' }, { date: '2026-10-10', requests: 5, cache_write_tokens: 12, actual_cost: 0.25 }]
  }) });
  assert.equal(result.usage.today.requests, 128);
  assert.equal(result.usage.today.cost, 1.42);
  assert.equal(result.usage.today.actual_cost, null);
  assert.equal(result.usage.rpm, null);
  assert.equal(result.usage.total, null);
  assert.equal(result.daily_usage.length, 1);
  assert.equal(result.daily_usage[0].cache_write_tokens, 12);
  assert.equal(result.daily_usage[0].actual_cost, 0.25);
});

test('account transport and HTTP failures use fixed categories without reflected text', async () => {
  for (const [status, code] of [[401, 'api_auth'], [403, 'api_auth'], [429, 'api_limit'], [503, 'api_http']]) {
    await assert.rejects(listAccount(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => new Response('secret-fixture', { status }) }), error => error.code === code && !error.message.includes('secret-fixture'));
  }
  await assert.rejects(listAccount(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => { throw new Error('secret-fixture'); } }), error => error.code === 'api_network' && !error.message.includes('secret-fixture'));
});

test('account rejects malformed, unrelated and oversized responses without reflecting upstream text', async () => {
  const invalid = [
    () => new Response('secret-fixture', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{"balance":secret-fixture}', { headers: { 'content-type': 'application/json' } }),
    () => Response.json(null), () => Response.json([]), () => Response.json({}),
    () => Response.json({ error: 'secret-fixture' }),
    () => Response.json({ status: 'active', message: 'secret-fixture'.repeat(200000) }),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret-fixture')); } }), { headers: { 'content-type': 'application/json' } })
  ];
  for (const response of invalid) {
    await assert.rejects(listAccount(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => response() }), error => error.code === 'api_account' && !error.message.includes('secret-fixture'));
  }
});

test('account cancellation failures cannot expose upstream errors', async () => {
  const response = (ok, status, contentType) => ({
    ok, status, headers: new Headers({ 'content-type': contentType }),
    body: { async cancel() { throw new Error('secret-fixture'); } }
  });
  await assert.rejects(listAccount(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => response(false, 401, 'text/plain') }), error => error.code === 'api_auth' && !error.message.includes('secret-fixture'));
  await assert.rejects(listAccount(ENDPOINTS[0], 'secret-fixture', { fetchImpl: async () => response(true, 200, 'text/html') }), error => error.code === 'api_account' && !error.message.includes('secret-fixture'));
});
