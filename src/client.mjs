import { ConnectionError } from './connection-errors.mjs';

export const ENDPOINTS = ['https://api.wikivibe.dev/v1', 'https://vapi.wikivibe.dev/v1'];
export const REGISTRATION_URL = 'https://api.wikivibe.dev/register?aff=9YAJBL6HLM23';

export function endpoint(value) {
  if (!ENDPOINTS.includes(value)) throw new ConnectionError('endpoint');
  return value;
}

export function apiKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096 || /[\r\n\x00-\x20\x7f]/.test(value.trim())) {
    throw new ConnectionError('key_format');
  }
  return value.trim();
}

export async function listModels(baseUrl, key, { fetchImpl = fetch } = {}) {
  const url = endpoint(baseUrl);
  const credential = apiKey(key);
  let response;
  try {
    response = await fetchImpl(`${url}/models`, {
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new ConnectionError('api_network');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new ConnectionError('api_auth');
    if (response.status === 429) throw new ConnectionError('api_limit');
    throw new ConnectionError('api_http');
  }
  // Never return arbitrary upstream content: it could reflect credentials.
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new ConnectionError('api_catalog');
  }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(data.data)) throw new Error();
    const ids = new Set();
    for (const model of data.data) {
      if (typeof model?.id !== 'string' || model.id.length > 256 || !model.id || /[\x00-\x1f\x7f]/.test(model.id) || model.id.includes(credential)) throw new Error();
      ids.add(model.id);
    }
    return [...ids].sort().map(id => ({ id }));
  } catch {
    throw new ConnectionError('api_catalog');
  }
}

const USAGE_FIELDS = ['requests', 'total_tokens', 'cost', 'actual_cost', 'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'];
const ACCOUNT_FIELDS = ['status', 'isValid', 'mode', 'balance', 'billing', 'quota', 'rate_limits', 'usage', 'today', 'daily_usage'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;

function usageMetrics(value) {
  return record(value) ? Object.fromEntries(USAGE_FIELDS.map(field => [field, amount(value[field])])) : null;
}

function projectAccount(data, credential) {
  if (!record(data) || !ACCOUNT_FIELDS.some(field => Object.hasOwn(data, field))) throw new Error();
  // Even known enum/date strings must not echo an unusually short credential.
  const choice = (value, allowed) => typeof value === 'string' && allowed.includes(value) && !value.includes(credential) ? value : null;
  const unit = value => choice(value, ['USD']);
  const quota = value => record(value) ? {
    limit: amount(value.limit), used: amount(value.used), remaining: amount(value.remaining), unit: unit(value.unit)
  } : null;
  const billing = record(data.billing) ? {
    source: choice(data.billing.source, ['balance', 'subscription']),
    mode: choice(data.billing.mode, ['auto', 'balance', 'subscription']),
    available: boolean(data.billing.available), unit: unit(data.billing.unit),
    balance: amount(data.billing.balance), remaining: amount(data.billing.remaining)
  } : null;
  const usage = record(data.usage) || record(data.today) ? {
    rpm: amount(data.usage?.rpm), tpm: amount(data.usage?.tpm),
    today: usageMetrics(record(data.usage) ? data.usage.today : data.today),
    total: usageMetrics(data.usage?.total)
  } : null;
  const rateLimits = Array.isArray(data.rate_limits) ? data.rate_limits.map(value => record(value) ? {
    window: choice(value.window, ['5h', '1d', '7d']),
    limit: amount(value.limit), used: amount(value.used), remaining: amount(value.remaining)
  } : null).filter(value => value?.window !== null && value !== null) : null;
  const dailyUsage = Array.isArray(data.daily_usage) ? data.daily_usage.flatMap(value => {
    if (!record(value) || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || value.date.includes(credential)) return [];
    const date = new Date(`${value.date}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.date) return [];
    return [{ date: date.toISOString().slice(0, 10), ...usageMetrics(value), cache_write_tokens: amount(value.cache_write_tokens) }];
  }) : null;
  return {
    status: choice(data.status, ['active', 'quota_exhausted', 'expired']), isValid: boolean(data.isValid),
    mode: choice(data.mode, ['quota_limited']), balance: amount(data.balance), billing,
    quota: quota(data.quota), rate_limits: rateLimits, usage, daily_usage: dailyUsage
  };
}

export async function listAccount(baseUrl, key, { fetchImpl = fetch } = {}) {
  const url = endpoint(baseUrl);
  const credential = apiKey(key);
  let response;
  try {
    response = await fetchImpl(`${url}/usage?days=7`, {
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new ConnectionError('api_network');
  }
  const cancel = async () => { try { await response.body?.cancel(); } catch {} };
  if (!response.ok) {
    await cancel();
    if (response.status === 401 || response.status === 403) throw new ConnectionError('api_auth');
    if (response.status === 429) throw new ConnectionError('api_limit');
    throw new ConnectionError('api_http');
  }
  try {
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    return projectAccount(JSON.parse(Buffer.concat(chunks).toString('utf8')), credential);
  } catch {
    await cancel();
    throw new ConnectionError('api_account');
  }
}
