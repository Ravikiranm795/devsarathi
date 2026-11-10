import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import {
  runCommand,
  createLogger,
  loadConfig,
  saveConfig,
  repoPaths,
  readEvents,
  readRegistry,
  computeMetricsFrom,
  tasksFromEvents,
  computeMetrics,
  toMarkdown,
  collectStatus,
  statusLine,
  userHome,
  recordEvent
} from '../src';
import { tmpDir, rmrf, git, fixtureRepo, write } from './helpers';

const dirs: string[] = [];
const mk = <T extends string>(d: T): T => (dirs.push(d), d);
const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.DEVSARATHI_EMBEDDER = 'fake';
  process.env.DEVSARATHI_HOME = mk(tmpDir('ds-home-'));
});
afterAll(() => {
  process.env = { ...savedEnv };
  while (dirs.length) rmrf(dirs.pop() as string);
});

const ctxFor = (root: string) => ({ repoRoot: root, log: createLogger(undefined), progress: () => undefined });
async function initialized(fx: string, args: Record<string, unknown> = {}): Promise<string> {
  const repo = mk(fixtureRepo(fx, { configure: false }));
  const r = await runCommand('init', { yes: true, persona: 'Asha', ...args }, ctxFor(repo));
  expect(r.ok, r.message).toBe(true);
  return repo;
}
const ev = (t: string, type: string, data?: Record<string, string | number | boolean | null>) => ({ t, type, data });
const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, 0) + min * 60000).toISOString();

describe('turns per task (Q-02)', () => {
  it('a task is the prompts between the first prompt and the next agent stop; idle time splits tasks', () => {
    const tasks = tasksFromEvents([
      ev(at(0), 'prompt'), ev(at(2), 'prompt'), ev(at(5), 'prompt'), ev(at(6), 'task-end'),
      ev(at(10), 'prompt'), ev(at(11), 'task-end'),
      ev(at(20), 'prompt'), ev(at(80), 'prompt') // more than 30 minutes idle: a second task starts
    ]);
    expect(tasks.map((t) => t.turns)).toEqual([3, 1, 1, 1]);
  });

  it('compares the first seven days with the tasks that used the enhancer, and reports acceptance beside it', () => {
    const events = [
      // baseline week: 5 and 7 turns, no enhancer
      ev(at(0), 'prompt'), ev(at(1), 'prompt'), ev(at(2), 'prompt'), ev(at(3), 'prompt'), ev(at(4), 'prompt'), ev(at(5), 'task-end'),
      ev(at(10), 'prompt'), ev(at(11), 'prompt'), ev(at(12), 'prompt'), ev(at(13), 'prompt'), ev(at(14), 'prompt'), ev(at(15), 'prompt'), ev(at(16), 'prompt'), ev(at(17), 'task-end'),
      // later: tasks with the enhancer take 2 and 4 turns
      ev(at(60 * 24 * 9), 'enhance', { status: 'ready' }), ev(at(60 * 24 * 9 + 1), 'prompt'), ev(at(60 * 24 * 9 + 2), 'prompt'), ev(at(60 * 24 * 9 + 3), 'task-end'),
      ev(at(60 * 24 * 10), 'enhance', { status: 'ready' }), ev(at(60 * 24 * 10 + 1), 'prompt'), ev(at(60 * 24 * 10 + 2), 'prompt'), ev(at(60 * 24 * 10 + 3), 'prompt'), ev(at(60 * 24 * 10 + 4), 'prompt'), ev(at(60 * 24 * 10 + 5), 'task-end'),
      ev(at(60 * 24 * 10 + 10), 'enhance-outcome', { outcome: 'accepted' }),
      ev(at(60 * 24 * 10 + 11), 'enhance-outcome', { outcome: 'edited' }),
      ev(at(60 * 24 * 10 + 12), 'enhance-outcome', { outcome: 'accepted' }),
      ev(at(60 * 24 * 10 + 13), 'enhance-outcome', { outcome: 'rejected' })
    ];
    const m = computeMetricsFrom(events, { repo: 'demo', initializedAt: at(0), now: new Date(at(60 * 24 * 11)) });
    expect(m.turnsPerTask.baseline).toEqual({ tasks: 2, avgTurns: 6 });
    expect(m.turnsPerTask.withEnhancer).toEqual({ tasks: 2, avgTurns: 3 });
    expect(m.turnsPerTask.improvement).toBe(0.5);
    expect(m.prompts).toMatchObject({ enhanced: 2, accepted: 2, edited: 1, rejected: 1, acceptanceRate: 0.5 });
    expect(m.turnsPerTask.note).toMatch(/acceptance/i);
  });

  it('has no before-and-after claim until both groups have data', () => {
    const m = computeMetricsFrom([ev(at(0), 'prompt'), ev(at(1), 'task-end')], { repo: 'demo', initializedAt: at(0) });
    expect(m.turnsPerTask.improvement).toBeNull();
    expect(m.prompts.acceptanceRate).toBeNull();
  });
});

