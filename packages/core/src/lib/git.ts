import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs git with an argument ARRAY (never a shell string). */
export function git(args: string[], cwd: string, opts: { input?: string; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs ?? 120000, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | string | undefined) : 0;
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), code: typeof code === 'number' ? code : err ? 1 : 0 });
      }
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

export async function gitOut(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.stdout.trim() === 'true';
}

export async function repoRoot(cwd: string): Promise<string> {
  return path.resolve(await gitOut(['rev-parse', '--show-toplevel'], cwd));
}

export async function currentBranch(cwd: string): Promise<string> {
  const r = await git(['symbolic-ref', '--short', '-q', 'HEAD'], cwd);
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  return 'HEAD'; // detached
}

export async function headCommit(cwd: string, ref = 'HEAD'): Promise<string> {
  const r = await git(['rev-parse', ref], cwd);
  return r.ok ? r.stdout.trim() : '';
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  const r = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], cwd);
  return r.ok;
}

export async function localBranches(cwd: string): Promise<string[]> {
  const r = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], cwd);
  return r.ok
    ? r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/** Commits on `baseline` that the current branch does not have (0 when unknown). */
export async function commitsBehind(cwd: string, baseline: string): Promise<number> {
  const r = await git(['rev-list', '--count', `HEAD..${baseline}`], cwd);
  return r.ok ? Number(r.stdout.trim()) || 0 : 0;
}

/**
 * Temporary detached worktree of `ref`, so a baseline graph can be built without ever
 * switching the working branch (MASTER 5.7).
 */
export async function withWorktree<T>(cwd: string, ref: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsarathi-wt-'));
  const add = await git(['worktree', 'add', '--detach', '--quiet', dir, ref], cwd);
  if (!add.ok) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not create worktree for ${ref}: ${add.stderr.trim()}`);
  }
  try {
    return await fn(dir);
  } finally {
    await git(['worktree', 'remove', '--force', dir], cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    await git(['worktree', 'prune'], cwd);
  }
}

export async function gitDir(cwd: string): Promise<string> {
  const p = await gitOut(['rev-parse', '--git-dir'], cwd);
  return path.resolve(cwd, p);
}
