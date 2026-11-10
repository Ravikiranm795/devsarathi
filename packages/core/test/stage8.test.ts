import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCommand, createLogger, detectStacks, personaTitle, formatReview, repoPaths, loadConfig, saveConfig } from '../src';
import type { ReviewResult } from '@devsarathi/shared';
import { tmpDir, rmrf, fixtureRepo, write, git } from './helpers';

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

describe('Node.js stack profile (found by testing a real Node CLI repo)', () => {
  it('detects a Node.js project from package.json plus JavaScript sources one level down', () => {
    const root = mk(tmpDir('ds-node-'));
    write(root, 'package.json', JSON.stringify({ name: 'cli', scripts: { test: 'node --test' }, dependencies: { commander: '^12.0.0' } }));
    for (const f of ['a', 'b', 'c', 'd']) write(root, `src/${f}.js`, `exports.${f} = () => 1;\n`);
    const r = detectStacks(root);
    expect(r.stacks.map((s) => s.id)).toEqual(['node']);
    expect(r.stacks[0]).toMatchObject({ displayName: 'Node.js', testFramework: 'node:test' });
    expect(r.stacks[0].frameworks).toContain('Commander CLI');
    expect(personaTitle(r.stacks).title).toBe('Node.js Developer');
  });

  it('a tooling-only package.json next to a Java project is not a second stack', () => {
    const root = mk(tmpDir('ds-java-'));
    write(root, 'pom.xml', '<project><artifactId>spring-boot</artifactId></project>');
    write(root, 'package.json', JSON.stringify({ devDependencies: { prettier: '3' } }));
    expect(detectStacks(root).stacks.map((s) => s.id)).toEqual(['java']);
  });

  it('Angular and React projects are never reported as Node.js', () => {
    expect(detectStacks(path.resolve(__dirname, '../../../test-fixtures/angular-app')).stacks.map((s) => s.id)).toEqual(['angular']);
  });

  it('init and the audit work end to end for a Node.js repo', async () => {
    const repo = mk(fixtureRepo('python-fastapi', { configure: false }));
    fs.rmSync(path.join(repo, 'requirements.txt'));
    write(repo, 'package.json', JSON.stringify({ name: 'cli', scripts: { test: 'node --test' } }));
    for (const f of ['a', 'b', 'c', 'd']) write(repo, `src/${f}.js`, `exports.${f} = function ${f}() {\n  return 1;\n};\n`);
    write(repo, 'test/a.test.js', "const { a } = require('../src/a');\nrequire('node:test')('a', () => a());\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'node');
    const r = await runCommand('init', { yes: true, persona: 'Ravi', skipHooks: true }, ctxFor(repo));
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/Ravi, Node\.js Developer/);
    expect(r.message).toMatch(/Audit PASS/);
    expect(fs.existsSync(path.join(repo, '.claude/rules/ds-stack-node.md'))).toBe(true);
  }, 240000);
});

