import { homedir } from 'node:os';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

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
// Only default user paths and our opt-in Codex profile are managed. JSONC,
// complex YAML/TOML, other profiles and closed agents are not rewritten.
const ENDPOINTS = new Set(['https://api.wikivibe.dev/v1', 'https://vapi.wikivibe.dev/v1']);
const BACKUPS = '.wikivibe-gateway-backups';
const AGENTS = [
  { id: 'claude', label: 'Claude Code', rel: '.claude/settings.json', protocol: 'Anthropic Messages', description: 'В ~/.claude/settings.json: env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN и полный modelPicker (Claude Code ≥ 2.1.242). Отдельный поставщик WikiVibe не поддерживается: шлюз заменяет Anthropic endpoint. Текущая модель не меняется; выбор через /model.' },
  { id: 'codex', label: 'Codex', rel: '.codex/config.toml', protocol: 'OpenAI Responses', description: 'Регистрация model_providers.wikivibe в ~/.codex/config.toml; ~/.codex/wikivibe.config.toml и wikivibe-models.json — отдельный полный каталог. Пользователь включает профиль штатно: codex -p wikivibe, затем /model. Базовые model/model_provider не меняются. Нужна версия с профильными файлами и model_catalog_json; Desktop/Orca picker не гарантируется.' },
  { id: 'opencode', label: 'OpenCode', rel: '.config/opencode/opencode.json', protocol: 'OpenAI Chat Completions', description: 'В ~/.config/opencode/opencode.json: provider.wikivibe с options.baseURL, options.apiKey и всеми models через @ai-sdk/openai-compatible. Текущая model не меняется; выбор через /models. JSONC не изменяется.' },
  { id: 'pi', label: 'Pi', rel: '.pi/agent/models.json', protocol: 'OpenAI Chat Completions', description: 'В ~/.pi/agent/models.json: providers.wikivibe с baseUrl, apiKey, api = openai-completions и всеми models. settings.json/defaultProvider/defaultModel не меняются; выбор через /model.' },
  { id: 'omp', label: 'oh-my-pi', rel: '.omp/agent/models.yml', protocol: 'OpenAI Chat Completions', description: 'В ~/.omp/agent/models.yml: providers.wikivibe с baseUrl, apiKey, api = openai-completions и всеми models. Поддерживается .yaml и простой YAML. config.yml/modelRoles не меняются; выбор через /model.' },
  { id: 'aider', label: 'Aider', rel: '.aider.conf.yml', protocol: 'OpenAI Chat Completions', description: 'В ~/.aider.conf.yml: openai-api-base и openai-api-key; ~/.aider.model.metadata.json регистрирует весь каталог для /models. Отдельного поставщика WikiVibe нет: используется openai/<id>, общий OpenAI endpoint заменяется. Текущая model не меняется; выбор через /model openai/<id>. /models также показывает встроенные модели LiteLLM, не подтверждённые ключом; лимиты и цены неизвестны.' },
  { id: 'qwen', label: 'Qwen Code', rel: '.qwen/settings.json', protocol: 'OpenAI Chat Completions', description: 'В ~/.qwen/settings.json: все доступные modelProviders.openai с меткой WikiVibe и env.WIKIVIBE_API_KEY. WikiVibe — метка в группе протокола OpenAI, не отдельный тип auth. Текущие model.name/security.auth не меняются; при необходимости /auth, затем /model.' }
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
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
function provider(parent, key, value) {
  if (own(parent, key)) fail('Конфликт: поставщик wikivibe уже существует и не принадлежит плагину.');
  parent[key] = value;
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
function tomlConfig(text, value) {
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
    if (/^\s*\[.*(?:["']wikivibe["']|\bwikivibe\b)/.test(lines[i])) matches.push(i);
    if (/^\s*\[\s*["']model_providers/.test(lines[i])) fail('Ключи поставщиков TOML в кавычках не изменяются.');
  }
  if (matches.length) fail('Конфликт: поставщик wikivibe уже существует в TOML.');
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
    experimental_supported_tools: [], input_modalities: ['text']
  })) };
}
function render(agent, rel, bytes, value, root) {
  const text = bytes?.toString('utf8') ?? '';
  if (agent.id === 'codex') {
    if (rel.endsWith('wikivibe-models.json')) {
      if (bytes !== null) fail('Codex: файл wikivibe-models.json уже существует и не принадлежит плагину.');
      return json(codexCatalog(value.models));
    }
    if (rel.endsWith('wikivibe.config.toml')) {
      if (bytes !== null) fail('Codex: профиль wikivibe уже существует и не принадлежит плагину.');
      return `model_provider = "wikivibe"\nmodel_catalog_json = ${JSON.stringify(path.join(root, '.codex/wikivibe-models.json'))}\n`;
    }
    return tomlConfig(text, value);
  }
  if (agent.id === 'aider') {
    if (rel.endsWith('.metadata.json')) {
      const metadata = parseJSON(bytes);
      for (const { id } of value.models) {
        const name = `openai/${id}`;
        if (own(metadata, name)) fail('Aider: метаданные модели уже существуют и не принадлежат плагину.');
        Object.defineProperty(metadata, name, { value: { litellm_provider: 'openai', mode: 'chat' }, enumerable: true });
      }
      return json(metadata);
    }
    let next = text;
    for (const [key, setting] of Object.entries({ 'openai-api-base': value.baseUrl, 'openai-api-key': value.apiKey })) next = yamlSet(next, [key], [JSON.stringify(setting)]);
    return next;
  }
  if (agent.id === 'omp') {
    if (/(?:^|\n)\s*(?:wikivibe|["']wikivibe["']):/.test(text)) fail('Конфликт: поставщик wikivibe уже существует в YAML.');
    return yamlSet(text, ['providers', 'wikivibe'], [
      `baseUrl: ${JSON.stringify(value.baseUrl)}`, `apiKey: ${JSON.stringify(value.apiKey)}`,
      'api: openai-completions', 'auth: apiKey', 'models:', ...value.models.map(({ id }) => `  - id: ${JSON.stringify(id)}`)
    ]);
  }
  const config = parseJSON(bytes);
  switch (agent.id) {
    case 'claude': {
      const env = child(config, 'env');
      if (own(config, 'apiKeyHelper') || own(env, 'ANTHROPIC_API_KEY') || Object.keys(env).some(key => key.startsWith('CLAUDE_CODE_USE_'))) fail('Claude Code: существующий apiKeyHelper, ANTHROPIC_API_KEY или настройка облачного поставщика конфликтует с WikiVibe; файл не изменён.');
      const picker = child(config, 'modelPicker');
      if (own(picker, 'options') && (!Array.isArray(picker.options) || picker.options.some(row => !object(row) || typeof row.model !== 'string'))) fail('Claude Code: modelPicker.options должен быть массивом моделей.');
      const options = picker.options ?? [];
      if (options.some(row => value.models.some(model => model.id === row.model))) fail('Claude Code: модель уже существует в пользовательском modelPicker.');
      picker.options = [...options, ...value.models.map(({ id }) => ({ model: id, label: `WikiVibe · ${id}` }))];
      picker.replaceBuiltInOptions = true;
      env.ANTHROPIC_BASE_URL = value.baseUrl.slice(0, -3);
      env.ANTHROPIC_AUTH_TOKEN = value.apiKey;
      break;
    }
    case 'opencode': {
      const providers = child(config, 'provider');
      provider(providers, 'wikivibe', { npm: '@ai-sdk/openai-compatible', name: 'WikiVibe', options: { baseURL: value.baseUrl, apiKey: value.apiKey }, models: Object.fromEntries(value.models.map(({ id }) => [id, { name: id }])) });
      if (own(config, 'enabled_providers') && (!Array.isArray(config.enabled_providers) || !config.enabled_providers.includes('wikivibe'))) fail('OpenCode: enabled_providers исключает wikivibe.');
      if (Array.isArray(config.disabled_providers) && config.disabled_providers.includes('wikivibe')) fail('OpenCode: поставщик wikivibe отключён через disabled_providers.');
      break;
    }
    case 'pi':
      provider(child(config, 'providers'), 'wikivibe', { baseUrl: value.baseUrl, api: 'openai-completions', apiKey: value.apiKey, models: value.models.map(({ id }) => ({ id })) });
      break;
    case 'qwen': {
      const providers = child(config, 'modelProviders');
      if (!own(providers, 'openai')) providers.openai = [];
      if (!Array.isArray(providers.openai) || providers.openai.some(entry => !object(entry))) fail('Qwen Code: modelProviders.openai должен быть массивом объектов.');
      if (providers.openai.some(entry => entry.envKey === 'WIKIVIBE_API_KEY' || value.models.some(model => model.id === entry.id))) fail('Qwen Code: идентификатор модели или ключ уже используется другим поставщиком.');
      providers.openai.push(...value.models.map(({ id }) => ({ id, name: `WikiVibe · ${id}`, baseUrl: value.baseUrl, envKey: 'WIKIVIBE_API_KEY' })));
      const env = child(config, 'env');
      if (own(env, 'WIKIVIBE_API_KEY')) fail('Qwen Code: переменная WIKIVIBE_API_KEY уже существует.');
      env.WIKIVIBE_API_KEY = value.apiKey;
      break;
    }
  }
  return json(config);
}

function warnings(agents) {
  return [
    'Ключ будет записан открытым текстом в конфигурацию выбранных агентов. Резервные копии могут содержать прежние ключи и другие секреты. Права файлов — 0600, каталога копий — 0700.',
    'Плагин меняет только стандартные файлы в локальном домашнем каталоге; настройки действуют для новых сессий. Настройки проекта, переменные окружения, параметры запуска, управляемые настройки и выбранный профиль Orca (CLAUDE_CONFIG_DIR/CODEX_HOME) могут переопределить их. SSH и WSL не настраиваются. Установка агента не проверяется.',
    'JSONC и сложные YAML/TOML не изменяются. Cursor, Windsurf, Antigravity и другие закрытые форматы исключены. Каждый файл изменяется отдельно: общей транзакции для всех файлов нет.',
    'Каталог WikiVibe содержит только модели из авторизованного /models. Выбор модели остаётся в агенте; текущие модель и поставщик сохраняются. Старые настройки выбора, записанные самим плагином, возвращаются к исходным при обновлении.',
    'Пользовательские ограничения Claude availableModels, Pi enabledModels, OMP enabledModels/enabledProviders и управляемые политики не расширяются: они могут скрыть часть импортированного каталога. Встроенные модели других поставщиков не удаляются; их видимость не означает доступ по ключу WikiVibe. Claude и Aider используют общий endpoint своего протокола; сохранённая текущая модель может отсутствовать у шлюза — выберите доступную модель внутри агента.',
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
  if (agent.id === 'opencode' && await snapshot(root, path.join(root, '.config/opencode/opencode.jsonc'))) fail('OpenCode: найден opencode.jsonc в формате JSONC; автоматическое изменение исключено.');
  if (agent.id === 'codex') return [agent.rel, '.codex/wikivibe-models.json', '.codex/wikivibe.config.toml'];
  if (agent.id === 'aider') return [agent.rel, '.aider.model.metadata.json'];
  if (agent.id === 'pi') return [agent.rel, '.pi/agent/settings.json']; // old plugin-owned defaults only
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
  for (const agent of agents) {
    // Restore looks at both supported YAML spellings, independent of which exists now.
    const rels = restore ? agent.id === 'omp' ? ['.omp/agent/models.yml', '.omp/agent/models.yaml', '.omp/agent/config.yml', '.omp/agent/config.yaml'] : agent.id === 'pi' ? [agent.rel, '.pi/agent/settings.json'] : agent.id === 'codex' ? [agent.rel, '.codex/wikivibe-models.json', '.codex/wikivibe.config.toml'] : agent.id === 'aider' ? [agent.rel, '.aider.model.metadata.json'] : [agent.rel] : await nativePaths(root, agent);
    for (const rel of rels) {
      const target = path.join(root, rel);
      const current = await snapshot(root, target);
      const backup = await readBackup(root, agent, rel, target);
      if (backup && !owned(current, backup.record)) fail(`${agent.label}: конфликт с изменениями после применения. Восстановление и перезапись запрещены; ваши изменения сохранены.`);
      if (restore) { if (backup) result.push({ agent, rel, target, current, backup }); continue; }
      if (backup && backup.record.state !== 'active') fail('Незавершённая операция: сначала восстановите конфигурацию.');
      const obsolete = agent.id === 'pi' && rel.endsWith('settings.json') || agent.id === 'omp' && /\/config\.ya?ml$/.test(rel);
      if (obsolete) { if (backup) result.push({ agent, rel, target, current, backup, cleanup: true }); continue; }
      // Owned files cannot have later edits (checked above), so regenerating from
      // the original safely removes every stale plugin model and legacy default.
      const baseline = backup ? backup.record.original === null ? null : Buffer.from(backup.record.original.base64, 'base64') : current?.bytes ?? null;
      const bytes = Buffer.from(render(agent, rel, baseline, value, root));
      const backupDir = path.dirname(backupPath(root, target));
      if (await directories(root, backupDir) && (await fs.lstat(backupDir)).mode % 512 !== 0o700) fail('Каталог резервных копий должен иметь права 0700.');
      result.push({ agent, rel, target, current, backup, bytes });
    }
  }
  return result;
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
  return AGENTS.map(({ rel, protocol, ...agent }) => ({ ...agent, available: true, configPath: path.join(root, rel) }));
}
export async function previewAgents(agentIds, value, { home = homedir() } = {}) {
  const agents = selected(agentIds); preferences(value);
  const root = await homeRoot(home);
  const changes = await plans(root, agents, { ...value, apiKey: 'preview-redacted' });
  return { changes: changes.map(plan => ({ agentId: plan.agent.id, path: plan.target, description: `${plan.agent.label}: ${plan.cleanup ? 'восстановление прежних настроек выбора' : 'установка полного доступного каталога'}, ${plan.agent.protocol}. Плагин сохранит резервную копию. Восстановление доступно, только если файл не изменится после применения.`, secretOnDisk: !plan.cleanup && !plan.rel.endsWith('wikivibe-models.json') && !plan.rel.endsWith('wikivibe.config.toml') && !plan.rel.endsWith('.metadata.json') })), warnings: warnings(agents) };
}
export async function applyAgents(agentIds, value, { home = homedir() } = {}) {
  const agents = selected(agentIds); preferences(value, true);
  return mutation(home, async root => {
    const changes = await plans(root, agents, value);
    const applied = [];
    for (const plan of changes) {
      if (plan.cleanup) { await restorePlan(root, plan); applied.push({ agentId: plan.agent.id, path: plan.target }); continue; }
      const location = backupPath(root, plan.target);
      await directories(root, path.dirname(location), true);
      if ((await fs.lstat(path.dirname(location))).mode % 512 !== 0o700) fail('Каталог резервных копий должен иметь права 0700.');
      const original = plan.backup?.record.original ?? (plan.current === null ? null : { base64: plan.current.bytes.toString('base64'), hash: plan.current.hash, mode: plan.current.mode });
      // null is meaningful: reapplying must not turn an originally absent file
      // into an original containing the previously written secret.
      const record = { version: 1, agentId: plan.agent.id, rel: plan.rel, original: plan.backup ? plan.backup.record.original : original, state: 'pending', appliedHash: plan.backup?.record.appliedHash ?? plan.current?.hash ?? hash(Buffer.alloc(0)), nextHash: hash(plan.bytes) };
      await replace(root, location, Buffer.from(json(record)), plan.backup?.saved ?? null);
      await replace(root, plan.target, plan.bytes, plan.current);
      const saved = await snapshot(root, location);
      record.state = 'active'; record.appliedHash = record.nextHash; delete record.nextHash;
      await replace(root, location, Buffer.from(json(record)), saved);
      applied.push({ agentId: plan.agent.id, path: plan.target });
    }
    return { applied, warnings: warnings(agents) };
  });
}
export async function restoreAgents(agentIds, { home = homedir() } = {}) {
  const agents = selected(agentIds);
  return mutation(home, async root => {
    const changes = await plans(root, agents, undefined, true);
    const restored = [];
    for (const plan of changes) {
      await restorePlan(root, plan);
      restored.push({ agentId: plan.agent.id, path: plan.target });
    }
    return { restored };
  });
}
