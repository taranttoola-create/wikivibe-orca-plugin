import { apiKey, endpoint, ENDPOINTS, REGISTRATION_URL, listModels } from './client.mjs';
import { listAgents, previewAgents, applyAgents, restoreAgents } from './adapters.mjs';

export function createService(host, { home, fetchImpl = fetch } = {}) {
  let models = [];
  let modelsBase = '';
  let queue = Promise.resolve();
  const options = { home };
  async function config() {
    const { value } = await host.call('storage.get', { key: 'preferences' });
    return { baseUrl: ENDPOINTS.includes(value?.baseUrl) ? value.baseUrl : ENDPOINTS[0], model: typeof value?.model === 'string' ? value.model : '' };
  }
  async function key() {
    const { value } = await host.call('secrets.get', { key: 'apiKey' });
    if (!value) throw new Error('Сначала проверьте и сохраните API-ключ.');
    return value;
  }
  async function state() {
    const preferences = await config();
    const secret = await host.call('secrets.get', { key: 'apiKey' });
    return { ...preferences, connected: Boolean(secret.value), models: modelsBase === preferences.baseUrl ? models : [], agents: await listAgents(options), registrationUrl: REGISTRATION_URL };
  }
  async function save(preferences) {
    await host.call('storage.set', { key: 'preferences', value: preferences });
  }
  async function perform(action, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Некорректный запрос.');
    switch (action) {
      case 'state': return state();
      case 'connect': {
        const preferences = { baseUrl: endpoint(body.baseUrl), model: '' };
        const credential = apiKey(body.apiKey);
        const catalog = await listModels(preferences.baseUrl, credential, { fetchImpl });
        const previous = await config();
        if (previous.baseUrl === preferences.baseUrl && catalog.some(m => m.id === previous.model)) preferences.model = previous.model;
        await host.call('secrets.set', { key: 'apiKey', value: credential });
        await save(preferences);
        models = catalog;
        modelsBase = preferences.baseUrl;
        return state();
      }
      case 'models': {
        const preferences = await config();
        const selected = body.baseUrl === undefined ? preferences.baseUrl : endpoint(body.baseUrl);
        models = await listModels(selected, await key(), { fetchImpl });
        modelsBase = selected;
        return { models };
      }
      case 'preferences': {
        const selected = endpoint(body.baseUrl);
        const catalog = await listModels(selected, await key(), { fetchImpl });
        if (typeof body.model !== 'string' || !catalog.some(m => m.id === body.model)) throw new Error('Выберите модель из каталога по выбранному адресу API.');
        await save({ baseUrl: selected, model: body.model });
        models = catalog;
        modelsBase = selected;
        return state();
      }
      case 'preview': return previewAgents(body.agentIds, await config(), options);
      case 'apply': {
        if (body.confirmed !== true) throw new Error('Подтвердите изменение файлов агентов и запись API-ключа в их конфигурации открытым текстом.');
        const preferences = await config();
        if (!preferences.model) throw new Error('Сначала выберите и сохраните модель.');
        const credential = await key();
        const catalog = await listModels(preferences.baseUrl, credential, { fetchImpl });
        if (!catalog.some(m => m.id === preferences.model)) throw new Error('Выбранная модель больше недоступна. Обновите список моделей.');
        return applyAgents(body.agentIds, { ...preferences, apiKey: credential }, options);
      }
      case 'restore': {
        if (body.confirmed !== true) throw new Error('Подтвердите восстановление файлов агентов из резервных копий.');
        return restoreAgents(body.agentIds, options);
      }
      case 'disconnect':
        await host.call('secrets.delete', { key: 'apiKey' });
        models = [];
        modelsBase = '';
        return state();
      default: throw new Error('Неизвестная операция.');
    }
  }
  // UI requests and Orca commands share one mutation lane.
  return {
    request(action, body) {
      const pending = queue.then(() => perform(action, body));
      queue = pending.catch(() => {});
      return pending;
    }
  };
}
