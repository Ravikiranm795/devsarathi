import * as fs from 'fs';
import * as path from 'path';

/** The nearest folder at or above `dir` that holds `.git` (a directory, or a file for worktrees and submodules). */
export function findRepoRoot(dir: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  let cur = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (exists(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

/**
 * Which workspace folder DevSarathi works on: the first one that is inside a git repository. Returns `undefined` when none
 * is, and the caller then asks the developer to choose.
 */
export function pickRepoRoot(folders: string[], exists?: (p: string) => boolean): string | undefined {
  for (const f of folders) {
    const r = findRepoRoot(f, exists);
    if (r) return r;
  }
  return undefined;
}
