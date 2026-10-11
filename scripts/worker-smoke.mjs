import { execFile, fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { REGISTRATION_URL } from '../src/client.mjs';

// Uses the installed Orca IPC worker, not a replacement plugin runtime.
const [executable, entry] = process.argv.slice(2);
if (!executable || !entry) throw new Error('Укажите исполняемый файл установленной Orca и путь к plugin-host-entry.');
const home = await mkdtemp(join(tmpdir(), 'wikivibe-worker-'));
const cli = process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'darwin' ? resolve(dirname(executable), '../Resources/bin/orca') : process.platform === 'linux' ? 'orca-ide' : 'orca');
const cliEnv = { ...process.env };
delete cliEnv.ORCA_PAIRING_CODE;
delete cliEnv.ORCA_ENVIRONMENT;
delete cliEnv.ORCA_CLI_CWD;
// The worker's agent home is isolated, but the real CLI must still discover
// the running desktop. This points at metadata, never reads or copies it.
const runtimeHome = process.env.ORCA_USER_DATA_PATH || (process.platform === 'darwin' ? join(process.env.HOME, 'Library', 'Application Support', 'orca') : process.platform === 'win32' ? join(process.env.APPDATA, 'orca') : join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'orca'));
const execute = promisify(execFile);
async function browser(args) {
  try {
    const { stdout } = await execute(cli, [...args, '--json'], { env: { ...cliEnv, ORCA_USER_DATA_PATH: runtimeHome }, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
    const response = JSON.parse(stdout);
    if (response.ok !== true) throw new Error();
    return response.result;
  } catch {
    throw new Error('Orca CLI не подтвердил браузерный шаг smoke. Откройте локальную Orca и выберите рабочее пространство. Содержимое ответа скрыто, чтобы не раскрыть token.');
  }
}
const child = fork(entry, [], { execPath: executable, cwd: home, env: { ...cliEnv, HOME: home, USERPROFILE: home, ORCA_USER_DATA_PATH: runtimeHome, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const pages = [];
const commands = ['configure', 'register', 'disconnect'];
let commandIndex = 0;
let timeout;
async function inspectPage(command, page) {
  const shown = await browser(['tab', 'show', '--page', page]);
  assert.ok(shown?.tab?.browserPageId === page && typeof shown.tab.worktreeId === 'string' && shown.tab.worktreeId.length > 0, 'Созданная вкладка должна принадлежать рабочему пространству Orca.');
  if (command === 'configure') {
    const url = new URL(shown.tab.url);
    assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/', 'Настройка должна открыться на loopback-адресе.');
    await browser(['wait', '--page', page, '--selector', '#connect-fields:not([disabled])', '--timeout', '10000']);
    const evaluated = await browser(['eval', '--page', page, '--expression', '({ready: document.title.startsWith("WikiVibe Gateway") && document.getElementById("connect-fields")?.disabled === false, tokenRemoved: location.hash === ""})']);
    const readiness = JSON.parse(evaluated.result);
    assert.ok(readiness.ready === true && readiness.tokenRemoved === true, 'Нужна загруженная и авторизованная страница настройки без token в адресе.');
    const imageResult = await browser(['eval', '--page', page, '--expression', '({loaded: document.querySelector(".brand img")?.complete && document.querySelector(".brand img")?.naturalWidth === 256})']);
    assert.equal(JSON.parse(imageResult.result).loaded, true);
    const before = (await browser(['tab', 'list', '--worktree', 'all'])).tabs.map(tab => tab.browserPageId);
    const snap = await browser(['snapshot', '--page', page]);
    const ref = Object.entries(snap.refs || {}).find(([, value]) => value.role === 'button' && value.name === 'Открыть WikiVibe и зарегистрироваться')?.[0];
    if (!ref) throw new Error('Не найдена кнопка регистрации в browser snapshot.');
    await browser(['click', '--page', page, '--element', ref]);
    let registrationMessage;
    const deadline = Date.now() + 25000;
    do {
      await new Promise(resolve => setTimeout(resolve, 500));
      registrationMessage = (await browser(['eval', '--page', page, '--expression', 'document.getElementById("message-text").textContent'])).result;
    } while (registrationMessage === 'Открывается вкладка WikiVibe в Orca…' && Date.now() < deadline);
    assert.equal(registrationMessage, 'WikiVibe открыт во встроенном браузере Orca.');
    const newTabs = (await browser(['tab', 'list', '--worktree', 'all'])).tabs.filter(tab => !before.includes(tab.browserPageId));
    assert.equal(newTabs.length, 1);
    pages.push(newTabs[0].browserPageId);
    await inspectPage('register', newTabs[0].browserPageId);
  } else {
    const url = new URL(shown.tab.url);
    assert.ok(url.protocol === 'https:' && ['api.wikivibe.dev', 'auth.wikivibe.dev'].includes(url.hostname) && !shown.tab.loadError, 'Нужна вкладка WikiVibe, включая штатный auth redirect.');
    const evaluated = await browser(['eval', '--page', page, '--expression', '(document.readyState !== "loading" && document.body !== null)']);
    assert.ok(evaluated?.result === 'true', 'Страница WikiVibe должна загрузиться во встроенном браузере.');
  }
}
try {
  await new Promise((resolveReady, reject) => {
    timeout = setTimeout(() => { reject(new Error('IPC worker smoke timed out')); child.kill(); }, 90000);
    child.once('error', () => reject(new Error('Не удалось запустить IPC worker установленной Orca.')));
    child.once('exit', code => reject(new Error(`worker exited before smoke completed (${code})`)));
    child.on('message', async message => {
      if (message.type === 'fatal') { reject(new Error('IPC worker завершился с ошибкой; детали скрыты для защиты token.')); return; }
      if (message.type === 'hostCall') {
        const value = message.method.endsWith('.get') ? { value: null } : { ok: true, delivered: true };
        child.send({ type: 'hostResult', callId: message.callId, ok: true, value });
      }
      if (message.type === 'ready') {
        child.send({ type: 'invokeCommand', callId: commandIndex, commandId: commands[commandIndex], args: {} });
      }
      if (message.type === 'commandResult') {
        try {
          if (message.ok !== true) throw new Error(typeof message.error === 'string' ? message.error : 'Команда IPC worker завершилась с ошибкой.');
          const command = commands[commandIndex];
          if (command === 'disconnect') assert.deepEqual(message.value, { disconnected: true });
          else {
            assert.ok(message.value?.opened === true && typeof message.value.browserPageId === 'string', 'Команда должна вернуть идентификатор настоящей вкладки Orca.');
            pages.push(message.value.browserPageId);
            await inspectPage(command, message.value.browserPageId);
          }
          commandIndex++;
          if (commandIndex === commands.length) { clearTimeout(timeout); resolveReady(); }
          else child.send({ type: 'invokeCommand', callId: commandIndex, commandId: commands[commandIndex], args: {} });
        } catch (error) { reject(error); }
      }
    });
    child.send({ type: 'init', pluginId: 'wikivibe.gateway', pluginRoot: resolve('.'), mainEntry: 'main.mjs', grantedCapabilities: ['storage', 'secrets', 'notifications:show'] });
  });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.send({ type: 'shutdown' });
  assert.equal(await exited, 0);
  console.log('IPC worker установленной Orca: настройка авторизована во встроенной вкладке, token удалён из адреса, вкладка регистрации загружена; удаление ключа и завершение проверены. Хранилище изолировано; установка через Settings не проверяется.');
} finally {
  clearTimeout(timeout);
  child.kill();
  for (const page of pages) await browser(['tab', 'close', '--page', page]).catch(() => {});
  await rm(home, { recursive: true, force: true });
}
