import { mkdtemp, rm, realpath, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { applyAgents, restoreAgents } from '../src/adapters.mjs';

const [binary, agent = 'opencode'] = process.argv.slice(2);
if (!binary || !['opencode', 'omp'].includes(agent)) throw new Error('Укажите путь к установленному OpenCode/OMP и при необходимости ID агента.');
const home = await realpath(await mkdtemp(join(tmpdir(), 'wikivibe-agent-')));
const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state') };
const execute = promisify(execFile);
let server;
try {
  const ids = Array.from({ length: 14 }, (_, i) => `wikivibe-smoke-model-${i}`);
  if (agent === 'opencode') {
    await mkdir(join(home, '.config/opencode'), { recursive: true });
    await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ enabled_providers: ['other'], disabled_providers: ['wikivibe', 'blocked'] }));
  } else {
    await mkdir(join(home, '.omp/agent'), { recursive: true });
    await writeFile(join(home, '.omp/agent/config.yml'), 'enabledModels:\n  - other/*\nenabledProviders:\n  - other\ndisabledProviders:\n  - wikivibe\n  - blocked\n');
  }
  await applyAgents([agent], { apiKey: 'smoke-fixture-credential', baseUrl: 'https://api.wikivibe.dev/v1', models: ids.map(id => ({ id })) }, { home });
  const { stdout: version } = await execute(binary, ['--version'], { env, cwd: home, timeout: 15000 });
  if (agent === 'opencode' && /(?:^|\s)v?2\./.test(version)) {
    server = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
    const { url, password } = await new Promise((resolve, reject) => {
      let log = '';
      const timer = setTimeout(() => reject(new Error('OpenCode readiness timeout; server output withheld to protect credentials.')), 30000);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error('OpenCode exited before readiness.')); });
      function data(chunk) {
        log += chunk;
        const url = log.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        const password = log.match(/server password (\S+)/)?.[1];
        if (url && password) { clearTimeout(timer); resolve({ url, password }); }
      }
      server.stdout.on('data', data);
      server.stderr.on('data', data);
    });
    const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
    // V2's cold model.list can race asynchronous plugin activation. Use its barrier.
    const activation = await fetch(`${url}/api/plugin/await-activation`, { method: 'POST', headers, signal: AbortSignal.timeout(120000) });
    assert.equal(activation.status, 204);
    const response = await fetch(`${url}/api/model`, { headers, signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.filter(model => model.providerID === 'wikivibe').map(model => model.id).sort(), [...ids].sort());
    const providerResponse = await fetch(`${url}/api/provider`, { headers, signal: AbortSignal.timeout(30000) });
    assert.equal(providerResponse.status, 200);
    const providers = (await providerResponse.json()).data;
    assert.equal(providers.find(provider => provider.id === 'wikivibe')?.activation, 'enabled');
  } else {
    const args = agent === 'omp' ? ['models', 'wikivibe', '--json', '--no-extensions'] : ['models'];
    const { stdout, stderr } = await execute(binary, args, { cwd: home, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    for (const id of ids) assert.ok((stdout + stderr).includes(id), `CLI did not expose imported model: ${id}`);
  }
  console.log(`Установленный ${agent} показал все ${ids.length} моделей WikiVibe во временном HOME с исходными ограничениями. Запрос к модели не выполнялся.`);
  if (server) { const exited = once(server, 'exit'); server.kill(); await exited; server = undefined; }
  await restoreAgents([agent], { home });
} finally {
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  await rm(home, { recursive: true, force: true });
}
