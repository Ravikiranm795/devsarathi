import * as path from 'path';
import { registryPath } from './paths';
import { readJson, writeJson } from './fsutil';

export interface RegistryEntry {
  path: string;
  name: string;
  stacks: string[];
  baselineBranch: string;
  registeredAt: string;
}

interface RegistryFile {
  version: 1;
  repos: RegistryEntry[];
}

const key = (p: string) => path.resolve(p).toLowerCase();

export function readRegistry(): RegistryEntry[] {
  return readJson<RegistryFile>(registryPath())?.repos ?? [];
}

/** ~/.devsarathi/registry.json lists configured repos for the dashboard (MASTER 18). Paths only, no repo data. */
export function registerRepo(entry: Omit<RegistryEntry, 'registeredAt' | 'name'> & { name?: string }): void {
  const repos = readRegistry().filter((r) => key(r.path) !== key(entry.path));
  repos.push({ ...entry, name: entry.name ?? path.basename(entry.path), registeredAt: new Date().toISOString() });
  writeJson(registryPath(), { version: 1, repos } satisfies RegistryFile);
}

export function unregisterRepo(repoPath: string): boolean {
  const before = readRegistry();
  const repos = before.filter((r) => key(r.path) !== key(repoPath));
  if (repos.length === before.length) return false;
  writeJson(registryPath(), { version: 1, repos } satisfies RegistryFile);
  return true;
}
