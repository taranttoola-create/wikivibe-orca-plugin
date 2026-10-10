import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listAgents, previewAgents, applyAgents, restoreAgents } from '../src/adapters.mjs';

const endpoint = 'https://api.wikivibe.dev/v1';
const value = { apiKey: 'wv-test-key-42', baseUrl: endpoint, model: 'wv-code-1' };
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
  assert.equal(result.changes.length, 2);
  assert.ok(result.changes.every(change => change.secretOnDisk === true));
  assert.deepEqual(await listAgents({ home: root }).then(agents => agents.map(agent => agent.configPath).filter(file => file.includes('.claude') || file.includes('.codex'))), [path.join(root, '.claude/settings.json'), path.join(root, '.codex/config.toml')]);
  await assert.rejects(get(root, '.claude/settings.json'), { code: 'ENOENT' });
  await assert.rejects(get(root, '.codex/config.toml'), { code: 'ENOENT' });
});

test('Claude JSON preserves unrelated fields and restores original bytes and mode', async () => {
  const root = await home();
  const original = '{\n  "permissions": {"allow": ["Read"]},\n  "env": {"CUSTOM": "keep"}\n}\n';
  const file = await put(root, '.claude/settings.json', original, 0o640);
  const applied = await applyAgents(['claude'], value, { home: root });
  assert.deepEqual(applied.applied.map(item => item.agentId), ['claude']);
  const changed = JSON.parse(await get(root, '.claude/settings.json'));
  assert.equal(changed.permissions.allow[0], 'Read');
  assert.equal(changed.env.CUSTOM, 'keep');
  assert.equal(changed.env.ANTHROPIC_BASE_URL, 'https://api.wikivibe.dev');
  assert.equal(changed.env.ANTHROPIC_AUTH_TOKEN, value.apiKey);
  assert.equal(changed.env.ANTHROPIC_MODEL, value.model);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  const restored = await restoreAgents(['claude'], { home: root });
  assert.deepEqual(restored.restored.map(item => item.agentId), ['claude']);
  assert.equal(await get(root, '.claude/settings.json'), original);
  assert.equal((await lstat(file)).mode & 0o777, 0o640);
});

test('Codex TOML preserves unrelated settings and writes documented responses provider', async () => {
  const root = await home();
  const original = '# user setting\nmodel = "existing"\napproval_policy = "on-request"\n\n[profiles.safe]\nmodel = "safe"\n';
  await put(root, '.codex/config.toml', original);
  await applyAgents(['codex'], value, { home: root });
  const changed = await get(root, '.codex/config.toml');
  assert.match(changed, /approval_policy = "on-request"/);
  assert.match(changed, /\[profiles\.safe\]/);
  assert.match(changed, /model_provider = "wikivibe"/);
  assert.match(changed, /\[model_providers\.wikivibe\]/);
  assert.match(changed, /wire_api = "responses"/);
  await restoreAgents(['codex'], { home: root });
  assert.equal(await get(root, '.codex/config.toml'), original);
});

test('OpenCode JSON preserves existing provider and uses OpenAI-compatible provider', async () => {
  const root = await home();
  const original = JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { edit: 'ask' }, provider: { openai: { options: { apiKey: 'unrelated' } } } }, null, 2) + '\n';
  await put(root, '.config/opencode/opencode.json', original);
  await applyAgents(['opencode'], value, { home: root });
  const changed = JSON.parse(await get(root, '.config/opencode/opencode.json'));
  assert.equal(changed.permission.edit, 'ask');
  assert.equal(changed.provider.openai.options.apiKey, 'unrelated');
  assert.equal(changed.provider.wikivibe.options.baseURL, endpoint);
  assert.equal(changed.provider.wikivibe.options.apiKey, value.apiKey);
  assert.equal(changed.model, 'wikivibe/wv-code-1');
  await restoreAgents(['opencode'], { home: root });
  assert.equal(await get(root, '.config/opencode/opencode.json'), original);
});

test('Pi config writes models and defaults while preserving unrelated settings', async () => {
  const root = await home();
  const settings = '{\n  "theme": "dark",\n  "defaultThinkingLevel": "high"\n}\n';
  const models = '{\n  "providers": {"other": {"baseUrl": "https://other.invalid", "models": [{"id": "other"}]}},\n  "modelOverrides": {"other": {"reasoning": true}}\n}\n';
  await put(root, '.pi/agent/settings.json', settings);
  await put(root, '.pi/agent/models.json', models);
  await applyAgents(['pi'], value, { home: root });
  assert.equal(JSON.parse(await get(root, '.pi/agent/settings.json')).theme, 'dark');
  const changed = JSON.parse(await get(root, '.pi/agent/models.json'));
  assert.equal(changed.providers.other.baseUrl, 'https://other.invalid');
  assert.equal(changed.providers.wikivibe.api, 'openai-completions');
  assert.equal(changed.providers.wikivibe.apiKey, value.apiKey);
  await restoreAgents(['pi'], { home: root });
  assert.equal(await get(root, '.pi/agent/settings.json'), settings);
  assert.equal(await get(root, '.pi/agent/models.json'), models);
});

test('OMP and Aider preserve YAML comments and unrelated values', async () => {
  const root = await home();
  const ompModels = '# keep this comment\nproviders:\n  other:\n    baseUrl: https://other.invalid\n';
  const ompConfig = 'modelRoles:\n  plan: other/model\n';
  const aider = '# aider user config\npretty: true\n';
  await put(root, '.omp/agent/models.yml', ompModels);
  await put(root, '.omp/agent/config.yml', ompConfig);
  await put(root, '.aider.conf.yml', aider);
  await applyAgents(['omp', 'aider'], value, { home: root });
  assert.match(await get(root, '.omp/agent/models.yml'), /# keep this comment/);
  assert.match(await get(root, '.omp/agent/models.yml'), /other:/);
  assert.match(await get(root, '.omp/agent/models.yml'), /wikivibe:/);
  assert.match(await get(root, '.omp/agent/config.yml'), /plan: other\/model/);
  assert.match(await get(root, '.omp/agent/config.yml'), /default: "wikivibe\/wv-code-1"/);
  assert.match(await get(root, '.aider.conf.yml'), /# aider user config/);
  assert.match(await get(root, '.aider.conf.yml'), /openai-api-base: "https:\/\/api.wikivibe.dev\/v1"/);
  assert.match(await get(root, '.aider.conf.yml'), /model: "openai\/wv-code-1"/);
  await restoreAgents(['omp', 'aider'], { home: root });
  assert.equal(await get(root, '.omp/agent/models.yml'), ompModels);
  assert.equal(await get(root, '.omp/agent/config.yml'), ompConfig);
  assert.equal(await get(root, '.aider.conf.yml'), aider);
});

test('Qwen settings preserves unrelated provider and restores after writing env key', async () => {
  const root = await home();
  const original = JSON.stringify({ modelProviders: { openai: [{ id: 'other', baseUrl: 'https://other.invalid' }] }, env: { KEEP: 'yes' }, model: { name: 'other' } }, null, 2) + '\n';
  await put(root, '.qwen/settings.json', original);
  await applyAgents(['qwen'], value, { home: root });
  const changed = JSON.parse(await get(root, '.qwen/settings.json'));
  assert.equal(changed.env.KEEP, 'yes');
  assert.equal(changed.env.WIKIVIBE_API_KEY, value.apiKey);
  assert.equal(changed.modelProviders.openai[0].id, 'other');
  assert.equal(changed.model.name, value.model);
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
