import { apiKey, endpoint, ENDPOINTS, REGISTRATION_URL, listModels } from './client.mjs';
import { listAgents, previewAgents, applyAgents, restoreAgents } from './adapters.mjs';
import { ConnectionError } from './connection-errors.mjs';

export function createService(host, { home, fetchImpl = fetch } = {}) {
  let models = [];
  let modelsBase = '';
  let queue = Promise.resolve();
  const options = { home };
  async function config() {
    const { value } = await host.call('storage.get', { key: 'preferences' });
    return { baseUrl: ENDPOINTS.includes(value?.baseUrl) ? value.baseUrl : ENDPOINTS[0] };
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
  async function roster(baseUrl, credential) {
    const catalog = await listModels(baseUrl, credential, { fetchImpl });
    if (!catalog.length) throw new ConnectionError('api_catalog');
    return catalog;
  }
  async function perform(action, body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Некорректный запрос.');
    switch (action) {
      case 'state': return state();
      case 'connect': {
        const preferences = { baseUrl: endpoint(body.baseUrl) };
        const credential = apiKey(body.apiKey);
        const catalog = await roster(preferences.baseUrl, credential);
        try {
          await host.call('secrets.set', { key: 'apiKey', value: credential });
          await save(preferences);
        } catch {
          throw new ConnectionError('storage');
        }
        models = catalog;
        modelsBase = preferences.baseUrl;
        return state();
      }
      case 'models': {
        const preferences = await config();
        const selected = body.baseUrl === undefined ? preferences.baseUrl : endpoint(body.baseUrl);
        models = await roster(selected, await key());
        modelsBase = selected;
        return { models };
      }
      case 'preferences': {
        const selected = endpoint(body.baseUrl);
        const catalog = await roster(selected, await key());
        await save({ baseUrl: selected });
        models = catalog;
        modelsBase = selected;
        return state();
      }
      case 'preview': {
        const preferences = await config();
        const catalog = await roster(preferences.baseUrl, await key());
        models = catalog;
        modelsBase = preferences.baseUrl;
        const preview = await previewAgents(body.agentIds, { ...preferences, models: catalog }, options);
        return { ...preview, models: catalog };
      }
      case 'apply': {
        if (body.confirmed !== true) throw new Error('Подтвердите изменение файлов агентов и запись API-ключа в их конфигурации открытым текстом.');
        const preferences = await config();
        const credential = await key();
        const catalog = await roster(preferences.baseUrl, credential);
        models = catalog;
        modelsBase = preferences.baseUrl;
        const result = await applyAgents(body.agentIds, { ...preferences, models: catalog, apiKey: credential }, options);
        return { ...result, models: catalog };
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
