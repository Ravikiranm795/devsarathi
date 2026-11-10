import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  acquireLock,
  runWithQueue,
  isStale,
  failOpen,
  isDisabled,
  repoPaths,
  saveConfig,
  loadConfig,
  redact,
  isSecretFile,
  runCommand,
  listCommands,
  withWorktree,
  currentBranch,
  createLogger
} from '../src';
import { ConfigSchema } from '@devsarathi/shared';
import { tmpDir, rmrf, makeRepo, write } from './helpers';

const dirs: string[] = [];
const mk = (d: string) => (dirs.push(d), d);
afterEach(() => {
  while (dirs.length) rmrf(dirs.pop() as string);
});

function baseConfig(root: string, over: Record<string, unknown> = {}) {
  saveConfig(root, ConfigSchema.parse({ toolVersion: '0.1.0', baselineBranch: 'main', persona: { name: 'Asha', title: 'Angular Developer' }, ...over }));
}

describe('locks', () => {
  it('queues exactly one follow-up while a lock is held', () => {
    const d = mk(tmpDir());
    const a = acquireLock(d, 'graph');
    expect(a.acquired).toBe(true);
    const b = acquireLock(d, 'graph');
    const c = acquireLock(d, 'graph');
    expect(b.acquired).toBe(false);
    expect(c.acquired).toBe(false);
    expect(fs.readdirSync(d).filter((f) => f.endsWith('.queued'))).toHaveLength(1);
    expect(a.release()).toBe(true); // a follow-up was queued
    expect(fs.readdirSync(d)).toHaveLength(0);
  });

  it('recovers a stale lock whose PID is dead', () => {
    const d = mk(tmpDir());
    fs.writeFileSync(path.join(d, 'graph.lock'), JSON.stringify({ pid: 2147480000, startedAt: Date.now() }));
    const h = acquireLock(d, 'graph');
    expect(h.acquired).toBe(true);
    h.release();
  });

  it('treats a lock older than the timeout as stale even when the PID is alive', () => {
    expect(isStale({ pid: process.pid, startedAt: Date.now() - 10_000 }, 5_000)).toBe(true);
    expect(isStale({ pid: process.pid, startedAt: Date.now() }, 5_000)).toBe(false);
  });

  it('runWithQueue runs once more when a request arrives during a run, never stacks', async () => {
    const d = mk(tmpDir());
    let runs = 0;
    const res = await runWithQueue(d, 'graph', async () => {
      runs++;
      if (runs === 1) {
        // three requests arrive while the first run is in progress
        acquireLock(d, 'graph');
        acquireLock(d, 'graph');
        acquireLock(d, 'graph');
      }
    });
    expect(res.ran).toBe(true);
    expect(runs).toBe(2);
    expect(res.reruns).toBe(1);
  });
});

describe('config + kill switch + fail-open (I-2/I-3)', () => {
  it('round-trips config and applies defaults', () => {
    const root = mk(tmpDir());
    baseConfig(root);
    const cfg = loadConfig(root)!;
    expect(cfg.thresholds.coverage).toBe(0.8);
    expect(cfg.agents.tester).toBe(true);
    expect(cfg.disabled).toBe(false);
  });

  it('a hook body that throws still yields exit 0 and a visible notice', async () => {
    const root = mk(tmpDir());
    baseConfig(root);
    const code = await failOpen(root, 'pre-push', async () => {
      throw new Error('boom');
    });
    expect(code).toBe(0);
    const notices = fs.readFileSync(path.join(repoPaths(root).state, 'notices.jsonl'), 'utf8');
    expect(notices).toContain('pre-push did not run: boom');
  });

  it('kill switch makes the hook body not run', async () => {
    const root = mk(tmpDir());
    baseConfig(root, { disabled: true });
    expect(isDisabled(root)).toBe(true);
    let ran = false;
    const code = await failOpen(root, 'post-merge', async () => {
      ran = true;
    });
    expect(code).toBe(0);
    expect(ran).toBe(false);
  });

  it('disable and enable commands flip the switch', async () => {
    const root = mk(tmpDir());
    baseConfig(root);
    const ctx = { repoRoot: root, log: createLogger(undefined), progress: () => undefined };
    expect((await runCommand('disable', {}, ctx)).ok).toBe(true);
    expect(isDisabled(root)).toBe(true);
    expect((await runCommand('enable', {}, ctx)).ok).toBe(true);
    expect(isDisabled(root)).toBe(false);
  });
});

describe('secret handling (I-8)', () => {
  const fakeAws = 'AKIAIOSFODNN7EXAMPLE';
  it('redacts known key shapes', () => {
    const out = redact(`key=${fakeAws} and token ghp_${'a'.repeat(36)}`);
    expect(out).not.toContain(fakeAws);
    expect(out).not.toContain('a'.repeat(36));
  });
  it('the logger never writes a secret value', () => {
    const d = mk(tmpDir());
    const log = createLogger(d);
    log.info(`found ${fakeAws}`);
    expect(fs.readFileSync(path.join(d, 'devsarathi.log'), 'utf8')).not.toContain(fakeAws);
  });
  it('recognises env and key files but not .env.example', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('config/.env.production')).toBe(true);
    expect(isSecretFile('certs/server.pem')).toBe(true);
    expect(isSecretFile('.env.example')).toBe(false);
    expect(isSecretFile('src/app.ts')).toBe(false);
  });
});

describe('registry', () => {
  it('registers builtin commands and rejects unknown ones', async () => {
    expect(listCommands().map((c) => c.name)).toEqual(expect.arrayContaining(['status', 'disable', 'enable']));
    const ctx = { repoRoot: tmpDir(), log: createLogger(undefined), progress: () => undefined };
    dirs.push(ctx.repoRoot);
    const res = await runCommand('nope', {}, ctx);
    expect(res.ok).toBe(false);
  });
});

describe('git helpers', () => {
  it('builds in a temp worktree without switching the working branch', async () => {
    const repo = mk(makeRepo({ 'a.txt': 'one' }, 'main'));
    const { execFileSync } = await import('child_process');
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo });
    write(repo, 'feature-only.txt', 'x');
    let seen = '';
    await withWorktree(repo, 'main', async (dir) => {
      seen = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort().join(',');
    });
    expect(seen).toBe('a.txt');
    expect(await currentBranch(repo)).toBe('feature');
    expect(fs.existsSync(path.join(repo, 'feature-only.txt'))).toBe(true);
  });
});
