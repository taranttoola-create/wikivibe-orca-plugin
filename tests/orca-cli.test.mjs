import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrcaCli } from '../src/orca-cli.mjs';

test('macOS main and nested Helper workers use the outer app public launcher', () => {
  const app = '/Applications/Orca.app';
  for (const executable of [
    `${app}/Contents/MacOS/Orca`,
    `${app}/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper`,
    `${app}/Contents/Frameworks/Orca Helper (Renderer).app/Contents/MacOS/Orca Helper (Renderer)`
  ]) {
    assert.equal(resolveOrcaCli({ env: {}, platform: 'darwin', executable }), `${app}/Contents/Resources/bin/orca`);
  }
  assert.equal(resolveOrcaCli({ env: {}, platform: 'darwin', executable: '/Users/me/Orca builds/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper' }), '/Users/me/Orca builds/Orca.app/Contents/Resources/bin/orca');
});

test('explicit managed CLI and development runtime take precedence over the installed app', () => {
  const executable = '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper';
  assert.equal(resolveOrcaCli({ env: { ORCA_CLI_COMMAND: '/custom/orca', ORCA_DEV_REPO_ROOT: '/repo' }, platform: 'darwin', executable }), '/custom/orca');
  assert.equal(resolveOrcaCli({ env: { ORCA_DEV_REPO_ROOT: '/repo' }, platform: 'darwin', executable }), 'orca-dev');
  assert.equal(resolveOrcaCli({ env: {}, platform: 'linux', executable: '/usr/bin/node' }), 'orca-ide');
});
