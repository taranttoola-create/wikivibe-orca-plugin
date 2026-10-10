import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createService } from './src/service.mjs';
import { startControlServer } from './src/server.mjs';

let control;
const execute = promisify(execFile);
async function openBrowser(url) {
  try {
    if (process.platform === 'darwin') await execute('/usr/bin/open', [url], { timeout: 5000 });
    else if (process.platform === 'win32') await execute('rundll32.exe', ['url.dll,FileProtocolHandler', url], { timeout: 5000 });
    else await execute('xdg-open', [url], { timeout: 5000 });
  } catch {
    throw new Error('Не удалось открыть браузер. Проверьте браузер по умолчанию и снова выполните WikiVibe: Настроить.');
  }
}

export default function activate(orca) {
  const service = createService(orca.host);
  let opening = Promise.resolve();
  orca.commands.register('configure', () => {
    const next = opening.then(async () => {
      if (!control || control.closed) control = await startControlServer(service);
      await openBrowser(control.url);
      await orca.host.call('notifications.show', { title: 'WikiVibe', body: 'Настройка открыта в браузере. Страница работает только на этом компьютере.' });
      return { opened: true };
    });
    opening = next.catch(() => {});
    return next;
  });
  orca.commands.register('check', async () => {
    const { models } = await service.request('models');
    await orca.host.call('notifications.show', { title: 'WikiVibe: подключено', body: `Доступно моделей: ${models.length}.` });
    return { connected: true, models: models.length };
  });
  orca.commands.register('disconnect', async () => {
    await service.request('disconnect');
    await orca.host.call('notifications.show', { title: 'WikiVibe: ключ удалён', body: 'Ключ удалён из vault плагина. Файлы агентов не изменены: восстановите их через настройку плагина или отзовите ключ в WikiVibe.' });
    return { disconnected: true };
  });
}

export async function deactivate() {
  await control?.close();
  control = undefined;
}