describe('metrics end to end (MASTER 16, D-18)', () => {
  it('every metric is collected into metrics.json, and the markdown and Word reports agree with it', async () => {
    const repo = await initialized('python-fastapi');
    write(repo, 'specs/s.md', '# S\n\n## Acceptance criteria\n- AC-1: users can be looked up by id\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'spec');
    await runCommand('enhance', { request: 'confidential payroll lookup', spec: 'specs/s.md' }, ctxFor(repo));
    await runCommand('enhance', { outcome: 'accepted' }, ctxFor(repo));
    recordEvent(repo, { type: 'prompt' });
    recordEvent(repo, { type: 'task-end' });

    // a review with a finding, then a fix: the finding counts as acted on
    git(repo, 'checkout', '-q', '-b', 'feature/m');
    write(repo, 'app/noisy.py', 'def noisy(x):\n    print("debug", x)\n    return x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'noisy');
    const base = git(repo, 'rev-parse', 'main');
    const first = await runCommand('review', { range: `${base}..HEAD`, trigger: 'pre-push' }, ctxFor(repo));
    expect(first.message).toMatch(/Debug output left in code/);
    write(repo, 'app/noisy.py', 'def noisy(x):\n    return x\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fix');
    await runCommand('review', { range: `${base}..HEAD`, trigger: 'pre-push' }, ctxFor(repo));
    await runCommand('status', {}, ctxFor(repo));

    const res = await runCommand('metrics', { report: true }, ctxFor(repo));
    expect(res.ok, res.message).toBe(true);
    const m = JSON.parse(fs.readFileSync(repoPaths(repo).metricsJson, 'utf8'));

    expect(m.prompts.enhanced).toBe(1);
    expect(m.prompts.accepted).toBe(1);
    expect(m.prompts.acceptanceRate).toBe(1);
    expect(m.turnsPerTask.tasks).toBe(1);
    expect(m.review.runs).toBe(2);
    expect(m.review.pushReviews).toBe(2);
    expect(m.review.findingsByAgent['peer-review']).toBeGreaterThan(0);
    expect(m.review.findingsActedOn).toBeGreaterThanOrEqual(1);
    expect(m.graph.builds).toBeGreaterThanOrEqual(1);
    expect(m.graph.avgDurationMs).toBeGreaterThan(0);
    expect(m.graph.lastCoverage).toBe(1);
    expect(m.agents.security.completed).toBe(2);
    expect(m.usage.commands.status).toBe(1);
    expect(m.usage.commands.enhance).toBe(2);
    expect(m.usage.activeDays).toBe(1);

    // privacy: counts only, never the request, code or a path
    const raw = fs.readFileSync(repoPaths(repo).metricsJson, 'utf8') + fs.readFileSync(path.join(repoPaths(repo).metricsDir, 'events.jsonl'), 'utf8');
    for (const s of ['payroll', 'confidential', 'noisy', 'print(']) expect(raw).not.toContain(s);

    // the markdown report says the same numbers as the JSON
    const md = fs.readFileSync(path.join(repoPaths(repo).metricsDir, 'report.md'), 'utf8');
    expect(md).toBe(toMarkdown(m));
    expect(md).toContain(`Prompts enhanced: ${m.prompts.enhanced}.`);
    expect(md).toContain(`Reviews run: ${m.review.runs}.`);

    // and so does the Word report
    const docx = fs.readFileSync(path.join(repoPaths(repo).metricsDir, 'report.docx'));
    expect(docx.subarray(0, 2).toString()).toBe('PK');
    const req = createRequire(__filename);
    const JSZip = req('jszip');
    const zip = await JSZip.loadAsync(docx);
    const xml: string = await zip.file('word/document.xml').async('string');
    expect(xml).toContain(`Prompts enhanced: ${m.prompts.enhanced}.`);
    expect(xml).toContain(`Reviews run: ${m.review.runs}.`);
  }, 300000);

  it('recomputing from the same events gives the same file (deterministic)', async () => {
    const repo = await initialized('python-fastapi');
    const now = new Date('2026-02-01T00:00:00Z');
    const a = computeMetrics(repo, now);
    const b = computeMetrics(repo, now);
    expect(b).toEqual(a);
  }, 240000);

  it('events are not recorded in a repo that was never initialized', async () => {
    const plain = mk(fixtureRepo('python-fastapi', { configure: false }));
    await runCommand('status', {}, ctxFor(plain));
    recordEvent(plain, { type: 'prompt' });
    expect(fs.existsSync(path.join(plain, '.claude'))).toBe(false);
  });
});

describe('uninstall (D-29, MASTER 22)', () => {
  it('removes DevSarathi files and hooks, restores the old hook, keeps edits, the graph and the metrics', async () => {
    const repo = mk(fixtureRepo('python-fastapi', { configure: false }));
    const original = '#!/bin/sh\necho team hook\nexit 0\n';
    fs.writeFileSync(path.join(repo, '.git/hooks/pre-push'), original, { mode: 0o755 });
    write(repo, '.claude/agents/my-own-agent.md', 'mine\n');
    await runCommand('init', { yes: true, persona: 'Asha' }, ctxFor(repo));
    const edited = path.join(repo, '.claude/rules/ds-naming-style.md');
    fs.appendFileSync(edited, '- Our team writes docstrings in Google style.\n');
    const editedText = fs.readFileSync(edited, 'utf8');

    const noAsk = await runCommand('uninstall', {}, ctxFor(repo));
    expect(noAsk.ok).toBe(false); // needs --yes without a terminal
    expect(noAsk.message).toMatch(/KEEP 1 file/);
    expect(fs.existsSync(path.join(repo, '.claude/rules/ds-core.md'))).toBe(true); // nothing happened yet

    const res = await runCommand('uninstall', { yes: true }, ctxFor(repo));
    expect(res.ok, res.message).toBe(true);
    expect(fs.existsSync(path.join(repo, '.claude/rules/ds-core.md'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude/commands'))).toBe(false); // emptied directories are removed
    expect(fs.readFileSync(edited, 'utf8')).toBe(editedText); // your edit stays
    expect(fs.readFileSync(path.join(repo, '.claude/agents/my-own-agent.md'), 'utf8')).toBe('mine\n');
    expect(fs.readFileSync(path.join(repo, '.git/hooks/pre-push'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(repo, '.git/hooks/post-merge'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude/settings.json'))).toBe(false); // DevSarathi created it, so it goes
    expect(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8')).not.toContain('.claude/devsarathi/');

    const p = repoPaths(repo);
    expect(fs.existsSync(p.config)).toBe(false);
    expect(fs.existsSync(p.hooks)).toBe(false);
    expect(fs.existsSync(path.join(p.graph, 'graph.sqlite'))).toBe(true); // kept
    expect(fs.existsSync(p.metricsJson) || fs.existsSync(path.join(p.metricsDir, 'events.jsonl'))).toBe(true); // kept
    expect(readRegistry().map((r) => path.resolve(r.path).toLowerCase())).not.toContain(path.resolve(repo).toLowerCase());
  }, 300000);

  it('remove-graph and remove-metrics are separate, show sizes, and need a yes', async () => {
    const repo = await initialized('python-fastapi');
    await runCommand('metrics', {}, ctxFor(repo));
    const ask = await runCommand('remove-graph', {}, ctxFor(repo));
    expect(ask.ok).toBe(false);
    expect(ask.message).toMatch(/Delete graph data \(\d/);
    expect(fs.existsSync(repoPaths(repo).graph)).toBe(true);

    const m = await runCommand('remove-metrics', {}, ctxFor(repo));
    expect(m.message).toMatch(/irreversible/);
    expect(fs.existsSync(repoPaths(repo).metricsDir)).toBe(true);

    expect((await runCommand('remove-graph', { yes: true }, ctxFor(repo))).ok).toBe(true);
    expect(fs.existsSync(repoPaths(repo).graph)).toBe(false);
    expect(fs.existsSync(repoPaths(repo).metricsDir)).toBe(true); // metrics untouched by remove-graph
    expect((await runCommand('remove-metrics', { yes: true }, ctxFor(repo))).ok).toBe(true);
    expect(fs.existsSync(repoPaths(repo).metricsDir)).toBe(false);
    expect((await runCommand('remove-graph', { yes: true }, ctxFor(repo))).message).toMatch(/no graph data/);
  }, 300000);
});

describe('export-baseline (D-06)', () => {
  it('writes template-layer rules and agents only: no graph rules, no state, no personal name', async () => {
    const repo = await initialized('angular-app');
    const res = await runCommand('export-baseline', {}, ctxFor(repo));
    expect(res.ok, res.message).toBe(true);
    const out = path.join(repo, 'devsarathi-baseline');
    const files: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.relative(out, path.join(d, e.name)).split(path.sep).join('/'))));
    walk(out);
    expect(files).toEqual(expect.arrayContaining(['README.md', '.claude/rules/ds-core.md', '.claude/rules/ds-stack-angular.md', '.claude/agents/ds-developer.md']));
    expect(files.some((f) => f.includes('devsarathi/'))).toBe(false); // no state folder
    const all = files.map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
    expect(all).not.toMatch(/source:graph@[0-9a-f]{7}/); // no graph-derived rule lines (the auditor template only mentions the tag)
    expect(all).not.toContain('Asha');
    expect(all).toContain('DevSarathi, Angular Developer');
  }, 240000);
});

describe('migrate (D-28, MASTER 21)', () => {
  it('reports with --check without writing, updates untouched files, and says so when nothing changed', async () => {
    const repo = await initialized('python-fastapi');
    const nothing = await runCommand('migrate', { yes: true }, ctxFor(repo));
    expect(nothing.message).toMatch(/Nothing to change/);

    // simulate an older template generation: a managed, unedited file with different content
    const rel = '.claude/rules/ds-testing.md';
    const abs = path.join(repo, rel);
    const current = fs.readFileSync(abs, 'utf8');
    const old = current.replace('Tests must not depend on network access', 'Tests may use the network');
    expect(old).not.toBe(current);
    const cfg = loadConfig(repo)!;
    const { sha256 } = await import('../src');
    fs.writeFileSync(abs, old);
    cfg.managedFiles.find((m) => m.path === rel)!.hash = sha256(old);
    saveConfig(repo, cfg);

    const check = await runCommand('migrate', { check: true }, ctxFor(repo));
    expect(check.message).toMatch(/Updates to unedited files: 1/);
    expect(check.message).toMatch(/\+- Tests must not depend|Tests must not depend on network access/);
    expect(fs.readFileSync(abs, 'utf8')).toBe(old); // --check wrote nothing

    const applied = await runCommand('migrate', { yes: true }, ctxFor(repo));
    expect(applied.ok, applied.message).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toContain('Tests must not depend on network access');
    expect(applied.message).toMatch(/Audit PASS/);
    expect(loadConfig(repo)!.toolVersion).toBeTruthy();
  }, 300000);

  it('never overwrites a file you edited: it writes a 3-way merge beside it instead', async () => {
    const repo = await initialized('python-fastapi');
    const rel = '.claude/rules/ds-testing.md';
    const abs = path.join(repo, rel);
    const base = path.join(repoPaths(repo).state, 'generated', ...rel.split('/'));
    // the template used to say something else (so the new template differs from the recorded base)
    fs.writeFileSync(base, fs.readFileSync(base, 'utf8').replace('Tests must not depend on network access', 'Tests may hit the network'));
    // the developer also edited their copy
    fs.appendFileSync(abs, '- Mark slow tests with the slow marker.\n');
    const mine = fs.readFileSync(abs, 'utf8');

    const res = await runCommand('migrate', { yes: true }, ctxFor(repo));
    expect(res.ok, res.message).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe(mine); // untouched
    expect(res.message).toMatch(/Template changes to files you edited/);
    const merged = path.join(repoPaths(repo).state, 'migrate', 'merged', ...rel.split('/'));
    expect(fs.existsSync(merged)).toBe(true);
    const text = fs.readFileSync(merged, 'utf8');
    expect(text).toContain('Mark slow tests with the slow marker.'); // your line survives in the proposal
    expect(text).toContain('Tests must not depend on network access'); // and so does the new template line
  }, 300000);

  it('creates files the new version adds', async () => {
    const repo = await initialized('python-fastapi');
    fs.rmSync(path.join(repo, '.claude/commands/ds-metrics.md'));
    const res = await runCommand('migrate', { yes: true }, ctxFor(repo));
    expect(res.message).toMatch(/New files: 1/);
    expect(fs.existsSync(path.join(repo, '.claude/commands/ds-metrics.md'))).toBe(true);
  }, 300000);
});

describe('version notice (D-28)', () => {
  it('shows a one-line notice from the cache when a newer version exists, and nothing when turned off', async () => {
    const repo = await initialized('python-fastapi');
    fs.mkdirSync(userHome(), { recursive: true });
    fs.writeFileSync(path.join(userHome(), 'version-check.json'), JSON.stringify({ latest: '9.9.9', checkedAt: new Date().toISOString() }));
    expect(statusLine(await collectStatus(repo))).toMatch(/new version 9\.9\.9 available \(npm i -g @ravikiranm795\/dev-sarathi@latest\)/);
    const cfg = loadConfig(repo)!;
    cfg.versionCheck = false;
    saveConfig(repo, cfg);
    expect(statusLine(await collectStatus(repo))).not.toMatch(/new version/);
  }, 240000);
});

describe('selftest (D-27, MASTER 23)', () => {
  it('catches every planted problem, records the result, and touches nothing outside its temp folder', async () => {
    const repo = await initialized('python-fastapi');
    const registryBefore = readRegistry().length;
    const homeBefore = process.env.DEVSARATHI_HOME;
    const res = await runCommand('selftest', {}, ctxFor(repo));
    expect(res.ok, res.message).toBe(true);
    const data = res.data as { passed: number; total: number; checks: { name: string; passed: boolean }[] };
    expect(data.total).toBeGreaterThanOrEqual(9);
    expect(data.passed).toBe(data.total);
    expect(data.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['ds-security flags the planted key', 'ds-tester flags the function without a test', 'ds-auditor flags the rule contradiction', 'the pre-push hook never blocks (push succeeded)'])
    );
    expect(process.env.DEVSARATHI_HOME).toBe(homeBefore);
    expect(readRegistry().length).toBe(registryBefore); // the fixture repo was never registered in the real registry
    const ev = readEvents(repo).find((e) => e.type === 'selftest')!;
    expect(ev.data).toMatchObject({ passed: data.total, total: data.total });

    const m = computeMetrics(repo);
    expect(m.selftest.lastPassed).toBe(true);
  }, 600000);
});