describe('review is accurate on a real branch', () => {
  async function ready(): Promise<string> {
    const repo = mk(fixtureRepo('python-fastapi', { configure: false }));
    const r = await runCommand('init', { yes: true, persona: 'Asha', skipHooks: true }, ctxFor(repo));
    expect(r.ok, r.message).toBe(true);
    return repo;
  }

  it('DevSarathi\'s own generated files are never reviewed as the developer\'s change', async () => {
    const repo = await ready();
    expect(git(repo, 'status', '--porcelain')).toMatch(/\.claude/); // they are untracked changes...
    const res = await runCommand('review', {}, ctxFor(repo));
    expect(res.message).not.toMatch(/\.claude/); // ...but not review input
    expect((res.data as { verdict: string }).verdict).toBe('clean');
  }, 240000);

  it('a test elsewhere in the tree counts: only functions no test mentions are reported', async () => {
    const repo = await ready();
    git(repo, 'checkout', '-q', '-b', 'feature/pricing');
    write(repo, 'app/pricing.py', 'def covered_fn(x):\n    return x\n\n\ndef uncovered_fn(x):\n    return x + 1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'pricing');
    // the test for covered_fn already exists in the baseline tree, not in this change
    const base = git(repo, 'rev-parse', 'main');
    write(repo, 'tests/test_existing.py', 'from app.pricing import covered_fn\n\n\ndef test_it():\n    assert covered_fn(1) == 1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'test lands in an earlier-looking file');
    const res = await runCommand('review', { range: `${base}..HEAD`, only: 'tester' }, ctxFor(repo));
    expect(res.message).toMatch(/No test covers new function uncovered_fn/);
    expect(res.message).not.toMatch(/No test covers new function covered_fn/);
  }, 240000);

  it('a huge branch is summarized instead of burying the real findings', async () => {
    const repo = await ready();
    git(repo, 'checkout', '-q', '-b', 'feature/big');
    const base = git(repo, 'rev-parse', 'main');
    const fns = Array.from({ length: 60 }, (_, i) => `def helper_${i}(x):\n    return x + ${i}\n`).join('\n\n');
    write(repo, 'app/helpers.py', fns + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'many helpers');
    const res = await runCommand('review', { range: `${base}..HEAD`, only: 'tester' }, ctxFor(repo));
    const tester = (res.data as ReviewResult).runs.find((r) => r.agent === 'tester')!;
    expect(tester.findings.length).toBe(21); // 20 listed + one summary
    expect(tester.findings[20].title).toMatch(/^40 more changed or new functions have no test mentioning them/);
  }, 240000);

  it('the pre-push view shows at most 25 findings and says how to see the rest, but never hides a red flag', () => {
    const mkFinding = (i: number, extra: Record<string, unknown> = {}) => ({ id: `F${i}`, agent: 'peer-review' as const, severity: 'low' as const, title: `Finding ${i}`, redFlag: false, ...extra });
    const result: ReviewResult = {
      runId: 'r', createdAt: new Date().toISOString(), branch: 'b', head: 'abc1234', range: 'x..y', specChanged: false, verdict: 'findings',
      runs: [{ agent: 'peer-review', status: 'completed', startedAt: new Date().toISOString(), durationMs: 1, findings: [...Array.from({ length: 60 }, (_, i) => mkFinding(i)), mkFinding(99, { title: 'Secret here', severity: 'critical', redFlag: true, agent: 'security' })] }]
    };
    const compact = formatReview(result, true).text;
    expect(compact).toContain('Secret here');
    expect(compact).toMatch(/\.\.\. and 36 more \(run \/ds-review or devsarathi review for the full list\)/);
    expect(compact.split('\n').filter((l) => /^\d+\. /.test(l)).length).toBe(25);
    expect(formatReview(result, false).text).not.toMatch(/and \d+ more/);
  });

  it('the Stop hook does not start the tester just because DevSarathi generated files', async () => {
    const repo = mk(fixtureRepo('python-fastapi', { configure: false }));
    const r = await runCommand('init', { yes: true, persona: 'Asha' }, ctxFor(repo));
    expect(r.ok, r.message).toBe(true);
    const cfg = loadConfig(repo)!;
    cfg.commandOverrides = { test: 'node -e "process.exit(0)"' }; // keep the background run short so cleanup is not racing it
    saveConfig(repo, cfg);
    const out = spawnSync(process.execPath, [path.join(repoPaths(repo).hooks, 'ds-hook.js'), 'stop'], { cwd: repo, encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).not.toMatch(/ds-tester is running/);
    // a real code change does start it
    write(repo, 'app/new_code.py', 'def new_code():\n    return 1\n');
    const out2 = spawnSync(process.execPath, [path.join(repoPaths(repo).hooks, 'ds-hook.js'), 'stop'], { cwd: repo, encoding: 'utf8' });
    expect(out2.stdout).toMatch(/ds-tester is running in the background/);
    await new Promise((res) => setTimeout(res, 6000)); // let the detached run finish before the temp folder is removed
  }, 240000);
});
