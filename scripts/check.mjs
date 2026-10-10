import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Script } from 'node:vm';

const manifest = JSON.parse(await readFile('orca-plugin.json', 'utf8'));
if (manifest.manifestVersion !== 1 || manifest.pluginApi !== 1 || !manifest.main) throw new Error('Некорректный manifest плагина Orca');
for (const file of [manifest.main, 'src/client.mjs', 'src/server.mjs', 'src/service.mjs', 'src/adapters.mjs']) {
  if (!(await stat(file)).isFile()) throw new Error(`Отсутствует файл плагина: ${file}`);
}
const checks = [];
const execute = promisify(execFile);
for (const dir of ['.', 'src', 'scripts', 'tests']) {
  for (const file of await readdir(dir)) {
    if (file.endsWith('.mjs')) checks.push(execute(process.execPath, ['--check', resolve(dir, file)], { timeout: 30000 }));
  }
}
await Promise.all(checks);
const html = await readFile('ui/index.html', 'utf8');
for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(match[1]);
console.log(`Синтаксис и файлы плагина проверены: ${manifest.publisher}.${manifest.id} ${manifest.version}`);
