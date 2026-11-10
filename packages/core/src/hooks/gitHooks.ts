import * as fs from 'fs';
import * as path from 'path';
import { DevSarathiConfig, GitHookRecord } from '@devsarathi/shared';
import { git, gitDir } from '../lib/git';
import { repoPaths } from '../lib/paths';
import { ensureDir, sha256, normalizeEol, exists } from '../lib/fsutil';

export const GIT_HOOKS = ['post-merge', 'post-rewrite', 'pre-push'] as const;
export type GitHookName = (typeof GIT_HOOKS)[number];

const MARKER = '# devsarathi:managed hook=';

export interface HooksDirInfo {
  dir: string;
  custom: boolean; // core.hooksPath set (Husky and friends)
  husky: boolean;
}

/** Where git will actually look for hooks: core.hooksPath when set, otherwise .git/hooks. */
export async function resolveHooksDir(root: string): Promise<HooksDirInfo> {
  const cfg = await git(['config', '--get', 'core.hooksPath'], root);
  if (cfg.ok && cfg.stdout.trim()) {
    const dir = path.resolve(root, cfg.stdout.trim());
    return { dir, custom: true, husky: /(^|[\\/])\.husky([\\/]|$)/.test(dir) };
  }
  const p = await git(['rev-parse', '--git-path', 'hooks'], root);
  const dir = p.ok ? path.resolve(root, p.stdout.trim()) : path.join(await gitDir(root), 'hooks');
  return { dir, custom: false, husky: false };
}

/**
 * The dispatcher git runs. POSIX sh (git for Windows ships one). It runs DevSarathi's runner, ignores its
 * result, then hands the original hook (when there was one) the same arguments and stdin, and exits with
 * the ORIGINAL's status, so DevSarathi can never turn a passing push into a failing one (I-2).
 */
export function dispatcherSource(hook: GitHookName, runnerPath: string, originalPath: string | null): string {
  const q = (s: string) => `'${s.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
  const stdinLine = hook === 'pre-push' ? 'INPUT=$(cat; printf x); INPUT=${INPUT%x}' : 'INPUT=""';
  const feed = hook === 'pre-push' ? `printf '%s' "$INPUT"` : 'true';
  const lines = [
    '#!/bin/sh',
    `${MARKER}${hook} v=1`,
    '# Installed by DevSarathi. Never blocks: its own step is fail-open and the original hook (if any) keeps its exit status.',
    stdinLine,
    'NODE_BIN=$(command -v node 2>/dev/null)',
    `if [ -n "$NODE_BIN" ] && [ -f ${q(runnerPath)} ]; then`,
    `  ${feed} | "$NODE_BIN" ${q(runnerPath)} ${hook} "$@" || true`,
    'fi'
  ];
  if (originalPath) {
    lines.push(`if [ -f ${q(originalPath)} ]; then`, `  ${feed} | sh ${q(originalPath)} "$@"`, '  exit $?', 'fi');
  }
  lines.push('exit 0', '');
  return lines.join('\n');
}

export interface HookInstallResult {
  installed: GitHookRecord[];
  notes: string[];
}

function isOurs(content: string): boolean {
  return content.includes(MARKER);
}

/**
 * Installs the three git hooks, chaining onto existing ones: the original is copied to a backup and invoked from
 * the dispatcher; uninstall restores it byte for byte. Re-running is idempotent.
 */
export async function installGitHooks(root: string, cfg: DevSarathiConfig, runnerPath: string): Promise<HookInstallResult> {
  const info = await resolveHooksDir(root);
  const p = repoPaths(root);
  ensureDir(info.dir);
  const notes: string[] = [];
  if (info.husky) notes.push('Husky manages this hooks folder and regenerates it on install; if the DevSarathi hooks disappear, run: devsarathi init');
  else if (info.custom) notes.push(`core.hooksPath points at ${info.dir}; DevSarathi installed its hooks there.`);

  const records = new Map(cfg.gitHooks.map((r) => [r.hook, r] as const));
  const installed: GitHookRecord[] = [];
  for (const hook of GIT_HOOKS) {
    const target = path.join(info.dir, hook);
    const prev = records.get(hook);
    let backup: string | null = prev?.backup ?? null;
    if (exists(target)) {
      const current = fs.readFileSync(target, 'utf8');
      if (!isOurs(current)) {
        // someone else's hook: save it, then chain to it
        backup = path.join(p.backups, 'git-hooks', `${hook}.orig`);
        ensureDir(path.dirname(backup));
        fs.copyFileSync(target, backup);
        notes.push(`Existing ${hook} hook found: DevSarathi chains onto it (backup: ${path.relative(root, backup)}).`);
      }
    }
    const src = dispatcherSource(hook, runnerPath, backup);
    fs.writeFileSync(target, src, { mode: 0o755 });
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      /* not meaningful on Windows */
    }
    const rec: GitHookRecord = { hook, path: target, backup, hash: sha256(normalizeEol(src)) };
    installed.push(rec);
  }
  return { installed, notes };
}

/** Restore the originals and remove only hooks that still carry our marker. */
export function uninstallGitHooks(cfg: DevSarathiConfig): { restored: string[]; removed: string[]; left: string[] } {
  const restored: string[] = [];
  const removed: string[] = [];
  const left: string[] = [];
  for (const rec of cfg.gitHooks) {
    let current: string | undefined;
    try {
      current = fs.readFileSync(rec.path, 'utf8');
    } catch {
      continue;
    }
    if (!isOurs(current)) {
      left.push(rec.path); // replaced by something else since: not ours to touch
      continue;
    }
    if (rec.backup && exists(rec.backup)) {
      fs.copyFileSync(rec.backup, rec.path);
      restored.push(rec.path);
    } else {
      fs.rmSync(rec.path, { force: true });
      removed.push(rec.path);
    }
  }
  return { restored, removed, left };
}

export async function gitHooksHealthy(root: string, cfg: DevSarathiConfig): Promise<{ missing: string[] }> {
  const info = await resolveHooksDir(root);
  const missing: string[] = [];
  for (const hook of GIT_HOOKS) {
    try {
      if (!isOurs(fs.readFileSync(path.join(info.dir, hook), 'utf8'))) missing.push(hook);
    } catch {
      missing.push(hook);
    }
  }
  void cfg;
  return { missing };
}

/** Keep the state folder out of `git status` without touching any tracked file: .git/info/exclude is local-only. */
export async function addGitExclude(root: string, entries: string[]): Promise<string[]> {
  const gd = await gitDir(root);
  // linked worktrees keep info/exclude in the common dir
  const common = await git(['rev-parse', '--git-common-dir'], root);
  const base = common.ok ? path.resolve(root, common.stdout.trim()) : gd;
  const file = path.join(base, 'info', 'exclude');
  ensureDir(path.dirname(file));
  const cur = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = entries.filter((e) => !have.has(e));
  if (add.length) fs.writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  return add;
}

export async function removeGitExclude(root: string, entries: string[]): Promise<void> {
  const common = await git(['rev-parse', '--git-common-dir'], root);
  if (!common.ok) return;
  const file = path.join(path.resolve(root, common.stdout.trim()), 'info', 'exclude');
  if (!exists(file)) return;
  const drop = new Set(entries);
  const kept = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !drop.has(l.trim()));
  fs.writeFileSync(file, kept.join('\n'));
}
