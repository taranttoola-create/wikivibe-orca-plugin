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
    throw new Error('Не удалось открыть браузер. Проверьте браузер по умолчанию и снова выполните «WikiVibe: Открыть защищённую настройку».');
  }
}

export default function activate(orca) {
  const service = createService(orca.host);
  let opening = Promise.resolve();
  orca.commands.register('configure', () => {
    const next = opening.then(async () => {
      if (!control || control.closed) control = await startControlServer(service);
      await openBrowser(control.url);
      await orca.host.call('notifications.show', { title: 'WikiVibe Gateway', body: 'Панель настройки открыта в браузере. Она доступна только на этом компьютере.' });
      return { opened: true };
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
