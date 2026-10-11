import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, lstat, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { listAgents, previewAgents, applyAgents, restoreAgents } from '../src/adapters.mjs';

const endpoint = 'https://api.wikivibe.dev/v1';
const value = { apiKey: 'wv-test-key-42', baseUrl: endpoint, models: [{ id: 'wv-code-1' }, { id: 'vendor/wv-code-2' }] };
let homes = [];
async function home() {
  const root = await mkdtemp(path.join(tmpdir(), 'wikivibe-adapters-'));
  homes.push(root);
  return root;
}
async function put(root, rel, text, mode = 0o640) {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, text, { mode });
  await chmod(file, mode);
  return file;
}
async function get(root, rel) { return readFile(path.join(root, rel), 'utf8'); }
async function reject(promise, message) {
  await assert.rejects(promise, error => {
    assert.match(error.message, message);
    assert.doesNotMatch(error.message, /wv-test-key-42|sk-[A-Za-z0-9]/);
    return true;
  });
}

test.afterEach(async () => {
  await Promise.all(homes.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test('lists all documented native adapters without requiring binaries', async () => {
  const root = await home();
  const agents = await listAgents({ home: root });
  assert.deepEqual(agents.map(agent => agent.id), ['claude', 'codex', 'opencode', 'pi', 'omp', 'aider', 'qwen']);
  for (const agent of agents) {
    assert.equal(agent.available, true);
    assert.equal(typeof agent.configPath, 'string');
    assert.equal(typeof agent.description, 'string');
    assert.ok(agent.configPath.startsWith(root + path.sep));
  }
});

test('preview reports affected files and secret exposure without writing configs', async () => {
  const root = await home();
  const result = await previewAgents(['claude', 'codex'], value, { home: root });
  assert.equal(result.changes.length, 4);
  assert.equal(result.changes.filter(change => change.secretOnDisk).length, 2);
  assert.deepEqual(await listAgents({ home: root }).then(agents => agents.map(agent => agent.configPath).filter(file => file.includes('.claude') || file.includes('.codex'))), [path.join(root, '.claude/settings.json'), path.join(root, '.codex/config.toml')]);
  await assert.rejects(get(root, '.claude/settings.json'), { code: 'ENOENT' });
  await assert.rejects(get(root, '.codex/config.toml'), { code: 'ENOENT' });
});

test('Claude JSON preserves unrelated fields and restores original bytes and mode', async () => {
  const root = await home();
  const original = JSON.stringify({ permissions: { allow: ['Read'] }, model: 'existing', env: { CUSTOM: 'keep', ANTHROPIC_MODEL: 'existing-env' }, modelPicker: { options: [{ model: 'other', label: 'User' }] } }) + '\n';
  const file = await put(root, '.claude/settings.json', original, 0o640);
  const applied = await applyAgents(['claude'], value, { home: root });
  assert.deepEqual(applied.applied.map(item => item.agentId), ['claude']);
  const changed = JSON.parse(await get(root, '.claude/settings.json'));
  assert.equal(changed.permissions.allow[0], 'Read');
  assert.equal(changed.env.CUSTOM, 'keep');
  assert.equal(changed.env.ANTHROPIC_BASE_URL, 'https://api.wikivibe.dev');
  assert.equal(changed.env.ANTHROPIC_AUTH_TOKEN, value.apiKey);
  assert.equal(changed.model, 'existing');
  assert.equal(changed.env.ANTHROPIC_MODEL, 'existing-env');
  assert.equal(changed.modelPicker.replaceBuiltInOptions, true);
  assert.deepEqual(changed.modelPicker.options.map(row => row.model), ['other', ...value.models.map(model => model.id)]);
  assert.ok(changed.modelPicker.options.slice(1).every(row => row.label.startsWith('WikiVibe')));
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const restored = await restoreAgents(['claude'], { home: root });
  assert.deepEqual(restored.restored.map(item => item.agentId), ['claude']);
  assert.equal(await get(root, '.claude/settings.json'), original);
  assert.equal((await lstat(file)).mode & 0o777, 0o640);
});

test('Codex TOML preserves unrelated settings and writes documented responses provider', async () => {
  const root = await home();
  const original = '# user setting\nmodel = "existing"\nmodel_provider = "openai"\nmodel_catalog_json = "/user/catalog.json"\napproval_policy = "on-request"\n';
  await put(root, '.codex/config.toml', original);
  await applyAgents(['codex'], value, { home: root });
  const changed = await get(root, '.codex/config.toml');
  assert.match(changed, /approval_policy = "on-request"/);
  assert.match(changed, /model = "existing"/);
  assert.match(changed, /model_provider = "openai"/);
  assert.match(changed, /model_catalog_json = "\/user\/catalog.json"/);
  assert.doesNotMatch(changed, /^model_provider = "wikivibe"/m);
  const profile = await get(root, '.codex/wikivibe.config.toml');
  assert.match(profile, /^model_provider = "wikivibe"/m);
  assert.doesNotMatch(profile, /^model =/m);
  const catalogPath = JSON.parse(profile.match(/^model_catalog_json = (.+)$/m)[1]);
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  assert.deepEqual(catalog.models.map(model => model.slug), value.models.map(model => model.id));
  assert.ok(catalog.models.every(model => model.visibility === 'list' && model.supported_in_api));
  assert.ok(catalog.models.every(model => model.supported_reasoning_levels.length === 0 && !Object.hasOwn(model, 'context_window')));
  assert.ok(catalog.models.every(model => typeof model.base_instructions === 'string' && model.base_instructions.length > 0));
  assert.match(changed, /\[model_providers\.wikivibe\]/);
  assert.match(changed, /wire_api = "responses"/);
  await restoreAgents(['codex'], { home: root });
  assert.equal(await get(root, '.codex/config.toml'), original);
  await assert.rejects(get(root, '.codex/wikivibe-models.json'), { code: 'ENOENT' });
  await assert.rejects(get(root, '.codex/wikivibe.config.toml'), { code: 'ENOENT' });
});

test('OpenCode JSON preserves existing provider and uses OpenAI-compatible provider', async () => {
  const root = await home();
  const original = JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'openai/existing', permission: { edit: 'ask' }, provider: { openai: { options: { apiKey: 'unrelated' } } } }, null, 2) + '\n';
  await put(root, '.config/opencode/opencode.json', original);
  await applyAgents(['opencode'], value, { home: root });
  const changed = JSON.parse(await get(root, '.config/opencode/opencode.json'));
  assert.equal(changed.permission.edit, 'ask');
  assert.equal(changed.provider.openai.options.apiKey, 'unrelated');
  assert.equal(changed.provider.wikivibe.options.baseURL, endpoint);
  assert.equal(changed.provider.wikivibe.options.apiKey, value.apiKey);
  assert.equal(changed.model, 'openai/existing');
  assert.deepEqual(Object.keys(changed.provider.wikivibe.models), value.models.map(model => model.id));
  await restoreAgents(['opencode'], { home: root });
  assert.equal(await get(root, '.config/opencode/opencode.json'), original);
});

test('Pi extends an existing scope without changing defaults and restores original bytes', async () => {
  const root = await home();
  const settings = '{\n  "theme": "dark",\n  "defaultProvider": "other",\n  "defaultModel": "other",\n  "enabledModels": ["other/*"],\n  "defaultThinkingLevel": "high"\n}\n';
  const models = '{\n  "providers": {"other": {"baseUrl": "https://other.invalid", "models": [{"id": "other"}]}},\n  "modelOverrides": {"other": {"reasoning": true}}\n}\n';
  await put(root, '.pi/agent/settings.json', settings);
  await put(root, '.pi/agent/models.json', models);
  await applyAgents(['pi'], value, { home: root });
  const changedSettings = JSON.parse(await get(root, '.pi/agent/settings.json'));
  assert.deepEqual(changedSettings, { ...JSON.parse(settings), enabledModels: ['other/*', ...value.models.map(({ id }) => `wikivibe/${id}`)] });
  const changed = JSON.parse(await get(root, '.pi/agent/models.json'));
  assert.equal(changed.providers.other.baseUrl, 'https://other.invalid');
  assert.equal(changed.providers.wikivibe.api, 'openai-completions');
  assert.equal(changed.providers.wikivibe.apiKey, value.apiKey);
  assert.deepEqual(changed.providers.wikivibe.models, value.models);
  await restoreAgents(['pi'], { home: root });
  assert.equal(await get(root, '.pi/agent/settings.json'), settings);
  assert.equal(await get(root, '.pi/agent/models.json'), models);
});

test('OMP and Aider preserve YAML comments and unrelated values', async () => {
  const root = await home();
  const ompModels = '# keep this comment\nproviders:\n  other:\n    baseUrl: https://other.invalid\n';
  const ompConfig = 'modelRoles:\n  default: other/active\n  plan: other/model\n';
  const aider = '# aider user config\npretty: true\nmodel: "openai/existing"\n';
  await put(root, '.omp/agent/models.yml', ompModels);
  await put(root, '.omp/agent/config.yml', ompConfig);
  await put(root, '.aider.conf.yml', aider);
  await applyAgents(['omp', 'aider'], value, { home: root });
  assert.match(await get(root, '.omp/agent/models.yml'), /# keep this comment/);
  assert.match(await get(root, '.omp/agent/models.yml'), /other:/);
  assert.match(await get(root, '.omp/agent/models.yml'), /wikivibe:/);
  assert.equal(await get(root, '.omp/agent/config.yml'), ompConfig);
  for (const { id } of value.models) assert.ok((await get(root, '.omp/agent/models.yml')).includes(`- id: ${JSON.stringify(id)}`));
  assert.match(await get(root, '.aider.conf.yml'), /# aider user config/);
  assert.match(await get(root, '.aider.conf.yml'), /openai-api-base: "https:\/\/api.wikivibe.dev\/v1"/);
  assert.match(await get(root, '.aider.conf.yml'), /model: "openai\/existing"/);
  const metadata = JSON.parse(await get(root, '.aider.model.metadata.json'));
  assert.deepEqual(Object.keys(metadata), value.models.map(model => `openai/${model.id}`));
  assert.ok(Object.values(metadata).every(row => row.mode === 'chat' && row.litellm_provider === 'openai'));
  await restoreAgents(['omp', 'aider'], { home: root });
  assert.equal(await get(root, '.omp/agent/models.yml'), ompModels);
  assert.equal(await get(root, '.omp/agent/config.yml'), ompConfig);
  assert.equal(await get(root, '.aider.conf.yml'), aider);
});

test('Qwen settings preserves unrelated provider and restores after writing env key', async () => {
  const root = await home();
  const original = JSON.stringify({ modelProviders: { openai: [{ id: 'other', baseUrl: 'https://other.invalid' }], anthropic: [{ id: 'active' }] }, env: { KEEP: 'yes' }, model: { name: 'active' }, security: { auth: { selectedType: 'anthropic' } } }, null, 2) + '\n';
  await put(root, '.qwen/settings.json', original);
  await applyAgents(['qwen'], value, { home: root });
  const changed = JSON.parse(await get(root, '.qwen/settings.json'));
  assert.equal(changed.env.KEEP, 'yes');
  assert.equal(changed.env.WIKIVIBE_API_KEY, value.apiKey);
  assert.equal(changed.modelProviders.openai[0].id, 'other');
  assert.equal(changed.model.name, 'active');
  assert.equal(changed.security.auth.selectedType, 'anthropic');
  assert.deepEqual(changed.modelProviders.openai.slice(1).map(row => row.id), value.models.map(model => model.id));
  assert.ok(changed.modelProviders.openai.slice(1).every(row => row.name.startsWith('WikiVibe') && row.envKey === 'WIKIVIBE_API_KEY'));
  await restoreAgents(['qwen'], { home: root });
  assert.equal(await get(root, '.qwen/settings.json'), original);
});

test('restore refuses later user edits and leaves them untouched', async () => {
  const root = await home();
  const file = await put(root, '.claude/settings.json', '{"permissions":{"allow":["Read"]}}\n');
  await applyAgents(['claude'], value, { home: root });
  await writeFile(file, '{"permissions":{"allow":["Read","Write"]}}\n', { mode: 0o600 });
  await reject(restoreAgents(['claude'], { home: root }), /конфликт/i);
  assert.match(await get(root, '.claude/settings.json'), /Write/);
});

test('new config restore removes only plugin-created files', async () => {
  const root = await home();
  await applyAgents(['aider'], value, { home: root });
  assert.match(await get(root, '.aider.conf.yml'), /openai-api-key/);
  await restoreAgents(['aider'], { home: root });
  await assert.rejects(readFile(path.join(root, '.aider.conf.yml')));
  await assert.rejects(get(root, '.aider.model.metadata.json'), { code: 'ENOENT' });
});

test('refuses JSONC and malformed JSON without exposing key or mutating file', async () => {
  const root = await home();
  const jsonc = '{\n  // comments are intentionally unsupported\n  "model": "old"\n}\n';
  await put(root, '.config/opencode/opencode.jsonc', jsonc);
  await reject(applyAgents(['opencode'], value, { home: root }), /JSONC/);
  assert.equal(await get(root, '.config/opencode/opencode.jsonc'), jsonc);
  const malformed = '{"old":"unterminated}\n';
  await put(root, '.claude/settings.json', malformed);
  await reject(applyAgents(['claude'], value, { home: root }), /корректный JSON/);
  assert.equal(await get(root, '.claude/settings.json'), malformed);
});

test('backup and output permissions are restrictive', async () => {
  const root = await home();
  await put(root, '.claude/settings.json', '{"keep":true}\n', 0o644);
  await applyAgents(['claude'], value, { home: root });
  const config = await lstat(path.join(root, '.claude/settings.json'));
  const backupDir = await lstat(path.join(root, '.claude/.wikivibe-gateway-backups'));
  const backup = await lstat(path.join(root, '.claude/.wikivibe-gateway-backups/settings.json.json'));
  assert.equal(config.mode & 0o777, 0o600);
  assert.equal(backupDir.mode & 0o777, 0o700);
  assert.equal(backup.mode & 0o777, 0o600);
});

test('all seven adapters replace owned rosters, never inject public models, and retain original backups', async () => {
  const root = await home();
  const ids = (await listAgents({ home: root })).map(agent => agent.id);
  const originals = {
    '.claude/settings.json': '{"model":"user","availableModels":["user"]}\n',
    '.codex/config.toml': 'model = "user"\nmodel_provider = "openai"\n',
    '.config/opencode/opencode.json': '{"model":"other/user"}\n',
    '.pi/agent/settings.json': '{"defaultProvider":"other","defaultModel":"user","enabledModels":["other/*"]}\n',
    '.omp/agent/config.yml': 'modelRoles:\n  default: other/user\n',
    '.aider.conf.yml': 'model: "other/user"\n',
    '.aider.model.metadata.json': '{"other/user":{"mode":"chat","litellm_provider":"other"}}\n',
    '.qwen/settings.json': '{"model":{"name":"user"},"security":{"auth":{"selectedType":"anthropic"}}}\n'
  };
  for (const [rel, bytes] of Object.entries(originals)) await put(root, rel, bytes);
  await applyAgents(ids, value, { home: root });
  const refreshed = { ...value, apiKey: 'wv-refreshed-key-42', models: [{ id: 'new-authorized' }] };
  const result = await applyAgents(ids, refreshed, { home: root });
  assert.ok(result.warnings.some(message => message.includes('availableModels') && message.includes('enabledModels')));
  const claude = JSON.parse(await get(root, '.claude/settings.json'));
  assert.deepEqual(claude.modelPicker.options.map(row => row.model), ['new-authorized']);
  assert.deepEqual(claude.availableModels, ['user', 'new-authorized']);
  assert.equal(claude.model, 'user');
  assert.deepEqual(JSON.parse(await get(root, '.codex/wikivibe-models.json')).models.map(row => row.slug), ['new-authorized']);
  assert.deepEqual(Object.keys(JSON.parse(await get(root, '.config/opencode/opencode.json')).provider.wikivibe.models), ['new-authorized']);
  assert.deepEqual(JSON.parse(await get(root, '.pi/agent/models.json')).providers.wikivibe.models, refreshed.models);
  const omp = await get(root, '.omp/agent/models.yml');
  assert.match(omp, /- id: "new-authorized"/);
  assert.doesNotMatch(omp, /wv-code/);
  assert.deepEqual(Object.keys(JSON.parse(await get(root, '.aider.model.metadata.json'))), ['other/user', 'openai/new-authorized']);
  const qwen = JSON.parse(await get(root, '.qwen/settings.json'));
  assert.deepEqual(qwen.modelProviders.openai.map(row => row.id), ['new-authorized']);
  assert.equal(qwen.env.WIKIVIBE_API_KEY, refreshed.apiKey);
  assert.equal(qwen.model.name, 'user');
  assert.equal(qwen.security.auth.selectedType, 'anthropic');
  assert.deepEqual(JSON.parse(await get(root, '.pi/agent/settings.json')), { ...JSON.parse(originals['.pi/agent/settings.json']), enabledModels: ['other/*', 'wikivibe/new-authorized'] });
  assert.equal(await get(root, '.omp/agent/config.yml'), originals['.omp/agent/config.yml']);
  await restoreAgents(ids, { home: root });
  for (const [rel, bytes] of Object.entries(originals)) assert.equal(await get(root, rel), bytes);
  for (const rel of ['.codex/wikivibe-models.json', '.codex/wikivibe.config.toml', '.pi/agent/models.json', '.omp/agent/models.yml']) await assert.rejects(get(root, rel), { code: 'ENOENT' });
});

test('rejects invalid or unavailable catalog entries without any writes', async () => {
  const root = await home();
  for (const models of [undefined, [], [{ id: '' }], [{ id: 'bad\nmodel' }], [{ id: 'same' }, { id: 'same' }], [{ id: 'public-only', available: false }]]) {
    await reject(applyAgents(['opencode'], { ...value, models }, { home: root }), /каталог/);
    await reject(previewAgents(['opencode'], { baseUrl: endpoint, models }, { home: root }), /каталог/);
  }
  await reject(applyAgents(['opencode'], { baseUrl: endpoint, apiKey: value.apiKey, model: 'legacy-single' }, { home: root }), /каталог/);
  await assert.rejects(get(root, '.config/opencode/opencode.json'), { code: 'ENOENT' });
});

test('existing filters admit all 14 authorized models, preserve user entries, and refresh without stale additions', async () => {
  const root = await home();
  const roster = { ...value, models: Array.from({ length: 14 }, (_, i) => ({ id: `vendor/allowed-${i}` })) };
  const originals = {
    '.claude/settings.json': '{"model":"user","availableModels":["user","vendor/allowed-0"]}\n',
    '.config/opencode/opencode.json': '{"model":"other/user","enabled_providers":["other"],"disabled_providers":["wikivibe","blocked"]}\n',
    '.pi/agent/settings.json': '{"defaultProvider":"other","defaultModel":"user","enabledModels":["other/*","wikivibe/vendor/allowed-0"]}\n',
    '.omp/agent/config.yaml': '# keep\nmodelRoles:\n  default: other/user\nenabledModels:\n  - other/* # keep entry\n  - "wikivibe/vendor/allowed-0"\nenabledProviders: [other]\ndisabledProviders:\n  - wikivibe\n  - blocked\n'
  };
  for (const [rel, bytes] of Object.entries(originals)) await put(root, rel, bytes);
  const ids = ['claude', 'opencode', 'pi', 'omp'];
  await applyAgents(ids, roster, { home: root });
  const rawIds = roster.models.map(({ id }) => id);
  const qualified = rawIds.map(id => `wikivibe/${id}`);
  const claude = JSON.parse(await get(root, '.claude/settings.json'));
  assert.deepEqual(claude.availableModels, ['user', ...rawIds]);
  assert.equal(claude.model, 'user');
  const open = JSON.parse(await get(root, '.config/opencode/opencode.json'));
  assert.deepEqual(open.enabled_providers, ['other', 'wikivibe']);
  assert.deepEqual(open.disabled_providers, ['blocked']);
  assert.equal(open.model, 'other/user');
  const pi = JSON.parse(await get(root, '.pi/agent/settings.json'));
  assert.deepEqual(pi.enabledModels, ['other/*', ...qualified]);
  assert.equal(pi.defaultProvider, 'other');
  assert.equal(pi.defaultModel, 'user');
  const omp = await get(root, '.omp/agent/config.yaml');
  assert.deepEqual(JSON.parse(omp.match(/^enabledModels: (.+)$/m)[1]), ['other/*', ...qualified]);
  assert.deepEqual(JSON.parse(omp.match(/^enabledProviders: (.+)$/m)[1]), ['other', 'wikivibe']);
  assert.deepEqual(JSON.parse(omp.match(/^disabledProviders: (.+)$/m)[1]), ['blocked']);
  assert.match(omp, /# keep\nmodelRoles:\n  default: other\/user\n/);
  await applyAgents(ids, { ...value, models: [{ id: 'new' }] }, { home: root });
  assert.deepEqual(JSON.parse(await get(root, '.claude/settings.json')).availableModels, ['user', 'vendor/allowed-0', 'new']);
  assert.deepEqual(JSON.parse(await get(root, '.pi/agent/settings.json')).enabledModels, ['other/*', 'wikivibe/vendor/allowed-0', 'wikivibe/new']);
  assert.deepEqual(JSON.parse((await get(root, '.omp/agent/config.yaml')).match(/^enabledModels: (.+)$/m)[1]), ['other/*', 'wikivibe/vendor/allowed-0', 'wikivibe/new']);
  await restoreAgents(ids, { home: root });
  for (const [rel, bytes] of Object.entries(originals)) assert.equal(await get(root, rel), bytes);
});

test('filter files retain conflict protection and prevent earlier writes', async () => {
  for (const [id, rel, original, modelRel] of [
    ['pi', '.pi/agent/settings.json', '{"enabledModels":["other/*"]}\n', '.pi/agent/models.json'],
    ['omp', '.omp/agent/config.yml', 'enabledModels:\n  - other/*\n', '.omp/agent/models.yml']
  ]) {
    const root = await home();
    await put(root, rel, original);
    await applyAgents([id], value, { home: root });
    const models = await get(root, modelRel);
    const edited = `${await get(root, rel)}\n`;
    await writeFile(path.join(root, rel), edited);
    await reject(applyAgents([id], { ...value, models: [{ id: 'new' }] }, { home: root }), /конфликт/i);
    await reject(restoreAgents([id], { home: root }), /конфликт/i);
    assert.equal(await get(root, rel), edited);
    assert.equal(await get(root, modelRel), models);
  }
});

test('ambiguous filters refuse the whole plan instead of dropping restrictions', async () => {
  for (const [id, rel, bytes, modelRel] of [
    ['claude', '.claude/settings.json', '{"availableModels":"user"}\n', '.pi/agent/models.json'],
    ['opencode', '.config/opencode/opencode.json', '{"disabled_providers":[null]}\n', '.pi/agent/models.json'],
    ['pi', '.pi/agent/settings.json', '{"enabledModels":{}}\n', '.pi/agent/models.json'],
    ['omp', '.omp/agent/config.yml', 'enabledModels:\n  - other/*\n  - path: ~/work\n    models:\n      - other/model\n', '.omp/agent/models.yml'],
    ['omp', '.omp/agent/config.yml', 'enabledModels:\n  - other/*\nenabledModels: []\n', '.omp/agent/models.yml']
  ]) {
    const root = await home();
    await put(root, rel, bytes);
    await assert.rejects(applyAgents([id], value, { home: root }));
    assert.equal(await get(root, rel), bytes);
    await assert.rejects(get(root, modelRel), { code: 'ENOENT' });
  }
});

test('OMP empty provider and model scopes stay unrestricted and single disabled WikiVibe becomes an empty list', async () => {
  const root = await home();
  const original = 'enabledModels: []\nenabledProviders: []\ndisabledProviders: [wikivibe]\n';
  await put(root, '.omp/agent/config.yml', original);
  await applyAgents(['omp'], value, { home: root });
  assert.equal(await get(root, '.omp/agent/config.yml'), 'enabledModels: []\nenabledProviders: []\ndisabledProviders: []\n');
  await restoreAgents(['omp'], { home: root });
  assert.equal(await get(root, '.omp/agent/config.yml'), original);
});

test('catalog ownership conflicts preserve user files and prevent earlier writes in the same plan', async () => {
  const cases = [
    ['claude', '.claude/settings.json', '{"modelPicker":{"options":[{"model":"wv-code-1","label":"User"}]}}\n'],
    ['codex', '.codex/config.toml', '[model_providers.wikivibe]\nname = "User"\n'],
    ['codex', '.codex/wikivibe.config.toml', 'model = "user"\n'],
    ['codex', '.codex/wikivibe-models.json', '{"models":[]}\n'],
    ['opencode', '.config/opencode/opencode.json', '{"provider":{"wikivibe":{"name":"User"}}}\n'],
    ['pi', '.pi/agent/models.json', '{"providers":{"wikivibe":{"apiKey":"user-key"}}}\n'],
    ['omp', '.omp/agent/models.yml', 'providers:\n  wikivibe:\n    apiKey: user-key\n'],
    ['aider', '.aider.model.metadata.json', '{"openai/wv-code-1":{"mode":"chat","litellm_provider":"openai"}}\n'],
    ['qwen', '.qwen/settings.json', '{"modelProviders":{"openai":[{"id":"wv-code-1","envKey":"USER_KEY"}]}}\n'],
    ['qwen', '.qwen/settings.json', '{"env":{"WIKIVIBE_API_KEY":"user-key"}}\n']
  ];
  for (const [id, rel, bytes] of cases) {
    const root = await home();
    await put(root, rel, bytes);
    await reject(applyAgents([id], value, { home: root }), /существует|конфликт|используется|существуют/i);
    assert.equal(await get(root, rel), bytes);
    if (rel !== '.codex/config.toml') await assert.rejects(get(root, '.codex/config.toml'), { code: 'ENOENT' });
    if (id === 'aider') await assert.rejects(get(root, '.aider.conf.yml'), { code: 'ENOENT' });
  }
});

test('refresh refuses edited catalog files and keeps previous credentials and all user edits', async () => {
  const root = await home();
  await applyAgents(['codex'], value, { home: root });
  const changed = '{"models":[],"user":"keep"}\n';
  await writeFile(path.join(root, '.codex/wikivibe-models.json'), changed);
  const config = await get(root, '.codex/config.toml');
  await reject(applyAgents(['codex'], { ...value, models: [{ id: 'new' }] }, { home: root }), /конфликт/i);
  await reject(restoreAgents(['codex'], { home: root }), /конфликт/i);
  assert.equal(await get(root, '.codex/wikivibe-models.json'), changed);
  assert.equal(await get(root, '.codex/config.toml'), config);
});

async function legacy(root, agentId, rel, original, applied) {
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  await put(root, rel, applied, 0o600);
  const record = { version: 1, agentId, rel, state: 'active', appliedHash: digest(applied), original: original === null ? null : { base64: Buffer.from(original).toString('base64'), hash: digest(original), mode: 0o640 } };
  await put(root, path.join(path.dirname(rel), '.wikivibe-gateway-backups', path.basename(rel) + '.json'), JSON.stringify(record), 0o600);
}

test('upgrades prior plugin-owned model pins to catalogs and restores old Pi/OMP defaults', async () => {
  const root = await home();
  const files = [
    ['claude', '.claude/settings.json', '{"model":"user","env":{"ANTHROPIC_MODEL":"user-env"}}\n', '{"model":"old-plugin","env":{"ANTHROPIC_MODEL":"old-plugin","ANTHROPIC_AUTH_TOKEN":"old-key"}}\n'],
    ['codex', '.codex/config.toml', 'model = "user"\nmodel_provider = "openai"\n', 'model = "old-plugin"\nmodel_provider = "wikivibe"\n\n[model_providers.wikivibe]\nname = "WikiVibe"\n'],
    ['opencode', '.config/opencode/opencode.json', '{"model":"other/user"}\n', '{"model":"wikivibe/old-plugin","provider":{"wikivibe":{"models":{"old-plugin":{}}}}}\n'],
    ['pi', '.pi/agent/models.json', null, '{"providers":{"wikivibe":{"models":[{"id":"old-plugin"}]}}}\n'],
    ['pi', '.pi/agent/settings.json', '{"defaultProvider":"other","defaultModel":"user"}\n', '{"defaultProvider":"wikivibe","defaultModel":"old-plugin"}\n'],
    ['omp', '.omp/agent/models.yml', null, 'providers:\n  wikivibe:\n    models:\n      - id: old-plugin\n'],
    ['omp', '.omp/agent/config.yml', 'modelRoles:\n  default: other/user\n', 'modelRoles:\n  default: wikivibe/old-plugin\n'],
    ['aider', '.aider.conf.yml', 'model: "other/user"\n', 'model: "openai/old-plugin"\nopenai-api-key: "old-key"\n'],
    ['qwen', '.qwen/settings.json', '{"model":{"name":"user"},"security":{"auth":{"selectedType":"anthropic"}}}\n', '{"model":{"name":"old-plugin"},"modelProviders":{"openai":[{"id":"old-plugin","envKey":"WIKIVIBE_API_KEY"}]},"security":{"auth":{"selectedType":"openai"}}}\n']
  ];
  for (const args of files) await legacy(root, ...args);
  const ids = (await listAgents({ home: root })).map(agent => agent.id);
  const preview = await previewAgents(ids, value, { home: root });
  assert.equal(preview.changes.filter(change => change.description.includes('прежних настроек выбора')).length, 2);
  await applyAgents(ids, value, { home: root });
  assert.equal(JSON.parse(await get(root, '.claude/settings.json')).model, 'user');
  assert.equal(JSON.parse(await get(root, '.claude/settings.json')).env.ANTHROPIC_MODEL, 'user-env');
  assert.match(await get(root, '.codex/config.toml'), /model = "user"/);
  assert.equal(JSON.parse(await get(root, '.config/opencode/opencode.json')).model, 'other/user');
  assert.equal(await get(root, '.pi/agent/settings.json'), files[4][2]);
  assert.equal(await get(root, '.omp/agent/config.yml'), files[6][2]);
  assert.match(await get(root, '.aider.conf.yml'), /model: "other\/user"/);
  assert.equal(JSON.parse(await get(root, '.qwen/settings.json')).model.name, 'user');
  assert.equal(JSON.parse(await get(root, '.qwen/settings.json')).security.auth.selectedType, 'anthropic');
  await applyAgents(ids, { ...value, models: [{ id: 'replacement' }] }, { home: root });
  await restoreAgents(ids, { home: root });
  for (const [, rel, original] of files) {
    if (original === null) await assert.rejects(get(root, rel), { code: 'ENOENT' });
    else assert.equal(await get(root, rel), original);
  }
});

test('serializes concurrent roster refreshes and keeps original rollback state', async () => {
  const root = await home();
  const original = '{"model":"other/user"}\n';
  await put(root, '.config/opencode/opencode.json', original);
  await Promise.all([
    applyAgents(['opencode'], value, { home: root }),
    applyAgents(['opencode'], { ...value, models: [{ id: 'last-authorized' }] }, { home: root })
  ]);
  const finalIds = Object.keys(JSON.parse(await get(root, '.config/opencode/opencode.json')).provider.wikivibe.models);
  assert.ok(JSON.stringify(finalIds) === JSON.stringify(value.models.map(model => model.id)) || JSON.stringify(finalIds) === JSON.stringify(['last-authorized']));
  await restoreAgents(['opencode'], { home: root });
  assert.equal(await get(root, '.config/opencode/opencode.json'), original);
});

test('refuses catalog symlinks and hard links without altering their targets', async () => {
  for (const alias of [symlink, link]) {
    const root = await home();
    const original = '{"models":[],"user":"keep"}\n';
    const target = await put(root, 'user-catalog.json', original, 0o600);
    await mkdir(path.join(root, '.codex'), { mode: 0o700 });
    await alias(target, path.join(root, '.codex/wikivibe-models.json'));
    await reject(applyAgents(['codex'], value, { home: root }), /Небезопасный путь/);
    assert.equal(await get(root, 'user-catalog.json'), original);
    await assert.rejects(get(root, '.codex/config.toml'), { code: 'ENOENT' });
  }
});

test('rejects executable credentials, unsafe backup modes, and an existing mutation lock', async () => {
  const root = await home();
  for (const apiKey of ['!echo secret', '$TOKEN', 'API_KEY']) await reject(applyAgents(['pi'], { ...value, apiKey }, { home: root }), /само значение/);
  await put(root, '.wikivibe-gateway.lock', 'user-lock\n', 0o600);
  await reject(applyAgents(['codex'], value, { home: root }), /блокировки/);
  assert.equal(await get(root, '.wikivibe-gateway.lock'), 'user-lock\n');
  await rm(path.join(root, '.wikivibe-gateway.lock'));
  await applyAgents(['codex'], value, { home: root });
  const original = await get(root, '.codex/wikivibe-models.json');
  await chmod(path.join(root, '.codex/.wikivibe-gateway-backups/wikivibe-models.json.json'), 0o644);
  await reject(applyAgents(['codex'], { ...value, models: [{ id: 'new' }] }, { home: root }), /права резервной/);
  await reject(restoreAgents(['codex'], { home: root }), /права резервной/);
  assert.equal(await get(root, '.codex/wikivibe-models.json'), original);
});

test('fresh provider installation never creates selected-model settings', async () => {
  const root = await home();
  await applyAgents((await listAgents({ home: root })).map(agent => agent.id), value, { home: root });
  for (const rel of ['.claude/settings.json', '.config/opencode/opencode.json', '.qwen/settings.json']) {
    const config = JSON.parse(await get(root, rel));
    assert.equal(Object.hasOwn(config, 'model'), false);
    assert.equal(Object.hasOwn(config.env ?? {}, 'ANTHROPIC_MODEL'), false);
    if (rel.includes('.qwen')) assert.equal(Object.hasOwn(config, 'security'), false);
  }
  await assert.rejects(get(root, '.pi/agent/settings.json'), { code: 'ENOENT' });
  await assert.rejects(get(root, '.omp/agent/config.yml'), { code: 'ENOENT' });
  assert.doesNotMatch(await get(root, '.aider.conf.yml'), /^model:/m);
  assert.doesNotMatch(await get(root, '.codex/config.toml'), /^model(?:_provider)?\s*=/m);
  assert.doesNotMatch(await get(root, '.codex/wikivibe.config.toml'), /^model\s*=/m);
});

test('legacy default cleanup refuses later user changes before applying the new provider', async () => {
  const root = await home();
  await legacy(root, 'pi', '.pi/agent/settings.json', '{"defaultModel":"user"}\n', '{"defaultModel":"old-plugin","defaultProvider":"wikivibe"}\n');
  const user = '{"defaultModel":"new-user-choice"}\n';
  await writeFile(path.join(root, '.pi/agent/settings.json'), user);
  await reject(applyAgents(['pi'], value, { home: root }), /конфликт/i);
  assert.equal(await get(root, '.pi/agent/settings.json'), user);
  await assert.rejects(get(root, '.pi/agent/models.json'), { code: 'ENOENT' });
});

test('restores YAML spelling and rolls back originally absent legacy defaults', async () => {
  const root = await home();
  const models = '# user models\nproviders:\n  other:\n    baseUrl: https://other.invalid\n';
  await put(root, '.omp/agent/models.yaml', models);
  await legacy(root, 'omp', '.omp/agent/config.yaml', null, 'modelRoles:\n  default: wikivibe/old-plugin\n');
  await legacy(root, 'pi', '.pi/agent/settings.json', null, '{"defaultProvider":"wikivibe","defaultModel":"old-plugin"}\n');
  await applyAgents(['omp', 'pi'], value, { home: root });
  assert.match(await get(root, '.omp/agent/models.yaml'), /wikivibe:/);
  await assert.rejects(get(root, '.omp/agent/models.yml'), { code: 'ENOENT' });
  await assert.rejects(get(root, '.omp/agent/config.yaml'), { code: 'ENOENT' });
  await assert.rejects(get(root, '.pi/agent/settings.json'), { code: 'ENOENT' });
  await restoreAgents(['omp', 'pi'], { home: root });
  assert.equal(await get(root, '.omp/agent/models.yaml'), models);
});
