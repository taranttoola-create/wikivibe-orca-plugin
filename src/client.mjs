export const ENDPOINTS = ['https://api.wikivibe.dev/v1', 'https://vapi.wikivibe.dev/v1'];
export const REGISTRATION_URL = 'https://api.wikivibe.dev/register?aff=9YAJBL6HLM23';

export function endpoint(value) {
  if (!ENDPOINTS.includes(value)) throw new Error('Выберите API или VAPI WikiVibe.');
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
    throw new Error('Не удалось связаться с WikiVibe за 15 секунд. Проверьте сеть и выбранный endpoint.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new Error('Ключ отклонён или не имеет доступа к выбранному endpoint.');
    if (response.status === 429) throw new Error('WikiVibe ограничил запросы. Повторите позже.');
    throw new Error(`Каталог моделей недоступен (HTTP ${response.status}).`);
  }
  // Never return arbitrary upstream content: it could reflect credentials.
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new Error('WikiVibe вернул не JSON-каталог моделей.');
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
