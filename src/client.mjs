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
