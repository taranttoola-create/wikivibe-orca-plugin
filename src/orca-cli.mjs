import { join } from 'node:path';

export function resolveOrcaCli({ env = process.env, platform = process.platform, executable = process.execPath } = {}) {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  // Electron forks through a nested Helper.app. Its Resources has no CLI;
  // the public launcher belongs to the outer application bundle.
  const app = platform === 'darwin' && executable.match(/^(.*?\.app)\/Contents\//)?.[1];
  if (app) return join(app, 'Contents', 'Resources', 'bin', 'orca');
  return platform === 'linux' ? 'orca-ide' : 'orca';
}
