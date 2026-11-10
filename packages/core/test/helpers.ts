import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

export function tmpDir(prefix = 'ds-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

/** A real git repo with one commit on `branch`. */
export function makeRepo(files: Record<string, string>, branch = 'main'): string {
  const dir = tmpDir('ds-repo-');
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function write(dir: string, rel: string, content: string): void {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ---- fixtures ----------------------------------------------------------------------------------------------

import { ConfigSchema, saveConfigFor } from './fixtureConfig';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test-fixtures');

export function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Copies a fixture into a fresh temp git repo (committed on `branch`) and writes a DevSarathi config for it. */
export function fixtureRepo(name: string, opts: { branch?: string; configure?: boolean } = {}): string {
  const dir = tmpDir(`ds-fx-${name}-`);
  copyDirSync(path.join(FIXTURES, name), dir);
  const branch = opts.branch ?? 'main';
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  if (opts.configure !== false) saveConfigFor(dir, branch);
  return dir;
}

export { ConfigSchema };
