import os from 'node:os';
import path from 'node:path';

export function getOpenModelHome() {
  if (process.env.OPENMODEL_HOME) return path.resolve(process.env.OPENMODEL_HOME);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'OpenModel');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OpenModel');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'openmodel');
}

export function getPaths() {
  const home = getOpenModelHome();
  return {
    home,
    models: path.join(home, 'models'),
    manifests: path.join(home, 'manifests'),
    config: path.join(home, 'config.json'),
    auth: path.join(home, 'auth.json'),
    temp: path.join(home, 'tmp'),
    plugins: path.join(home, 'plugins')
  };
}
