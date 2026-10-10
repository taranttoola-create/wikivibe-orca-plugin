import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Uses the installed Orca IPC worker, not a replacement plugin runtime.
const [executable, entry] = process.argv.slice(2);
if (!executable || !entry) throw new Error('Укажите исполняемый файл установленной Orca и путь к plugin-host-entry.');
const home = await mkdtemp(join(tmpdir(), 'wikivibe-worker-'));
const child = fork(entry, [], { execPath: executable, env: { PATH: process.env.PATH, HOME: home, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
const timeout = setTimeout(() => child.kill(), 20000);
try {
  await new Promise((resolveReady, reject) => {
    child.once('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
    child.on('message', message => {
      if (message.type === 'fatal') reject(new Error(message.error));
      if (message.type === 'hostCall') {
        const value = message.method.endsWith('.get') ? { value: null } : { ok: true, delivered: true };
        child.send({ type: 'hostResult', callId: message.callId, ok: true, value });
      }
      if (message.type === 'ready') {
        assert.deepEqual(message.commands.sort(), ['check', 'configure', 'disconnect']);
        child.send({ type: 'invokeCommand', callId: 0, commandId: 'disconnect', args: {} });
      }
      if (message.type === 'commandResult') {
        try {
          assert.equal(message.ok, true);
          assert.deepEqual(message.value, { disconnected: true });
          resolveReady();
        } catch (error) { reject(error); }
      }
    });
    child.send({ type: 'init', pluginId: 'wikivibe.gateway', pluginRoot: resolve('.'), mainEntry: 'main.mjs', grantedCapabilities: ['storage', 'secrets', 'notifications:show'] });
  });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.send({ type: 'shutdown' });
  assert.equal(await exited, 0);
  console.log('IPC worker установленной Orca: активация, команды, обращения к host API, удаление ключа и завершение проверены. Хранилище изолировано; установка через Settings не проверяется.');
} finally {
  clearTimeout(timeout);
  child.kill();
  await rm(home, { recursive: true, force: true });
}
