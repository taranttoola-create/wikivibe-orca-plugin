import { homedir } from 'node:os';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Native format sources (not a claim that a particular gateway model supports tools):
// Claude: https://code.claude.com/docs/en/llm-gateway-connect
// Codex: https://developers.openai.com/codex/config-reference
// OpenCode: https://opencode.ai/docs/config/ and https://opencode.ai/docs/providers/#custom-provider
// Pi: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
// OMP: https://github.com/can1357/oh-my-pi/blob/main/docs/models.md
// Aider: https://aider.chat/docs/llms/openai-compat.html and https://aider.chat/docs/config/aider_conf.html
// Qwen: https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
// Only default user paths are managed. JSONC, complex YAML/TOML, profile/env
// overrides and closed agents (Cursor, Windsurf, Antigravity) are not rewritten.
const ENDPOINTS = new Set(['https://api.wikivibe.dev/v1', 'https://vapi.wikivibe.dev/v1']);
const BACKUPS = '.wikivibe-gateway-backups';
const AGENTS = [
  { id: 'claude', label: 'Claude Code', rel: '.claude/settings.json', protocol: 'Anthropic Messages', description: 'В ~/.claude/settings.json: env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL и model. Протокол Anthropic Messages; совместимость модели не проверена.' },
  { id: 'codex', label: 'Codex', rel: '.codex/config.toml', protocol: 'OpenAI Responses', description: 'В ~/.codex/config.toml: model, model_provider и model_providers.wikivibe с wire_api = responses и experimental_bearer_token. Протокол OpenAI Responses; совместимость модели не проверена.' },
  { id: 'opencode', label: 'OpenCode', rel: '.config/opencode/opencode.json', protocol: 'OpenAI Chat Completions', description: 'В ~/.config/opencode/opencode.json: provider.wikivibe, options.baseURL, options.apiKey и model. Протокол OpenAI Chat Completions через @ai-sdk/openai-compatible. JSONC не изменяется.' },
  { id: 'pi', label: 'Pi', rel: '.pi/agent/models.json', protocol: 'OpenAI Chat Completions', description: 'В ~/.pi/agent/models.json: providers.wikivibe с baseUrl, apiKey и api = openai-completions; в settings.json рядом: defaultProvider и defaultModel. Протокол OpenAI Chat Completions; нужна новая сессия.' },
  { id: 'omp', label: 'oh-my-pi', rel: '.omp/agent/models.yml', protocol: 'OpenAI Chat Completions', description: 'В ~/.omp/agent/models.yml: providers.wikivibe с baseUrl, apiKey и api = openai-completions; в config.yml рядом: modelRoles.default. Поддерживаются также .yaml и только простой YAML. Протокол OpenAI Chat Completions.' },
  { id: 'aider', label: 'Aider', rel: '.aider.conf.yml', protocol: 'OpenAI Chat Completions', description: 'В ~/.aider.conf.yml: openai-api-base, openai-api-key и model с префиксом openai/. Протокол OpenAI Chat Completions; только простой YAML.' },
  { id: 'qwen', label: 'Qwen Code', rel: '.qwen/settings.json', protocol: 'OpenAI Chat Completions', description: 'В ~/.qwen/settings.json: modelProviders.openai, env.WIKIVIBE_API_KEY, security.auth.selectedType и model.name. Протокол OpenAI Chat Completions; нужна новая сессия.' }
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
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 300 || /[\x00-\x1f\x7f]/.test(value.model)) fail('Выберите модель из каталога.');
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
function provider(parent, key, value, managed) {
  if (own(parent, key) && !managed) fail('Конфликт: поставщик wikivibe уже существует и не принадлежит плагину.');
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
function tomlConfig(text, value, managed) {
  if (text.includes('"""') || text.includes("'''")) fail('Многострочные строки TOML не изменяются автоматически.');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.at(-1) === '') lines.pop();
  let rootEnd = lines.findIndex(line => /^\s*\[/.test(line));
  if (rootEnd < 0) rootEnd = lines.length;
  const values = { model: value.model, model_provider: 'wikivibe' };
  for (const [key, next] of Object.entries(values)) {
    const matches = [];
    for (let i = 0; i < rootEnd; i++) {
      if (/^\s*(?:#|$)/.test(lines[i])) continue;
      if (!/^\s*[A-Za-z_][\w-]*\s*=/.test(lines[i])) fail('Сложные ключи в корне TOML не изменяются автоматически.');
      if (/^\s*model_providers(?:\s*=|\.)/.test(lines[i])) fail('model_providers в однострочной таблице TOML или с точечными ключами не изменяется.');
      if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) matches.push(i);
    }
    if (matches.length > 1) fail('Ключ TOML повторяется; файл не изменён.');
    if (matches.length) lines[matches[0]] = `${key} = ${JSON.stringify(next)}`;
    else { lines.splice(rootEnd++, 0, `${key} = ${JSON.stringify(next)}`); }
  }
  const matches = [];
  for (let i = rootEnd; i < lines.length; i++) {
    if (/^\s*\[.*(?:["']wikivibe["']|\bwikivibe\b)/.test(lines[i])) matches.push(i);
    if (/^\s*\[\s*["']model_providers/.test(lines[i])) fail('Ключи поставщиков TOML в кавычках не изменяются.');
  }
  if (matches.length && (!managed || matches.length > 1 || !/^\s*\[model_providers\.wikivibe\]\s*(?:#.*)?$/.test(lines[matches[0]]))) fail('Конфликт: поставщик wikivibe уже существует в TOML.');
  const block = ['[model_providers.wikivibe]', 'name = "WikiVibe"', `base_url = ${JSON.stringify(value.baseUrl)}`, 'wire_api = "responses"', `experimental_bearer_token = ${JSON.stringify(value.apiKey)}`];
  if (matches.length) {
    const start = matches[0];
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
    while (end > start + 1 && /^\s*(?:#|$)/.test(lines[end - 1])) end--;
    lines.splice(start, end - start, ...block);
  } else lines.push('', ...block);
  return `${lines.join(newline)}${newline}`;
}

function render(agent, rel, bytes, value, managed) {
  const text = bytes?.toString('utf8') ?? '';
  if (agent.id === 'codex') return tomlConfig(text, value, managed);
  if (agent.id === 'aider') {
    let next = text;
    for (const [key, setting] of Object.entries({ model: `openai/${value.model}`, 'openai-api-base': value.baseUrl, 'openai-api-key': value.apiKey })) next = yamlSet(next, [key], [JSON.stringify(setting)]);
    return next;
  }
  if (agent.id === 'omp') {
    if (rel.endsWith('config.yml') || rel.endsWith('config.yaml')) return yamlSet(text, ['modelRoles', 'default'], [JSON.stringify(`wikivibe/${value.model}`)]);
    if (!managed && /(?:^|\n)\s*(?:wikivibe|["']wikivibe["']):/.test(text)) fail('Конфликт: поставщик wikivibe уже существует в YAML.');
    return yamlSet(text, ['providers', 'wikivibe'], [
      `baseUrl: ${JSON.stringify(value.baseUrl)}`, `apiKey: ${JSON.stringify(value.apiKey)}`,
      'api: openai-completions', 'auth: apiKey', 'models:', `  - id: ${JSON.stringify(value.model)}`
    ]);
  }
  const config = parseJSON(bytes);
  switch (agent.id) {
    case 'claude': {
      const env = child(config, 'env');
      if (own(config, 'apiKeyHelper') || own(env, 'ANTHROPIC_API_KEY') || own(env, 'CLAUDE_CODE_USE_BEDROCK') || own(env, 'CLAUDE_CODE_USE_VERTEX') || own(env, 'CLAUDE_CODE_USE_FOUNDRY')) fail('Claude Code: существующий apiKeyHelper, ANTHROPIC_API_KEY или настройка облачного поставщика конфликтует с WikiVibe; файл не изменён.');
      env.ANTHROPIC_BASE_URL = value.baseUrl.slice(0, -3);
      env.ANTHROPIC_AUTH_TOKEN = value.apiKey;
      env.ANTHROPIC_MODEL = value.model;
      config.model = value.model;
      break;
    }
    case 'opencode': {
      const providers = child(config, 'provider');
      provider(providers, 'wikivibe', { npm: '@ai-sdk/openai-compatible', name: 'WikiVibe', options: { baseURL: value.baseUrl, apiKey: value.apiKey }, models: { [value.model]: { name: value.model } } }, managed);
      if (own(config, 'enabled_providers') && (!Array.isArray(config.enabled_providers) || !config.enabled_providers.includes('wikivibe'))) fail('OpenCode: enabled_providers исключает wikivibe.');
      if (Array.isArray(config.disabled_providers) && config.disabled_providers.includes('wikivibe')) fail('OpenCode: поставщик wikivibe отключён через disabled_providers.');
      config.model = `wikivibe/${value.model}`;
      break;
    }
    case 'pi':
      if (rel.endsWith('settings.json')) {
        if (own(config, 'enabledModels') && Array.isArray(config.enabledModels) && config.enabledModels.length) fail('Pi: enabledModels может исключать выбранную модель; измените список доступных моделей вручную.');
        config.defaultProvider = 'wikivibe'; config.defaultModel = value.model;
      } else provider(child(config, 'providers'), 'wikivibe', { baseUrl: value.baseUrl, api: 'openai-completions', apiKey: value.apiKey, models: [{ id: value.model }] }, managed);
      break;
    case 'qwen': {
      const providers = child(config, 'modelProviders');
      if (!own(providers, 'openai')) providers.openai = [];
      if (!Array.isArray(providers.openai) || providers.openai.some(entry => !object(entry))) fail('Qwen Code: modelProviders.openai должен быть массивом объектов.');
      const existing = providers.openai.findIndex(entry => entry.id === value.model);
      if (existing >= 0 && (!managed || providers.openai[existing].envKey !== 'WIKIVIBE_API_KEY')) fail('Qwen Code: идентификатор модели уже используется другим поставщиком.');
      if (managed) {
        for (let i = providers.openai.length - 1; i >= 0; i--) {
          if (providers.openai[i].envKey === 'WIKIVIBE_API_KEY' && i !== existing) providers.openai.splice(i, 1);
        }
      }
      const adjusted = providers.openai.findIndex(entry => entry.id === value.model);
      const entry = { id: value.model, name: value.model, baseUrl: value.baseUrl, envKey: 'WIKIVIBE_API_KEY' };
      if (adjusted < 0) providers.openai.push(entry); else providers.openai[adjusted] = entry;
      const env = child(config, 'env');
      if (!managed && own(env, 'WIKIVIBE_API_KEY')) fail('Qwen Code: переменная WIKIVIBE_API_KEY уже существует.');
      env.WIKIVIBE_API_KEY = value.apiKey;
      child(child(config, 'security'), 'auth').selectedType = 'openai';
      child(config, 'model').name = value.model;
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
    ...agents.map(agent => `${agent.label}: ${agent.protocol}. Каталог /models не подтверждает поддержку этого протокола, потоковых ответов или вызовов инструментов выбранной моделью.`)
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
  if (agent.id !== 'omp') return agent.id === 'pi' ? [agent.rel, '.pi/agent/settings.json'] : [agent.rel];
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
    const rels = restore && agent.id === 'omp' ? ['.omp/agent/models.yml', '.omp/agent/models.yaml', '.omp/agent/config.yml', '.omp/agent/config.yaml'] : restore && agent.id === 'pi' ? [agent.rel, '.pi/agent/settings.json'] : restore ? [agent.rel] : await nativePaths(root, agent);
    for (const rel of rels) {
      const target = path.join(root, rel);
      const current = await snapshot(root, target);
      const backup = await readBackup(root, agent, rel, target);
      if (backup && !owned(current, backup.record)) fail(`${agent.label}: конфликт с изменениями после применения. Восстановление и перезапись запрещены; ваши изменения сохранены.`);
      if (restore) { if (backup) result.push({ agent, rel, target, current, backup }); continue; }
      if (backup && backup.record.state !== 'active') fail('Незавершённая операция: сначала восстановите конфигурацию.');
      const bytes = Buffer.from(render(agent, rel, current?.bytes ?? null, value, Boolean(backup)));
      const backupDir = path.dirname(backupPath(root, target));
      if (await directories(root, backupDir) && (await fs.lstat(backupDir)).mode % 512 !== 0o700) fail('Каталог резервных копий должен иметь права 0700.');
      result.push({ agent, rel, target, current, backup, bytes });
    }
  }
  return result;
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
  return { changes: changes.map(plan => ({ agentId: plan.agent.id, path: plan.target, description: `${plan.agent.label}: штатный файл конфигурации, ${plan.agent.protocol}. Плагин сохранит резервную копию. Восстановление доступно, только если файл не изменится после применения.`, secretOnDisk: !plan.rel.endsWith('/settings.json') || plan.agent.id !== 'pi' })), warnings: warnings(agents) };
}
export async function applyAgents(agentIds, value, { home = homedir() } = {}) {
  const agents = selected(agentIds); preferences(value, true);
  return mutation(home, async root => {
    const changes = await plans(root, agents, value);
    const applied = [];
    for (const plan of changes) {
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
      restored.push({ agentId: plan.agent.id, path: plan.target });
    }
    return { restored };
  });
}
