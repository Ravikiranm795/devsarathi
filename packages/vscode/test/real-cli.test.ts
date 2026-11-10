import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { startCli, startDashboardProcess, StageEvent, CliOutcome } from '../src/cli';
import { parseDetect, parseInitPreview, buildInitFlags, buildPreviewDoc } from '../src/wizard';
import { parseStatus, parsePending } from '../src/format';
import { evaluate } from '../src/result';

/* The parsers against the REAL CLI output (bin/devsarathi.js), on a throw-away git repo. Nothing here builds a graph. */

const BIN = path.resolve(__dirname, '..', '..', '..', 'bin', 'devsarathi.js');
let repo: string;
const env = { DEVSARATHI_EMBEDDER: 'fake', DEVSARATHI_HOME: '' };

const run = (command: string[], flags: string[] = [], positionals?: string[], onStage?: (e: StageEvent) => void): Promise<CliOutcome> =>
  startCli({ cliPath: BIN, root: repo, spec: { command, flags, positionals }, onStage, env: { ...env, DEVSARATHI_HOME: path.join(repo, '..', path.basename(repo) + '-home') } }).promise;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-real-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=Ravi Kiran', '-c', 'user.email=a@b.c', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', dependencies: { '@angular/core': '^17.0.0' } }));
  git('add', '.');
  git('commit', '-qm', 'init');
});
afterAll(async () => {
  // On Windows a just-killed child can hold its cwd for a moment; cleanup problems must not fail the run.
  await new Promise((r) => setTimeout(r, 500));
  for (const d of [repo, path.join(repo, '..', path.basename(repo) + '-home')]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      /* best effort */
    }
  }
});

describe('real CLI output', () => {
  it('detect --json parses into wizard data', async () => {
    const o = await run(['detect']);
    expect(o.status).toBe('result');
    if (o.status !== 'result') return;
    const d = parseDetect(o.result.data);
    expect(d).toBeDefined();
    expect(d!.stacks.map((s) => s.id)).toEqual(['angular']);
    expect(d!.baseline.options).toContain('main');
    expect(d!.persona.proposedTitle).toBe('Angular Developer');
    expect(d!.persona.needsConfirmation).toBe(false);
    expect(d!.optionalAgents).toEqual(['tester', 'security', 'peer-review', 'auditor']);
    expect(evaluate({ command: ['detect'] }, o).kind).toBe('ok');
  });

  it('status --json parses (not initialized) and rules pending is an empty list', async () => {
    const s = await run(['status']);
    expect(s.status === 'result' && parseStatus(s.result.data)).toMatchObject({ initialized: false, disabled: false, pendingRules: 0 });
    const p = await run(['rules', 'pending']);
    expect(p.status === 'result' && parsePending(p.result.data)).toEqual([]);
  });

  it('init --preview reports real stage lines on stderr and a preview the wizard can show', async () => {
    const d = parseDetect((((await run(['detect'])) as { result: { data: unknown } }).result.data))!;
    const flags = buildInitFlags(d, { baseline: 'main', persona: 'Ravi', title: '', agents: d.optionalAgents });
    const stages: StageEvent[] = [];
    const o = await run(['init'], ['--preview', ...flags], undefined, (e) => stages.push(e));
    expect(o.status).toBe('result');
    if (o.status !== 'result') return;
    expect(o.result.ok).toBe(true);
    expect(stages.map((s) => s.stage)).toContain('Scanning');
    const prev = parseInitPreview(o.result.data);
    expect(prev).toBeDefined();
    expect(prev!.files.length).toBeGreaterThan(3);
    expect(buildPreviewDoc(prev!)).toContain('| File | Status | Tokens | Loaded |');
    // preview writes nothing
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('a command that throws (needs init) comes back as failed with the CLI message, evaluated as "did not run"', async () => {
    const o = await run(['enhance'], [], ['do something']);
    expect(o.status).toBe('failed');
    const v = evaluate({ command: ['enhance'] }, o);
    expect(v.kind).toBe('not-run');
    expect(v.kind === 'not-run' && v.text).toMatch(/^devsarathi enhance did not run: DevSarathi is not initialized/);
  });

  it('a request that starts with a dash survives as a positional after `--`', async () => {
    const o = await run(['enhance'], [], ['-x hello']);
    expect(o.status).toBe('failed'); // fails on init, not on option parsing
    expect(o.status === 'failed' && o.error).not.toMatch(/unknown option/);
  });

  it('a missing CLI path is "unavailable"', async () => {
    const o = await startCli({ cliPath: path.join(repo, 'nope', 'devsarathi.js'), root: repo, spec: { command: ['status'] }, deps: { platform: 'win32', pathEnv: '', exists: () => false, readFile: () => '', execPath: process.execPath } }).promise;
    expect(o.status).toBe('unavailable');
  });

  it('cancel stops the child and reports cancelled, not a result', async () => {
    const r = startCli({ cliPath: BIN, root: repo, spec: { command: ['status'] } });
    r.cancel();
    expect((await r.promise).status).toBe('cancelled');
  });

  it('dashboard --no-open prints a 127.0.0.1 address that the extension accepts, and the child can be killed', async () => {
    const p = startDashboardProcess({ cliPath: BIN, root: repo, env: { DEVSARATHI_HOME: path.join(repo, '..', path.basename(repo) + '-home') } });
    try {
      const url = await p.ready;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    } finally {
      p.kill();
    }
  }, 30_000);
});
