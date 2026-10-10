export const ENDPOINTS = ['https://api.wikivibe.dev/v1', 'https://vapi.wikivibe.dev/v1'];
export const REGISTRATION_URL = 'https://api.wikivibe.dev/register?aff=9YAJBL6HLM23';

export function endpoint(value) {
  if (!ENDPOINTS.includes(value)) throw new Error('Выберите один из поддерживаемых адресов API WikiVibe.');
  return value;
}

export function apiKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096 || /[\r\n\x00-\x20\x7f]/.test(value.trim())) {
    throw new Error('Введите API-ключ без пробелов и управляющих символов.');
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
    throw new Error('Не удалось связаться с WikiVibe. Время ожидания — 15 секунд. Проверьте сеть и выбранный адрес API.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new Error('Ключ отклонён или не имеет доступа к выбранному адресу API.');
    if (response.status === 429) throw new Error('Достигнут лимит запросов WikiVibe. Повторите позже.');
    throw new Error(`Каталог моделей недоступен (HTTP ${response.status}).`);
  }
  // Never return arbitrary upstream content: it could reflect credentials.
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new Error('WikiVibe вернул каталог моделей не в формате JSON.');
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
    throw new Error('Некорректный или слишком большой каталог моделей WikiVibe.');
  }
}

// The authenticated endpoint lists only the key's group; the public catalog
// lists every published group. Never send credentials to the public endpoint.
export async function listCatalog(baseUrl, key, { fetchImpl = fetch } = {}) {
  const accessible = await listModels(baseUrl, key, { fetchImpl });
  let response;
  try {
    response = await fetchImpl(`${new URL(endpoint(baseUrl)).origin}/api/public/marketplace/models`, {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000)
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      throw new Error();
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(data.data)) throw new Error();
    const models = new Map(accessible.map(model => [model.id, { id: model.id, available: true }]));
    const credential = apiKey(key);
    for (const group of data.data) {
      if (!Array.isArray(group.models)) throw new Error();
      for (const model of group.models) {
        if (typeof model?.id !== 'string' || !model.id || model.id.length > 256 || /[\x00-\x1f\x7f]/.test(model.id) || model.id.includes(credential)) throw new Error();
        if (!models.has(model.id)) models.set(model.id, { id: model.id, available: false });
      }
    }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    throw new Error('Некорректный или слишком большой каталог моделей WikiVibe.');
  }
}
