import * as path from 'path';
import * as os from 'os';
import { STATE_DIR } from '@devsarathi/shared';

export interface RepoPaths {
  root: string;
  claude: string;
  state: string;
  config: string;
  graph: string;
  buildRecord: string;
  overlay: string;
  hooks: string;
  changelog: string;
  metricsDir: string;
  metricsJson: string;
  reviews: string;
  locks: string;
  logs: string;
  specsCache: string;
  backups: string;
  pendingRules: string;
}

export function repoPaths(root: string): RepoPaths {
  const r = path.resolve(root);
  const state = path.join(r, ...STATE_DIR.split('/'));
  return {
    root: r,
    claude: path.join(r, '.claude'),
    state,
    config: path.join(state, 'config.json'),
    graph: path.join(state, 'graph'),
    buildRecord: path.join(state, 'graph', 'build-record.json'),
    overlay: path.join(state, 'overlay'),
    hooks: path.join(state, 'hooks'),
    changelog: path.join(state, 'changelog.md'),
    metricsDir: path.join(state, 'metrics'),
    metricsJson: path.join(state, 'metrics', 'metrics.json'),
    reviews: path.join(state, 'reviews'),
    locks: path.join(state, 'locks'),
    logs: path.join(state, 'logs'),
    specsCache: path.join(state, 'specs-cache'),
    backups: path.join(state, 'backups'),
    pendingRules: path.join(state, 'pending-rules.json')
  };
}

/** ~/.devsarathi (override with DEVSARATHI_HOME, used by tests). */
export function userHome(): string {
  return process.env.DEVSARATHI_HOME || path.join(os.homedir(), '.devsarathi');
}

export function registryPath(): string {
  return path.join(userHome(), 'registry.json');
}

/** The shipped `templates/` folder (repo root in a checkout, package root once installed). */
export function templatesRoot(): string {
  // packages/core/{src|dist}/lib -> four levels up is the package root
  return path.resolve(__dirname, '..', '..', '..', '..', 'templates');
}

export function modelsDir(): string {
  return process.env.DEVSARATHI_MODEL_DIR || path.join(userHome(), 'models');
}
