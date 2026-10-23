import { homedir } from 'node:os';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseJSONC, modify, applyEdits } from './vendor/jsonc-parser/lib/esm/main.js';
import { parseDocument } from './vendor/yaml/browser/index.js';

// Native format sources (not a claim that a particular gateway model supports tools):
// Claude: https://code.claude.com/docs/en/llm-gateway-connect
// Picker: https://code.claude.com/docs/en/settings-reference#modelpicker
// Codex: https://developers.openai.com/codex/config-reference
// Profiles: https://developers.openai.com/codex/config-file/config-advanced
// Catalog: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs
// OpenCode: https://opencode.ai/docs/config/ and https://opencode.ai/docs/providers/#custom-provider
// Pi: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
// OMP: https://github.com/can1357/oh-my-pi/blob/main/docs/models.md
// Aider: https://aider.chat/docs/llms/openai-compat.html and https://aider.chat/docs/config/aider_conf.html
// Catalog: https://aider.chat/docs/config/adv-model-settings.html
// /models: https://github.com/Aider-AI/aider/blob/main/aider/models.py
// Qwen: https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
// Default local paths and our opt-in Codex profile are managed. Applying replaces
// WikiVibe credentials/routing with the authenticated plugin route, never defaults.
const ENDPOINTS = new Set(['https://api.wikivibe.dev/v1', 'https://vapi.wikivibe.dev/v1']);
const BACKUPS = '.wikivibe-gateway-backups';
const AGENTS = [
  { id: 'claude', label: 'Claude Code', rel: '.claude/settings.json', protocol: 'Anthropic Messages', description: 'В ~/.claude/settings.json: env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN и полный modelPicker (Claude Code ≥ 2.1.242). Отдельный поставщик WikiVibe не поддерживается: шлюз заменяет Anthropic endpoint. Текущая модель не меняется; выбор через /model.' },
  { id: 'codex', label: 'Codex', rel: '.codex/config.toml', protocol: 'OpenAI Responses', description: 'Регистрация model_providers.wikivibe в ~/.codex/config.toml; ~/.codex/wikivibe.config.toml и wikivibe-models.json — отдельный полный каталог. Пользователь включает профиль штатно: codex -p wikivibe, затем /model. Базовые model/model_provider не меняются. Нужна версия с профильными файлами и model_catalog_json; Desktop/Orca picker не гарантируется.' },
  { id: 'opencode', label: 'OpenCode', rel: '.config/opencode/opencode.json', protocol: 'OpenAI Responses / Chat Completions', description: 'Все существующие маршруты WikiVibe получают проверенные endpoint, ключ и полный каталог плагина; ID и активная модель сохраняются. GPT используют @ai-sdk/openai (Responses), остальные — openai-compatible (Chat Completions). Image-модели объявлены с image output, не как coding-модели с tools. Выбор через /models.' },
  { id: 'pi', label: 'Pi', rel: '.pi/agent/models.json', protocol: 'OpenAI Chat Completions', description: 'В ~/.pi/agent/models.json: providers.wikivibe с baseUrl, apiKey, api = openai-completions и всеми models. Существующий settings.json/enabledModels расширяется ID wikivibe/<id>; defaultProvider/defaultModel не меняются. Выбор через /model.' },
  { id: 'omp', label: 'oh-my-pi', rel: '.omp/agent/models.yml', protocol: 'OpenAI Responses / Chat Completions', description: 'WikiVibe получает endpoint и ключ плагина, весь каталог и per-model api: GPT — openai-responses, остальные — openai-completions. Image ID получают kind:image; OMP 18.6.3 игнорирует kind в custom YAML и всё ещё показывает их в chat picker. Для штатного generate_image нужны поддержка kind в версии OMP и hosted carrier; изменение api само по себе не подтверждает генерацию. modelRoles не меняются.' },
  { id: 'aider', label: 'Aider', rel: '.aider.conf.yml', protocol: 'OpenAI Chat Completions', description: 'В ~/.aider.conf.yml: openai-api-base и openai-api-key; ~/.aider.model.metadata.json регистрирует весь каталог для /models. Отдельного поставщика WikiVibe нет: используется openai/<id>, общий OpenAI endpoint заменяется. Текущая model не меняется; выбор через /model openai/<id>. /models также показывает встроенные модели LiteLLM, не подтверждённые ключом; лимиты и цены неизвестны.' },
  { id: 'qwen', label: 'Qwen Code', rel: '.qwen/settings.json', protocol: 'OpenAI Chat Completions', description: 'В ~/.qwen/settings.json: все доступные modelProviders.openai с меткой WikiVibe и env.WIKIVIBE_API_KEY. WikiVibe — метка в группе протокола OpenAI, не отдельный тип auth. Текущие model.name/security.auth не меняются; при необходимости /auth, затем /model.' }
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Documented image-input support, checked 2026-10-23. Unknown IDs stay text-only.
const VISION_MODELS = new Set([
  'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol',
  'gemini-3.8-flash', 'gemini-3.1-flash-lite-preview', 'gemini-4-argon',
  'glm-5.3-flash', 'gpt-image-2', 'gpt-image-2.5'
]);
const hasImageInput = id => VISION_MODELS.has(id) || id.startsWith('gpt-image-');
const own = (object, key) => Object.hasOwn(object, key);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function fail(message) { throw new Error(message); }
function selected(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > AGENTS.length || ids.some(id => typeof id !== 'string' || !AGENTS.some(a => a.id === id))) fail('Выберите поддерживаемых агентов.');
  return [...new Set(ids)].map(id => AGENTS.find(a => a.id === id));
}
function preferences(value, secret = false) {
  if (!value || !ENDPOINTS.has(value.baseUrl)) fail('Недопустимый адрес API WikiVibe.');
  if (!Array.isArray(value.models) || !value.models.length || value.models.some(model => !object(model) || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 300 || /[\x00-\x1f\x7f]/.test(model.id) || model.available === false) || new Set(value.models.map(model => model.id)).size !== value.models.length) fail('Нужен непустой каталог моделей, доступных текущему API-ключу.');
  // Pi/OMP resolve !commands, $variables and bare environment names in apiKey.
  // Reject expression-shaped keys rather than letting a consumer execute one.
  if (secret && (typeof value.apiKey !== 'string' || !value.apiKey.trim() || value.apiKey.length > 4096 || /[\s\x00-\x1f\x7f$]/.test(value.apiKey) || value.apiKey.startsWith('!') || /^[A-Z_][A-Z0-9_]*$/.test(value.apiKey))) fail('API-ключ должен содержать само значение ключа, а не команду или имя переменной.');
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
// Refusal used whenever the plugin may not touch a file the user changed after applying.
function conflict(label) {
  return `${label}: конфликт с изменениями после применения. Восстановление и перезапись запрещены; ваши изменения сохранены.`;
}
function child(parent, key) {
  if (!own(parent, key)) parent[key] = {};
  if (!object(parent[key])) fail('Конфигурация содержит несовместимую структуру.');
  return parent[key];
}
function parseJSON(bytes) {
  if (bytes === null) return {};
  let result;
  try { result = JSON.parse(bytes.toString('utf8')); }
  catch { fail('Поддерживается только корректный JSON без комментариев; файл не изменён.'); }
  if (!object(result)) fail('Корень конфигурации должен быть объектом JSON.');
  return result;
}
function expandAllowlist(config, key, values, remove = false) {
  if (!own(config, key)) return;
  const entries = config[key];
  if (!Array.isArray(entries) || entries.some(item => typeof item !== 'string')) fail(`Поле ${key} должно быть списком строк; файл не изменён.`);
  if (remove) config[key] = entries.filter(item => !values.includes(item));
  else config[key] = [...entries, ...values.filter(item => !entries.includes(item))];
}
function provider(parent, key, value, merge = false) {
  // Merge may replace an existing provider only while it still routes to WikiVibe,
  // which is what the plugin wrote before the file was edited.
  if (own(parent, key) && !(merge && wikiRoute(parent[key]?.baseUrl))) fail('Конфликт: поставщик wikivibe уже существует и не принадлежит плагину.');
  parent[key] = { ...(merge ? parent[key] : {}), ...value };
}
// Metadata entries the plugin itself wrote, safe to rewrite when merging.
function pluginMetadata(value) {
  return object(value) && value.litellm_provider === 'openai' && value.mode === 'chat' && Object.keys(value).length === 2;
}

function wikiRoute(url) {
  return typeof url === 'string' && /^https:\/\/(?:api|vapi)\.wikivibe\.(?:dev|ru)\/v1\/?$/.test(url);
}
function parseOpenCode(text) {
  const errors = [];
  const config = parseJSONC(text || '{}', errors, { allowTrailingComma: true });
  if (errors.length || !object(config)) fail('OpenCode: некорректный JSON/JSONC; файл не изменён.');
  return config;
}
function openCodeConfig(text, value) {
  const config = parseOpenCode(text);
  const providers = child(config, 'provider');
  const existing = Object.entries(providers).filter(([, entry]) => wikiRoute(entry?.options?.baseURL));
  if (!existing.length && own(providers, 'wikivibe')) fail('OpenCode: wikivibe указывает на другой endpoint; файл не изменён.');
  const routes = existing.length ? existing : [['wikivibe', undefined]];
  let output = text || '{}\n';
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
  const set = (keys, setting) => { output = applyEdits(output, modify(output, keys, setting, { formattingOptions })); };
  for (const [id, entry] of routes) {
    if (entry && !object(entry.models ?? {})) fail('OpenCode: models должен быть объектом.');
    const models = Object.fromEntries(value.models.map(({ id: model }) => [model, {
      ...entry?.models?.[model],
      name: entry?.models?.[model]?.name ?? model,
      provider: { npm: model.startsWith('gpt-') ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible' },
      ...(model.startsWith('gpt-image-') ? { tool_call: false, modalities: { input: ['text', 'image'], output: ['image'] } }
        : hasImageInput(model) ? { modalities: { input: ['text', 'image'], output: ['text'] } } : {})
    }]));
    set(['provider', id], {
      ...entry,
      npm: '@ai-sdk/openai-compatible',
      name: 'WikiVibe',
      options: { ...entry?.options, baseURL: value.baseUrl, apiKey: value.apiKey },
      models
    });
  }
  for (const [key, remove] of [['enabled_providers', false], ['disabled_providers', true]]) {
    expandAllowlist(config, key, routes.map(([id]) => id), remove);
    if (own(config, key)) set([key], config[key]);
  }
  return output;
}
function ompModels(text, value) {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length || document.anchors?.size) fail('oh-my-pi: некорректный YAML; файл не изменён.');
  let config;
  try { config = document.toJS({ maxAliasCount: 0 }) ?? {}; }
  catch { fail('oh-my-pi: YAML aliases не поддерживаются.'); }
  const existing = Object.entries(config.providers ?? {}).filter(([, entry]) => wikiRoute(entry?.baseUrl));
  if (existing.length > 1) fail('oh-my-pi: несколько маршрутов WikiVibe; автоматическое изменение неоднозначно.');
  if (!existing.length && own(config.providers ?? {}, 'wikivibe')) fail('oh-my-pi: wikivibe указывает на другой endpoint; файл не изменён.');
  const [id, entry] = existing[0] ?? ['wikivibe', {}];
  if (!Array.isArray(entry.models ?? [])) fail('oh-my-pi: models должен быть массивом.');
  const models = value.models.map(({ id: model }) => ({
    ...entry.models?.find(row => row.id === model),
    id: model,
    api: model.startsWith('gpt-') ? 'openai-responses' : 'openai-completions',
    kind: model.startsWith('gpt-image-') ? 'image' : 'chat',
    ...(hasImageInput(model) ? { input: ['text', 'image'] } : {}),
    ...(model.startsWith('gpt-image-') ? { supportsTools: false } : {})
  }));
  let output = text;
  for (const [field, setting] of Object.entries({ baseUrl: value.baseUrl, apiKey: value.apiKey, api: 'openai-completions', auth: 'apiKey' })) {
    output = yamlSet(output, ['providers', id, field], [JSON.stringify(setting)]);
  }
  return yamlSet(output, ['providers', id, 'models'], [JSON.stringify(models)]);
}
// A deliberately small YAML editing surface, not a general-purpose YAML parser.
// Traversed mappings must be block maps with plain keys and two-space indentation.
// Unrelated blocks are kept byte-for-byte; aliases/anchors/tags/merge keys and
// document streams are refused because their effective values are ambiguous.
function yamlSet(text, keys, replacement) {
  if (/\t|(^|\n)\s*(?:---|\.\.\.|%|<<:)|(?:^|[\s:[,{])[&*!][A-Za-z_]/m.test(text)) fail('Сложный YAML с якорями, тегами, слиянием, границами документов или табуляцией не изменяется.');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.at(-1) === '') lines.pop();
  function update(start, end, depth, index) {
    const indent = depth * 2;
    const key = keys[index];
    const matches = [];
    for (let i = start; i < end; i++) {
      if (!lines[i].trim() || lines[i].trimStart().startsWith('#')) continue;
      const spaces = lines[i].match(/^ */)[0].length;
      if (spaces < indent) fail('Неподдерживаемые отступы YAML.');
      if (spaces === indent) {
        const entry = lines[i].match(/^ *([A-Za-z_][\w-]*):(?:\s+(.*))?\s*$/);
        if (!entry) fail('Поддерживаются только блочные структуры YAML с простыми ключами.');
        if (entry[1] === key) matches.push(i);
      }
    }
    if (matches.length > 1) fail('Ключ конфигурации повторяется; файл не изменён.');
    let at = matches[0];
    if (at === undefined) {
      const body = keys.slice(index).map((k, offset) => `${' '.repeat(indent + offset * 2)}${k}:`);
      body[body.length - 1] += replacement.length === 1 ? ` ${replacement[0]}` : '';
      if (replacement.length !== 1) body.push(...replacement.map(row => `${' '.repeat(indent + (keys.length - index) * 2)}${row}`));
      lines.splice(end, 0, ...body);
      return;
    }
    let stop = at + 1;
    while (stop < end && (!lines[stop].trim() || lines[stop].trimStart().startsWith('#') || lines[stop].match(/^ */)[0].length > indent)) stop++;
    // Comments/blanks following a value belong to the next sibling, not our key.
    while (stop > at + 1 && (!lines[stop - 1].trim() || lines[stop - 1].trimStart().startsWith('#'))) stop--;
    if (index < keys.length - 1) {
      if (!new RegExp(`^ {${indent}}${key}:\\s*(?:#.*)?$`).test(lines[at])) fail('Нельзя расширить однострочную структуру YAML; файл не изменён.');
      update(at + 1, stop, depth + 1, index + 1);
    } else {
      const prefix = `${' '.repeat(indent)}${key}:`;
      const body = replacement.length === 1 ? [`${prefix} ${replacement[0]}`] : [prefix, ...replacement.map(row => `${' '.repeat(indent + 2)}${row}`)];
      lines.splice(at, stop - at, ...body);
    }
  }
  update(0, lines.length, 0, 0);
  return `${lines.join(newline)}${newline}`;
}
function yamlScalar(value) {
  const text = value.trim();
  if (text.startsWith('"')) {
    const quoted = text.match(/^"(?:[^"\\]|\\.)*"(?=\s*(?:#.*)?$)/)?.[0];
    try { if (quoted) return JSON.parse(quoted); } catch {}
    fail('Сложный YAML со списком моделей не изменяется.');
  }
  if (text.startsWith("'")) {
    const quoted = text.match(/^'(?:[^']|'')*'(?=\s*(?:#.*)?$)/)?.[0];
    if (quoted) return quoted.slice(1, -1).replaceAll("''", "'");
    fail('Сложный YAML со списком моделей не изменяется.');
  }
  const plain = text.replace(/\s+#.*$/, '').trim();
  if (!plain || /[{}[\],]|:\s/.test(plain) || /^(?:null|true|false|~|[-+]?\d+(?:\.\d+)?)$/i.test(plain)) fail('Сложный YAML со списком моделей не изменяется.');
  return plain;
}
function yamlList(text, key) {
  const lines = text.split(/\r?\n/);
  const match = new RegExp(`^${key}:\\s*(.*)$`);
  const matches = lines.flatMap((line, index) => match.test(line) ? [index] : []);
  if (!matches.length) return null;
  if (matches.length !== 1) fail('Ключ конфигурации повторяется; файл не изменён.');
  const at = matches[0];
  const inline = lines[at].match(match)[1].trim().replace(/\s+#.*$/, '').trim();
  if (inline && !inline.startsWith('#')) {
    if (!inline.startsWith('[') || !inline.endsWith(']')) fail(`YAML ${key} должен быть простым списком.`);
    try { const value = JSON.parse(inline); if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value; } catch {}
    const body = inline.slice(1, -1).trim();
    if (/["']/.test(body)) fail(`YAML ${key}: сложный inline список не изменяется.`);
    return body ? body.split(',').map(yamlScalar) : [];
  }
  const result = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (!lines[i].trim() || lines[i].trimStart().startsWith('#')) continue;
    if (/^\S/.test(lines[i]) && !lines[i].startsWith('-')) break;
    if (!/^  -\s+/.test(lines[i])) fail(`YAML ${key}: сложные или path-scoped списки не изменяются.`);
    result.push(yamlScalar(lines[i].replace(/^  -\s+/, '')));
  }
  return result;
}
function addYamlAllowlist(text, models, providerId = 'wikivibe') {
  let next = text;
  for (const [key, values, remove] of [
    ['enabledModels', models.map(({ id }) => `${providerId}/${id}`), false],
    ['enabledProviders', [providerId], false],
    ['disabledProviders', [providerId], true]
  ]) {
    const entries = yamlList(next, key);
    if (entries === null || (!remove && entries.length === 0)) continue;
    const merged = remove ? entries.filter(item => !values.includes(item)) : [...entries, ...values.filter(item => !entries.includes(item))];
    if (JSON.stringify(merged) !== JSON.stringify(entries)) next = yamlSet(next, [key], [JSON.stringify(merged)]);
  }
  return next;
}
function tomlConfig(text, value, merge = false) {
  if (text.includes('"""') || text.includes("'''")) fail('Многострочные строки TOML не изменяются автоматически.');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.at(-1) === '') lines.pop();
  let rootEnd = lines.findIndex(line => /^\s*\[/.test(line));
  if (rootEnd < 0) rootEnd = lines.length;
  for (let i = 0; i < rootEnd; i++) {
    if (/^\s*(?:#|$)/.test(lines[i])) continue;
    if (!/^\s*[A-Za-z_][\w-]*\s*=/.test(lines[i])) fail('Сложные ключи в корне TOML не изменяются автоматически.');
    if (/^\s*model_providers(?:\s*=|\.)/.test(lines[i])) fail('model_providers в однострочной таблице TOML или с точечными ключами не изменяется.');
  }
  const matches = [];
  for (let i = rootEnd; i < lines.length; i++) {
    if (/^\s*\[\s*model_providers\s*\.\s*(?:wikivibe(?=\s*(?:\.|\]))|["']wikivibe["'])/.test(lines[i])) matches.push(i);
    if (/^\s*\[\s*["']model_providers/.test(lines[i])) fail('Ключи поставщиков TOML в кавычках не изменяются.');
  }
  if (matches.length > 1) fail('Несколько блоков model_providers.wikivibe в TOML; файл не изменён.');
  if (matches.length) {
    if (!merge) fail('Конфликт: поставщик wikivibe уже существует в TOML.');
    // A file edited after the plugin wrote it cannot be regenerated from the
    // original without dropping those edits, so only the plugin's own block is
    // rewritten: the provider, wire protocol and endpoint must still be ours.
    const start = matches[0];
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    const block = lines.slice(start, end);
    const field = key => block.find(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
    const name = field('name'), base = field('base_url'), wire = field('wire_api'), token = field('experimental_bearer_token');
    const endpoint = base?.trim().match(/^base_url\s*=\s*"([^"]*)"$/)?.[1];
    if (!name || !base || !wire || !token || !/^name\s*=\s*"WikiVibe"$/.test(name.trim()) || !/^wire_api\s*=\s*"responses"$/.test(wire.trim()) || !ENDPOINTS.has(endpoint)) fail('Конфликт: поставщик wikivibe в TOML не принадлежит плагину; файл не изменён.');
    block[block.indexOf(base)] = `base_url = ${JSON.stringify(value.baseUrl)}`;
    block[block.indexOf(token)] = `experimental_bearer_token = ${JSON.stringify(value.apiKey)}`;
    return `${[...lines.slice(0, start), ...block, ...lines.slice(end)].join(newline)}${newline}`;
  }
  const block = ['[model_providers.wikivibe]', 'name = "WikiVibe"', `base_url = ${JSON.stringify(value.baseUrl)}`, 'wire_api = "responses"', `experimental_bearer_token = ${JSON.stringify(value.apiKey)}`];
  lines.push('', ...block);
  return `${lines.join(newline)}${newline}`;
}

// Required Codex ModelInfo fields are client metadata, not gateway capabilities.
// Do not fabricate reasoning, image support, prices or context limits from an ID.
function codexCatalog(models) {
  return { models: models.map(({ id }, priority) => ({
    slug: id, display_name: `WikiVibe · ${id}`, description: 'WikiVibe; совместимость Responses и инструментов не проверена.',
    default_reasoning_level: null, supported_reasoning_levels: [], shell_type: 'shell_command',
    visibility: 'list', supported_in_api: true, priority, availability_nux: null, upgrade: null,
    base_instructions: 'You are a coding assistant running in Codex. Follow the user request and repository instructions, use the available tools to complete the task, preserve unrelated user changes, and report the changes and actual verification performed.',
    support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
    supports_reasoning_summary_parameter: false, truncation_policy: { mode: 'bytes', limit: 10000 },
    supports_reasoning_summaries: false, supports_parallel_tool_calls: false,
    experimental_supported_tools: [], input_modalities: hasImageInput(id) ? ['text', 'image'] : ['text']
  })) };
}
function render(agent, rel, bytes, value, root, merge = false, providerId = 'wikivibe') {
  const text = bytes?.toString('utf8') ?? '';
  if (agent.id === 'opencode') return openCodeConfig(text, value);
  if (agent.id === 'codex') {
    // These two files exist only for the plugin: an edit inside them cannot be
    // separated from plugin content, so an edited file is never overwritten.
    if (rel.endsWith('wikivibe-models.json')) {
      if (bytes !== null) fail(merge ? conflict(agent.label) : 'Codex: файл wikivibe-models.json уже существует и не принадлежит плагину.');
      return json(codexCatalog(value.models));
    }
    if (rel.endsWith('wikivibe.config.toml')) {
      if (bytes !== null) fail(merge ? conflict(agent.label) : 'Codex: профиль wikivibe уже существует и не принадлежит плагину.');
      return `model_provider = "wikivibe"\nmodel_catalog_json = ${JSON.stringify(path.join(root, '.codex/wikivibe-models.json'))}\n`;
    }
    return tomlConfig(text, value, merge);
  }
  if (agent.id === 'aider') {
    if (rel.endsWith('.metadata.json')) {
      const metadata = parseJSON(bytes);
      for (const { id } of value.models) {
        const name = `openai/${id}`;
        if (own(metadata, name) && !(merge && pluginMetadata(metadata[name]))) fail('Aider: метаданные модели уже существуют и не принадлежат плагину.');
        Object.defineProperty(metadata, name, { value: { litellm_provider: 'openai', mode: 'chat' }, enumerable: true });
      }
      return json(metadata);
    }
    let next = text;
    for (const [key, setting] of Object.entries({ 'openai-api-base': value.baseUrl, 'openai-api-key': value.apiKey })) next = yamlSet(next, [key], [JSON.stringify(setting)]);
    return next;
  }
  if (agent.id === 'omp') {
    if (/\/config\.ya?ml$/.test(rel)) return addYamlAllowlist(text, value.models, providerId);
    return ompModels(text, value);
  }
  const config = parseJSON(bytes);
  switch (agent.id) {
    case 'claude': {
      const env = child(config, 'env');
      if (own(config, 'apiKeyHelper') || own(env, 'ANTHROPIC_API_KEY') || Object.keys(env).some(key => key.startsWith('CLAUDE_CODE_USE_'))) fail('Claude Code: существующий apiKeyHelper, ANTHROPIC_API_KEY или настройка облачного поставщика конфликтует с WikiVibe; файл не изменён.');
      const picker = child(config, 'modelPicker');
      if (own(picker, 'options') && (!Array.isArray(picker.options) || picker.options.some(row => !object(row) || typeof row.model !== 'string'))) fail('Claude Code: modelPicker.options должен быть массивом моделей.');
      // Merge keeps the user's own picker rows and replaces only plugin-labelled ones.
      const options = (picker.options ?? []).filter(row => !(merge && typeof row.label === 'string' && row.label.startsWith('WikiVibe · ')));
      if (options.some(row => value.models.some(model => model.id === row.model))) fail('Claude Code: модель уже существует в пользовательском modelPicker.');
      picker.options = [...options, ...value.models.map(({ id }) => ({ model: id, label: `WikiVibe · ${id}` }))];
      picker.replaceBuiltInOptions = true;
      expandAllowlist(config, 'availableModels', value.models.map(({ id }) => id));
      env.ANTHROPIC_BASE_URL = value.baseUrl.slice(0, -3);
      env.ANTHROPIC_AUTH_TOKEN = value.apiKey;
      break;
    }
    case 'pi':
      if (rel.endsWith('settings.json')) {
        expandAllowlist(config, 'enabledModels', value.models.map(({ id }) => `wikivibe/${id}`));
      } else {
        const providers = child(config, 'providers');
        const existing = merge ? providers.wikivibe?.models : [];
        if (merge && existing !== undefined && !Array.isArray(existing)) fail('Pi: models должен быть массивом.');
        provider(providers, 'wikivibe', { baseUrl: value.baseUrl, api: 'openai-completions', apiKey: value.apiKey, models: value.models.map(({ id }) => ({ ...existing?.find(row => row.id === id), id, ...(hasImageInput(id) ? { input: ['text', 'image'] } : {}) })) }, merge);
      }
      break;
    case 'qwen': {
      const providers = child(config, 'modelProviders');
      if (!own(providers, 'openai')) providers.openai = [];
      if (!Array.isArray(providers.openai) || providers.openai.some(entry => !object(entry))) fail('Qwen Code: modelProviders.openai должен быть массивом объектов.');
      // Merge drops the plugin's own entries (identified by its env key) and keeps the rest.
      const kept = merge ? providers.openai.filter(entry => entry.envKey !== 'WIKIVIBE_API_KEY') : providers.openai;
      if (kept.some(entry => entry.envKey === 'WIKIVIBE_API_KEY' || value.models.some(model => model.id === entry.id))) fail('Qwen Code: идентификатор модели или ключ уже используется другим поставщиком.');
      const previous = merge ? providers.openai.filter(entry => entry.envKey === 'WIKIVIBE_API_KEY') : [];
      providers.openai = [...kept, ...value.models.map(({ id }) => ({ ...previous.find(entry => entry.id === id), id, name: `WikiVibe · ${id}`, baseUrl: value.baseUrl, envKey: 'WIKIVIBE_API_KEY' }))];
      const env = child(config, 'env');
      if (own(env, 'WIKIVIBE_API_KEY') && !merge) fail('Qwen Code: переменная WIKIVIBE_API_KEY уже существует.');
      env.WIKIVIBE_API_KEY = value.apiKey;
      break;
    }
  }
  return json(config);
}

function warnings(agents) {
  return [
    'Ключ будет записан открытым текстом в конфигурацию выбранных агентов. Резервные копии могут содержать прежние ключи и другие секреты. Права файлов — 0600, каталога копий — 0700.',
    'Применение заменяет прежние ключ и endpoint маршрутов WikiVibe настройками плагина. Полный каталог принадлежит именно этому ключу; прежние маршруты доступны в резервной копии. Другие провайдеры и активные модели не переключаются.',
    'Плагин меняет только стандартные файлы в локальном домашнем каталоге; настройки действуют для новых сессий. Настройки проекта, переменные окружения, параметры запуска, управляемые настройки и выбранный профиль Orca (CLAUDE_CONFIG_DIR/CODEX_HOME) могут переопределить их. SSH и WSL не настраиваются. Установка агента не проверяется.',
    'OpenCode JSONC сохраняет комментарии вне изменяемого каталога. Сложные YAML/TOML не изменяются. Cursor, Windsurf, Antigravity и закрытые форматы исключены. Каждый файл изменяется отдельно: общей транзакции для всех файлов нет.',
    'Каталог WikiVibe содержит только модели из авторизованного /models. Выбор модели остаётся в агенте; текущие модель и поставщик сохраняются. Старые настройки выбора, записанные самим плагином, возвращаются к исходным при обновлении.',
    'Существующие Claude availableModels, Pi/OMP enabledModels и OMP enabledProviders/OpenCode enabled_providers расширяются только моделями или поставщиком WikiVibe. Из OMP disabledProviders/OpenCode disabled_providers удаляется только wikivibe. Остальные ограничения сохраняются. Управляемые политики и настройки проекта не меняются и могут скрывать модели. Встроенные модели других поставщиков не означают доступ по ключу WikiVibe. Claude и Aider используют общий endpoint; выберите доступную модель внутри агента.',
    ...agents.map(agent => `${agent.label}: ${agent.protocol}. Каталог /models не подтверждает поддержку протокола, потоковых ответов, инструментов, контекстного окна или reasoning. ${agent.description}`)
  ];
}

async function homeRoot(home) {
  const root = await fs.realpath(path.resolve(home));
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) fail('Домашний каталог недоступен или принадлежит другому пользователю.');
  return root;
}
function checkOwner(stat, directory = false) {
  if ((process.getuid && stat.uid !== process.getuid()) || stat.isSymbolicLink() || (directory ? !stat.isDirectory() || Boolean(stat.mode & 0o022) : !stat.isFile() || stat.nlink !== 1)) fail('Небезопасный путь конфигурации: символическая или жёсткая ссылка, неподходящий владелец, тип файла или права каталога.');
}
async function directories(root, target, create = false) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('Путь выходит за домашний каталог.');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(current);
    }
    checkOwner(stat, true);
  }
  return true;
}
async function snapshot(root, target) {
  if (!await directories(root, path.dirname(target))) return null;
  let handle;
  try {
    const before = await fs.lstat(target);
    checkOwner(before);
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    checkOwner(stat);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > 2 * 1024 * 1024) fail('Файл конфигурации изменился во время чтения или превышает 2 МБ.');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) fail('Файл конфигурации изменился во время чтения.');
    return { bytes, hash: hash(bytes), mode: stat.mode & 0o777, ino: stat.ino, dev: stat.dev };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
function same(a, b) { return a === null ? b === null : b !== null && a.hash === b.hash && a.mode === b.mode && a.ino === b.ino && a.dev === b.dev; }
async function replace(root, target, bytes, expected, mode = 0o600) {
  await directories(root, path.dirname(target), true);
  const temporary = path.join(path.dirname(target), `.wikivibe-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', mode);
    await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); await handle.close(); handle = null;
    if (!same(expected, await snapshot(root, target))) fail('Конфликт: файл или права изменились после чтения; пользовательские изменения сохранены.');
    if (expected === null) {
      // link is exclusive, unlike rename: never overwrite a file created meanwhile.
      await fs.link(temporary, target); await fs.unlink(temporary);
    } else await fs.rename(temporary, target);
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
function backupPath(root, target) { return path.join(path.dirname(target), BACKUPS, `${path.basename(target)}.json`); }
async function readBackup(root, agent, rel, target) {
  const location = backupPath(root, target);
  const saved = await snapshot(root, location);
  if (!saved) return null;
  if (saved.mode !== 0o600 || (await fs.lstat(path.dirname(location))).mode % 512 !== 0o700) fail('Небезопасные права резервной копии; восстановление остановлено.');
  let record;
  try { record = JSON.parse(saved.bytes.toString('utf8')); }
  catch { fail('Резервная копия повреждена; конфигурация не изменена.'); }
  if (!object(record) || record.version !== 1 || record.agentId !== agent.id || record.rel !== rel || !['active', 'pending', 'restoring'].includes(record.state) || !/^[a-f0-9]{64}$/.test(record.appliedHash) || !(record.original === null || object(record.original))) fail('Резервная копия не принадлежит этому адаптеру.');
  if (record.original !== null && (typeof record.original.base64 !== 'string' || !Number.isInteger(record.original.mode) || record.original.mode < 0 || record.original.mode > 0o777 || hash(Buffer.from(record.original.base64, 'base64')) !== record.original.hash)) fail('Резервная копия повреждена.');
  if (record.state === 'pending' && !/^[a-f0-9]{64}$/.test(record.nextHash)) fail('Резервная копия повреждена.');
  return { location, saved, record };
}
function owned(current, record) {
  if (current?.hash === record.appliedHash && current.mode === 0o600) return true;
  if (record.state === 'restoring') return record.original === null ? current === null : current?.hash === record.original.hash && current.mode === record.original.mode;
  if (record.state !== 'pending') return false;
  if (current?.hash === record.nextHash && current.mode === 0o600) return true;
  return record.original === null ? current === null : current?.hash === record.original.hash && current.mode === record.original.mode;
}
async function nativePaths(root, agent) {
  if (agent.id === 'opencode') {
    const jsonc = '.config/opencode/opencode.jsonc';
    const a = await snapshot(root, path.join(root, agent.rel));
    const b = await snapshot(root, path.join(root, jsonc));
    if (a && b) fail('OpenCode: одновременно существуют opencode.json и opencode.jsonc; устраните неоднозначность.');
    return [b ? jsonc : agent.rel];
  }
  if (agent.id === 'codex') return [agent.rel, '.codex/wikivibe-models.json', '.codex/wikivibe.config.toml'];
  if (agent.id === 'aider') return [agent.rel, '.aider.model.metadata.json'];
  if (agent.id === 'pi') return [agent.rel, '.pi/agent/settings.json'];
  if (agent.id !== 'omp') return [agent.rel];
  const result = [];
  for (const name of ['models', 'config']) {
    const yml = `.omp/agent/${name}.yml`, yaml = `.omp/agent/${name}.yaml`;
    const a = await snapshot(root, path.join(root, yml));
    const b = await snapshot(root, path.join(root, yaml));
    if (a && b) fail('oh-my-pi: одновременно существуют файлы .yml и .yaml; устраните неоднозначность вручную.');
    result.push(a ? yml : b ? yaml : yml);
  }
  if (await snapshot(root, path.join(root, '.omp/agent/models.json'))) fail('oh-my-pi: плагин не переносит настройки из устаревшего models.json; используйте штатный формат YAML.');
  return result;
}
async function plans(root, agents, value, restore = false) {
  const result = [];
  const failures = [];
  for (const agent of agents) {
    const agentPlans = [];
    try {
      // Restore looks at both supported YAML spellings, independent of which exists now.
      const rels = restore ? agent.id === 'opencode' ? [agent.rel, '.config/opencode/opencode.jsonc'] : agent.id === 'omp' ? ['.omp/agent/models.yml', '.omp/agent/models.yaml', '.omp/agent/config.yml', '.omp/agent/config.yaml'] : agent.id === 'pi' ? [agent.rel, '.pi/agent/settings.json'] : agent.id === 'codex' ? [agent.rel, '.codex/wikivibe-models.json', '.codex/wikivibe.config.toml'] : agent.id === 'aider' ? [agent.rel, '.aider.model.metadata.json'] : [agent.rel] : await nativePaths(root, agent);
      for (const rel of rels) {
        const target = path.join(root, rel);
        const current = await snapshot(root, target);
        const backup = await readBackup(root, agent, rel, target);
        const exact = backup ? owned(current, backup.record) : false;
        if (restore) {
          if (backup && (!exact || backup.record.preserveEdits)) fail(conflict(agent.label));
          if (backup) agentPlans.push({ agent, rel, target, current, backup });
          continue;
        }
        if (backup && backup.record.state !== 'active') fail('Незавершённая операция: сначала восстановите конфигурацию.');
        // Regenerating from the original removes stale plugin models and legacy
        // defaults, but it would also drop later user edits. When the file is no
        // longer exactly what the plugin wrote, the plan merges into the current
        // file instead: unrelated edits must never block key rotation.
        const merge = Boolean(backup) && (!exact || backup.record.preserveEdits === true);
        if (merge && current === null) fail(`${agent.label}: файл удалён после применения. Восстановите резервную копию или создайте файл заново.`);
        const filters = agent.id === 'pi' && rel.endsWith('settings.json') || agent.id === 'omp' && /\/config\.ya?ml$/.test(rel);
        const baseline = backup && !merge ? backup.record.original === null ? null : Buffer.from(backup.record.original.base64, 'base64') : current?.bytes ?? null;
        if (filters) {
          const hasFilters = agent.id === 'pi' ? own(parseJSON(baseline), 'enabledModels') : ['enabledModels', 'enabledProviders', 'disabledProviders'].some(key => yamlList(baseline?.toString('utf8') ?? '', key) !== null);
          if (!hasFilters) { if (backup && !merge) agentPlans.push({ agent, rel, target, current, backup, cleanup: true }); continue; }
        }
        let providerId = 'wikivibe';
        if (agent.id === 'omp' && filters) {
          const modelPlan = agentPlans.find(plan => /\/models\.ya?ml$/.test(plan.rel));
          if (modelPlan) {
            const config = parseDocument(modelPlan.bytes.toString('utf8')).toJS({ maxAliasCount: 0 });
            providerId = Object.entries(config.providers).find(([, entry]) => wikiRoute(entry?.baseUrl))[0];
          }
        }
        const bytes = Buffer.from(render(agent, rel, baseline, value, root, merge, providerId));
        const backupDir = path.dirname(backupPath(root, target));
        if (await directories(root, backupDir) && (await fs.lstat(backupDir)).mode % 512 !== 0o700) fail('Каталог резервных копий должен иметь права 0700.');
        agentPlans.push({ agent, rel, target, current, backup, bytes, filters, merge });
      }
      result.push(...agentPlans);
    } catch (error) {
      // An agent is planned as a whole: one blocked or malformed file keeps its
      // other files untouched, but never voids the rest of the selection.
      failures.push({ agentId: agent.id, message: error instanceof Error ? error.message : 'Операция не выполнена.' });
    }
  }
  return { plans: result, failures };
}

async function restorePlan(root, plan) {
  plan.backup.record.state = 'restoring';
  await replace(root, plan.backup.location, Buffer.from(json(plan.backup.record)), plan.backup.saved);
  plan.backup.saved = await snapshot(root, plan.backup.location);
  const original = plan.backup.record.original;
  if (original === null) {
    if (!same(plan.current, await snapshot(root, plan.target))) fail('Конфликт: файл изменился во время восстановления.');
    if (plan.current) await fs.unlink(plan.target);
  } else await replace(root, plan.target, Buffer.from(original.base64, 'base64'), plan.current, original.mode);
  if (!same(plan.backup.saved, await snapshot(root, plan.backup.location))) fail('Конфликт: резервная копия изменилась во время восстановления.');
  await fs.unlink(plan.backup.location);
}

// One lane per home in this process; the exclusive file also excludes other
// plugin processes. A crash can leave the lock: do not steal a possibly live lock.
const lanes = new Map();
async function mutation(home, operation) {
  const root = await homeRoot(home);
  const previous = lanes.get(root) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const lock = path.join(root, '.wikivibe-gateway.lock');
    let handle;
    try {
      try { handle = await fs.open(lock, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('Другая операция ещё выполняется или после сбоя остался файл блокировки .wikivibe-gateway.lock. Закройте плагин перед ручным удалением этого файла.'); throw error; }
      await handle.writeFile(`${process.pid}\n`);
      return await operation(root);
    } finally { if (handle) { await handle.close(); await fs.unlink(lock); } }
  });
  lanes.set(root, pending);
  try { return await pending; }
  finally { if (lanes.get(root) === pending) lanes.delete(root); }
}

export async function listAgents({ home = homedir() } = {}) {
  const root = path.resolve(home);
  return Promise.all(AGENTS.map(async ({ rel, protocol, ...agent }) => {
    // Backup presence is the durable opt-in marker, not proof of effective routing.
    let managed = false;
    for (const file of managedPaths({ ...agent, rel })) {
      try { await fs.lstat(backupPath(root, path.join(root, file))); managed = true; }
      catch (error) { if (error.code !== 'ENOENT') managed = true; }
    }
    return { ...agent, available: true, managed, configPath: path.join(root, rel) };
  }));
}
function managedPaths(agent) {
  if (agent.id === 'opencode') return [agent.rel, '.config/opencode/opencode.jsonc'];
  if (agent.id === 'omp') return ['.omp/agent/models.yml', '.omp/agent/models.yaml', '.omp/agent/config.yml', '.omp/agent/config.yaml'];
  if (agent.id === 'codex') return [agent.rel, '.codex/wikivibe-models.json', '.codex/wikivibe.config.toml'];
  if (agent.id === 'pi') return [agent.rel, '.pi/agent/settings.json'];
  if (agent.id === 'aider') return [agent.rel, '.aider.model.metadata.json'];
  return [agent.rel];
}
export async function syncManagedAgents(value, options = {}) {
  const agents = (await listAgents(options)).filter(agent => agent.managed);
  if (!agents.length) return { applied: [], failures: [], outcomes: [], warnings: [] };
  const failures = [];
  const eligible = [];
  try {
    const root = await homeRoot(options.home ?? homedir());
    for (const agent of agents) {
      const native = AGENTS.find(entry => entry.id === agent.id);
      try {
        const paths = await nativePaths(root, native);
        let verified = false;
        for (const rel of managedPaths(native)) {
          const backup = await readBackup(root, native, rel, path.join(root, rel));
          if (!backup) continue;
          if (!paths.includes(rel)) fail('Путь управляемой конфигурации изменился; требуется ручное применение.');
          verified = true;
        }
        if (!verified) fail('Не найдена действительная резервная копия плагина.');
        eligible.push(agent.id);
      } catch {
        failures.push({ agentId: agent.id, message: 'Управляемая конфигурация или резервная копия недоступна либо изменила путь. Файлы агента не обновлены.' });
      }
    }
    const result = eligible.length ? await applyAgents(eligible, value, options) : { applied: [], failures: [], outcomes: [], warnings: [] };
    return { ...result, failures: [...failures, ...result.failures] };
  }
  catch {
    return { applied: [], outcomes: [], warnings: [], failures: agents.map(agent => ({ agentId: agent.id, message: 'Настройки сохранены, но синхронизация недоступна. Повторите применение к агенту.' })) };
  }
}
export async function previewAgents(agentIds, value, { home = homedir() } = {}) {
  const agents = selected(agentIds); preferences(value);
  const root = await homeRoot(home);
  const { plans: changes, failures } = await plans(root, agents, { ...value, apiKey: value.apiKey ?? 'preview-redacted' });
  return { changes: changes.map(plan => ({ agentId: plan.agent.id, path: plan.target, description: `${plan.agent.label}: ${plan.cleanup ? 'восстановление прежних настроек выбора' : plan.merge ? 'обновление маршрута WikiVibe в изменённом файле, остальные настройки сохраняются' : plan.filters ? 'расширение фильтров только для WikiVibe' : 'установка полного доступного каталога'}, ${plan.agent.protocol}. Плагин сохранит резервную копию. Восстановление доступно, только если файл не изменится после применения.`, secretOnDisk: !plan.cleanup && !plan.filters && !plan.rel.endsWith('wikivibe-models.json') && !plan.rel.endsWith('wikivibe.config.toml') && !plan.rel.endsWith('.metadata.json') })), failures, warnings: warnings(agents) };
}
export async function applyAgents(agentIds, value, { home = homedir() } = {}) {
  const agents = selected(agentIds); preferences(value, true);
  return mutation(home, async root => {
    const { plans: changes, failures } = await plans(root, agents, value);
    const applied = [];
    const blocked = failures.slice();
    for (const plan of changes) {
      if (blocked.some(item => item.agentId === plan.agent.id)) continue;
      try {
        if (plan.cleanup) { await restorePlan(root, plan); applied.push({ agentId: plan.agent.id, path: plan.target }); continue; }
        const location = backupPath(root, plan.target);
        await directories(root, path.dirname(location), true);
        if ((await fs.lstat(path.dirname(location))).mode % 512 !== 0o700) fail('Каталог резервных копий должен иметь права 0700.');
        const original = plan.backup?.record.original ?? (plan.current === null ? null : { base64: plan.current.bytes.toString('base64'), hash: plan.current.hash, mode: plan.current.mode });
        // null is meaningful: reapplying must not turn an originally absent file
        // into an original containing the previously written secret.
        const record = { version: 1, agentId: plan.agent.id, rel: plan.rel, original: plan.backup ? plan.backup.record.original : original, state: 'pending', appliedHash: plan.backup?.record.appliedHash ?? plan.current?.hash ?? hash(Buffer.alloc(0)), nextHash: hash(plan.bytes) };
        if (plan.merge || plan.backup?.record.preserveEdits) record.preserveEdits = true;
        await replace(root, location, Buffer.from(json(record)), plan.backup?.saved ?? null);
        await replace(root, plan.target, plan.bytes, plan.current);
        const saved = await snapshot(root, location);
        record.state = 'active'; record.appliedHash = record.nextHash; delete record.nextHash;
        await replace(root, location, Buffer.from(json(record)), saved);
        applied.push({ agentId: plan.agent.id, path: plan.target });
      } catch (error) {
        // Each file is written on its own; one blocked agent keeps the others working.
        blocked.push({ agentId: plan.agent.id, message: error instanceof Error ? error.message : 'Файл не изменён.' });
      }
    }
    const appliedIds = new Set(applied.map(item => item.agentId));
    return { applied, failures: blocked, outcomes: agents.filter(agent => appliedIds.has(agent.id) && !blocked.some(item => item.agentId === agent.id)).map(agent => ({ agentId: agent.id, modelCount: value.models.length, pickerVerified: false, nextStep: agent.id === 'codex' ? 'Откройте codex -p wikivibe, затем /model.' : `Откройте новую сессию и ${agent.id === 'opencode' ? '/models' : '/model'}.` })), warnings: warnings(agents) };
  });
}
export async function restoreAgents(agentIds, { home = homedir() } = {}) {
  const agents = selected(agentIds);
  return mutation(home, async root => {
    const { plans: changes, failures } = await plans(root, agents, undefined, true);
    const restored = [];
    const blocked = failures.slice();
    for (const plan of changes) {
      try { await restorePlan(root, plan); restored.push({ agentId: plan.agent.id, path: plan.target }); }
      catch (error) { blocked.push({ agentId: plan.agent.id, message: error instanceof Error ? error.message : 'Файл не восстановлен.' }); }
    }
    return { restored, failures: blocked };
  });
}
