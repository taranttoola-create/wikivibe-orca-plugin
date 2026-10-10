import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { applyAgents, restoreAgents } from '../src/adapters.mjs';

const [binary, agent = 'opencode'] = process.argv.slice(2);
if (!binary || !['opencode', 'omp'].includes(agent)) throw new Error('Укажите путь к установленному OpenCode/OMP и при необходимости ID агента.');
const home = await mkdtemp(join(tmpdir(), 'wikivibe-agent-'));
try {
  await applyAgents([agent], { apiKey: 'smoke-fixture-credential', baseUrl: 'https://api.wikivibe.dev/v1', model: 'wikivibe-smoke-model' }, { home });
  const args = agent === 'omp' ? ['models', 'wikivibe', '--json', '--no-extensions'] : ['debug', 'config'];
  const { stdout, stderr } = await promisify(execFile)(binary, args, {
    cwd: home, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state') }
  });
  if (agent === 'omp') assert.match(stdout + stderr, /wikivibe-smoke-model/);
  else {
    const resolved = JSON.parse(stdout).find(source => source.info?.providers?.wikivibe)?.info;
    assert.deepEqual(resolved.model, { providerID: 'wikivibe', model: 'wikivibe-smoke-model' });
    assert.equal(resolved.providers.wikivibe.settings.baseURL, 'https://api.wikivibe.dev/v1');
    assert.equal(resolved.providers.wikivibe.settings.apiKey, 'smoke-fixture-credential');
    assert.equal(resolved.providers.wikivibe.package, 'aisdk:@ai-sdk/openai-compatible');
  }
  console.log(`Установленный ${agent} прочитал конфигурацию WikiVibe во временном HOME. Запрос к модели не выполнялся.`);
  await restoreAgents([agent], { home });
} finally { await rm(home, { recursive: true, force: true }); }
