import * as fs from 'fs';
import { ConfigSchema, DevSarathiConfig, CONFIG_SCHEMA_VERSION } from '@devsarathi/shared';
import { repoPaths } from './paths';
import { writeJson, exists } from './fsutil';

export const TOOL_VERSION: string = (() => {
  try {
    // packages/core/dist/lib -> repo root package.json
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../../../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

export function isInitialized(root: string): boolean {
  return exists(repoPaths(root).config);
}

export function loadConfig(root: string): DevSarathiConfig | undefined {
  const file = repoPaths(root).config;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return ConfigSchema.parse(raw);
  } catch {
    return undefined;
  }
}

export function requireConfig(root: string): DevSarathiConfig {
  const cfg = loadConfig(root);
  if (!cfg) throw new Error('DevSarathi is not initialized in this repo (or config.json is unreadable). Run: devsarathi init');
  return cfg;
}

export function saveConfig(root: string, cfg: DevSarathiConfig): void {
  writeJson(repoPaths(root).config, ConfigSchema.parse({ ...cfg, schemaVersion: CONFIG_SCHEMA_VERSION }));
}

export function updateConfig(root: string, mutate: (c: DevSarathiConfig) => void): DevSarathiConfig {
  const cfg = requireConfig(root);
  mutate(cfg);
  saveConfig(root, cfg);
  return cfg;
}
