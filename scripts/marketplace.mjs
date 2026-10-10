import { readFile } from 'node:fs/promises';
const [url, ref] = process.argv.slice(2);
if (!url || !ref || !/^(https:\/\/|ssh:\/\/|git@)/.test(url)) {
  throw new Error('Usage: node scripts/marketplace.mjs <published HTTPS/SSH git URL> <tag-or-commit>');
}
const manifest = JSON.parse(await readFile('orca-plugin.json', 'utf8'));
console.log(JSON.stringify({ name: 'WikiVibe Plugins', owner: manifest.publisher, plugins: [{
  id: `${manifest.publisher}.${manifest.id}`, source: { kind: 'git', url, ref },
  description: manifest.description, categories: ['agents', 'utilities']
}] }, null, 2));
