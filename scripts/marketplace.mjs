import { readFile } from 'node:fs/promises';
const [url, ref] = process.argv.slice(2);
if (!url || !ref || !/^(https:\/\/|ssh:\/\/|git@)/.test(url)) {
  throw new Error('Использование: node scripts/marketplace.mjs <HTTPS/SSH URL репозитория> <тег или полный SHA коммита>');
}
const manifest = JSON.parse(await readFile('orca-plugin.json', 'utf8'));
console.log(JSON.stringify({ name: 'WikiVibe Gateway для Orca', owner: manifest.publisher, plugins: [{
  id: `${manifest.publisher}.${manifest.id}`, source: { kind: 'git', url, ref },
  description: manifest.description, categories: ['agents', 'utilities']
}] }, null, 2));
