import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { REGISTRATION_URL } from './src/client.mjs';
import { createService } from './src/service.mjs';
import { startControlServer } from './src/server.mjs';

let control;
const execute = promisify(execFile);
function orcaCli() {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  if (process.env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  // The installed macOS worker runs under Orca's Electron executable. Use
  // that app's public launcher even when the desktop PATH lacks `orca`.
  if (process.platform === 'darwin' && /\.app\/Contents\/MacOS\/[^/]+$/.test(process.execPath)) {
    return resolve(dirname(process.execPath), '../Resources/bin/orca');
  }
  return process.platform === 'linux' ? 'orca-ide' : 'orca';
}

async function browserCommand(args, timeout) {
  try {
    // Localhost belongs to this worker, never an inherited paired runtime.
    const env = { ...process.env };
    delete env.ORCA_PAIRING_CODE;
    delete env.ORCA_ENVIRONMENT;
    delete env.ORCA_CLI_CWD;
    const { stdout } = await execute(orcaCli(), [...args, '--json'], { env, timeout, maxBuffer: 1024 * 1024, windowsHide: true });
    const response = JSON.parse(stdout);
    if (response.ok !== true) throw new Error();
    return response.result;
  } catch {
    // execFile errors include argv/stdout, which may contain the setup token.
    throw new Error('Не удалось открыть вкладку во встроенном браузере Orca. Откройте локальную Orca, выберите рабочее пространство и повторите команду. Нужен доступный публичный Orca CLI; внешний браузер не используется.');
  }
}

async function openBrowser(url) {
  const status = await browserCommand(['status'], 3000);
  if (status?.app?.desktopWindowStatus !== 'available') {
    throw new Error('Для настройки нужен встроенный браузер локального приложения Orca. Откройте Orca и выберите рабочее пространство; внешний или фоновый браузер не используется.');
  }
  // `active` and an omitted selector infer the CLI cwd, not the desktop's
  // selection. `all` deliberately removes that filter: the desktop creates
  // the tab in its selected workspace and refuses when none is selected.
  const result = await browserCommand(['tab', 'create', '--worktree', 'all', '--url', url], 13000);
  if (typeof result?.browserPageId !== 'string' || !result.browserPageId) {
    throw new Error('Orca CLI не подтвердил создание вкладки. Повторите команду в локальной Orca.');
  }
  const shown = await browserCommand(['tab', 'show', '--page', result.browserPageId], 4000);
  const expected = new URL(url);
  let destination;
  try { destination = new URL(shown?.tab?.url); } catch {}
  const registration = url === REGISTRATION_URL;
  const registrationDestination = destination?.protocol === 'https:' && ['api.wikivibe.dev', 'auth.wikivibe.dev'].includes(destination.hostname);
  const setupDestination = destination && destination.origin === expected.origin && destination.pathname === expected.pathname && destination.search === expected.search;
  if (!shown?.tab?.worktreeId || shown.tab.loadError || !(registration ? registrationDestination : setupDestination)) {
    throw new Error('Вкладка Orca создана, но загрузка нужной страницы не подтверждена. Повторите команду в локальной Orca; внешний браузер не используется.');
  }
  await browserCommand(['tab', 'switch', '--page', result.browserPageId, '--focus'], 6000);
  return { opened: true, browserPageId: result.browserPageId };
}

export default function activate(orca) {
  const service = createService(orca.host, { openRegistration: () => openBrowser(REGISTRATION_URL) });
  let opening = Promise.resolve();
  orca.commands.register('register', async () => {
    const opened = await openBrowser(REGISTRATION_URL);
    await orca.host.call('notifications.show', { title: 'WikiVibe', body: 'Вкладка регистрации WikiVibe открыта во встроенном браузере Orca.' });
    return opened;
  });
  orca.commands.register('configure', () => {
    const next = opening.then(async () => {
      if (!control || control.closed) control = await startControlServer(service);
      const opened = await openBrowser(control.url);
      await orca.host.call('notifications.show', { title: 'WikiVibe Gateway', body: 'Вкладка защищённой настройки открыта во встроенном браузере Orca. Она доступна только на этом компьютере.' });
      return opened;
    });
    opening = next.catch(() => {});
    return next;
  });
  orca.commands.register('check', async () => {
    const { models } = await service.request('models');
    await orca.host.call('notifications.show', { title: 'WikiVibe: ключ проверен', body: `API вернул моделей: ${models.length}. Запрос к модели и совместимость с агентом не проверялись.` });
    return { connected: true, models: models.length };
  });
  orca.commands.register('disconnect', async () => {
    await service.request('disconnect');
    await orca.host.call('notifications.show', { title: 'WikiVibe: сохранённый ключ удалён', body: 'Ключ удалён из защищённого хранилища плагина в Orca. Файлы агентов не изменены; записанный в них ключ остаётся на диске. Восстановите файлы через панель настройки или отзовите ключ в WikiVibe.' });
    return { disconnected: true };
  });
}

export async function deactivate() {
  await control?.close();
  control = undefined;
}
