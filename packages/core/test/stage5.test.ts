import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  runCommand,
  createLogger,
  loadConfig,
  saveConfig,
  repoPaths,
  readEvents,
  compose,
  capFor,
  parseSpec,
  specIssues
} from '../src';
import { ConfigSchema } from '@devsarathi/shared';
import type { EnhanceContext } from '../src';
import { tmpDir, rmrf, git, fixtureRepo, write } from './helpers';

const CLI = path.resolve(__dirname, '../../../bin/devsarathi.js');
const dirs: string[] = [];
const mk = <T extends string>(d: T): T => (dirs.push(d), d);
const savedEnv = { ...process.env };
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';

beforeAll(() => {
  process.env.DEVSARATHI_EMBEDDER = 'fake';
  process.env.DEVSARATHI_HOME = mk(tmpDir('ds-home-'));
});
afterAll(() => {
  process.env = { ...savedEnv };
  while (dirs.length) rmrf(dirs.pop() as string);
});

const ctxFor = (root: string) => ({ repoRoot: root, log: createLogger(undefined), progress: () => undefined });

async function initialized(fx: string): Promise<string> {
  const repo = mk(fixtureRepo(fx, { configure: false }));
  const r = await runCommand('init', { yes: true, persona: 'Asha', skipHooks: true }, ctxFor(repo));
  expect(r.ok, r.message).toBe(true);
  return repo;
}

function commit(repo: string, files: Record<string, string>, msg = 'change'): string {
  for (const [rel, content] of Object.entries(files)) write(repo, rel, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
  return git(repo, 'rev-parse', 'HEAD');
}

async function review(repo: string, args: Record<string, unknown> = {}) {
  return runCommand('review', args, ctxFor(repo));
}

describe('security review (MASTER 10.3, 15)', () => {
  it('flags a planted key and an env change as red flags, with masked values only (I-8)', async () => {
    const repo = await initialized('angular-app');
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, {
      'src/app/config/aws.ts': `export const awsKey = '${FAKE_KEY}';\n`,
      '.env': 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nEXTRA=1\n'
    });
    const res = await review(repo, { range: `${base}..${head}` });
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/RED FLAGS \(2\)/);
    expect(res.message).toMatch(/Possible aws access key.*src\/app\/config\/aws\.ts:1/);
    expect(res.message).toMatch(/Secret or environment file (added|changed).*\.env/);
    expect(res.message).toContain('AK'); // masked preview shows at most the first two characters...
    const everything = [res.message, JSON.stringify(res.data), ...fs.readdirSync(repoPaths(repo).reviews).map((f) => fs.readFileSync(path.join(repoPaths(repo).reviews, f), 'utf8'))].join('\n');
    expect(everything).not.toContain(FAKE_KEY); // ...and the value is never written anywhere
    expect(everything).not.toContain('IOSFODNN7EXAMPLE');
    expect(readEvents(repo).find((e) => e.type === 'review')!.data!.redFlags).toBe(2);
    expect(JSON.stringify(readEvents(repo))).not.toContain('AKIA');
  }, 240000);

  it('applies the stack patterns (Java reflection and SQL concatenation)', async () => {
    const repo = await initialized('java-spring');
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, {
      'src/main/java/com/acme/user/Dao.java': 'package com.acme.user;\npublic class Dao {\n  public void q(java.sql.Statement s, String id) throws Exception {\n    s.executeQuery("select * from u where id=" + id);\n  }\n}\n'
    });
    const res = await review(repo, { range: `${base}..${head}`, only: 'security' });
    expect(res.message).toMatch(/SQL built by string concatenation/);
  }, 240000);
});

describe('impact review: callers must be considered (MASTER 7.6)', () => {
  it('flags a signature change whose callers live in files the change does not touch', async () => {
    const repo = await initialized('python-fastapi');
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, { 'app/services.py': 'def get_user(user_id, tenant):\n    return {"id": user_id, "tenant": tenant}\n\n\ndef format_name(name):\n    return name.strip().upper()\n' });
    const res = await review(repo, { range: `${base}..${head}` });
    expect(res.message).toMatch(/\[high\] \(impact\) Changed the signature of get_user without touching its 2 callers/);
    expect(res.message).toMatch(/invoice_owner/);
    expect(res.message).toMatch(/Impact confidence: (HIGH|MEDIUM|LOW)/);
    expect((res.data as { verdict: string }).verdict).toBe('findings');
  }, 240000);

  it('stays quiet when the callers are updated in the same change', async () => {
    const repo = await initialized('python-fastapi');
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, {
      'app/services.py': 'def get_user(user_id, tenant):\n    return {"id": user_id, "tenant": tenant}\n\n\ndef format_name(name):\n    return name.strip().upper()\n',
      'app/main.py': 'from fastapi import FastAPI\n\nfrom app import services\n\napp = FastAPI()\n\n\n@app.get("/users/{user_id}")\ndef read_user(user_id: int):\n    user = services.get_user(user_id, "t1")\n    return {"label": services.format_name(user["id"])}\n',
      'app/billing.py': 'from app import services\n\n\ndef invoice_owner(account_id):\n    return services.get_user(account_id, "t1")["id"]\n'
    });
    const res = await review(repo, { range: `${base}..${head}`, only: 'impact' });
    expect(res.message).not.toMatch(/without touching/);
  }, 240000);
});

describe('test presence (MASTER 10.2)', () => {
  it('flags a new function that no test mentions, and not one that has a test in the change', async () => {
    const repo = await initialized('python-fastapi');
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, {
      'app/pricing.py': 'def apply_discount(total, pct):\n    return total - total * pct / 100\n\n\ndef add_tax(total):\n    return total * 1.2\n',
      'tests/test_pricing.py': 'from app import pricing\n\n\ndef test_add_tax():\n    assert pricing.add_tax(100) == 120\n'
    });
    const res = await review(repo, { range: `${base}..${head}`, only: 'tester' });
    expect(res.message).toMatch(/No test covers new function apply_discount/);
    expect(res.message).not.toMatch(/No test covers new function add_tax/);
  }, 240000);
});

describe('peer review checks', () => {
  it('reports debug leftovers and new TODOs in source, not in tests', async () => {
    const repo = await initialized('python-fastapi');
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, {
      'app/extra.py': 'def extra(x):\n    print("debug", x)\n    # TODO: handle empty input\n    return x\n',
      'tests/test_extra.py': 'def test_it():\n    print("fine in tests")\n'
    });
    const res = await review(repo, { range: `${base}..${head}`, only: 'peer-review' });
    expect(res.message).toMatch(/Debug output left in code app\/extra\.py:2/);
    expect(res.message).toMatch(/New TODO\/FIXME/);
    expect(res.message).not.toMatch(/test_extra/);
  }, 240000);
});

describe('failure never looks like a pass (I-4, D-13)', () => {
  it('a missing graph makes the review INCOMPLETE with the reason, and raises a notification', async () => {
    const repo = await initialized('python-fastapi');
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, { 'app/x.py': 'def x():\n    return 1\n' });
    fs.rmSync(repoPaths(repo).graph, { recursive: true, force: true });
    const res = await review(repo, { range: `${base}..${head}` });
    expect(res.message).toMatch(/INCOMPLETE/);
    expect(res.message).toMatch(/impact did not run: there is no graph/);
    expect(res.message).not.toMatch(/: clean/);
    expect((res.data as { verdict: string }).verdict).toBe('incomplete');
    expect(fs.readFileSync(path.join(repoPaths(repo).state, 'notices.jsonl'), 'utf8')).toMatch(/ds-impact did not run/);
  }, 240000);

  it('an unreadable range is reported as a review that did not run, never clean', async () => {
    const repo = await initialized('python-fastapi');
    const res = await review(repo, { range: 'deadbeef..cafebabe' });
    expect(res.message).not.toMatch(/: clean/);
    expect(res.message).toMatch(/did not run|INCOMPLETE/);
  }, 240000);

  it('agents turned off are skipped, which is not a failure', async () => {
    const repo = await initialized('python-fastapi');
    const cfg = loadConfig(repo)!;
    cfg.agents.security = false;
    saveConfig(repo, cfg);
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, { 'app/y.py': 'def y():\n    return 2\n' });
    const res = await review(repo, { range: `${base}..${head}` });
    const runs = (res.data as { runs: { agent: string; status: string }[] }).runs;
    expect(runs.find((r) => r.agent === 'security')!.status).toBe('skipped');
    expect(res.message).toMatch(/Skipped \(turned off\): security/);
    expect((res.data as { verdict: string }).verdict).not.toBe('incomplete');
  }, 240000);

  it('with nothing wrong the verdict is clean', async () => {
    const repo = await initialized('python-fastapi');
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, { 'README.md': '# readme\n' });
    const res = await review(repo, { range: `${base}..${head}` });
    expect((res.data as { verdict: string }).verdict).toBe('clean');
    expect(res.message).toMatch(/review: clean/);
  }, 240000);
});

describe('pre-push runs the same review and never blocks (D-11, D-12)', () => {
  it('a real push with a planted key succeeds while the red flag is printed', async () => {
    const repo = mk(fixtureRepo('python-fastapi', { configure: false }));
    const remote = mk(tmpDir('ds-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', 'origin', 'main');
    const init = await runCommand('init', { yes: true, persona: 'Asha' }, ctxFor(repo));
    expect(init.ok, init.message).toBe(true);

    git(repo, 'checkout', '-q', '-b', 'feature/keys');
    commit(repo, { 'app/secrets_demo.py': `API_KEY = "${FAKE_KEY}"\n` });
    const push = spawnSync('git', ['push', '-u', 'origin', 'feature/keys'], { cwd: repo, encoding: 'utf8' });
    expect(push.status, push.stderr).toBe(0); // never blocks
    const out = push.stdout + push.stderr;
    expect(out).toMatch(/RED FLAGS \(1\)/);
    expect(out).toMatch(/Possible aws access key app\/secrets_demo\.py:1/);
    expect(out).not.toContain(FAKE_KEY);
    expect(git(remote, 'rev-parse', 'feature/keys')).toBe(git(repo, 'rev-parse', 'HEAD'));
  }, 300000);

  it('a crashed review prints "did not run" and the push still goes through', async () => {
    const repo = mk(fixtureRepo('python-fastapi', { configure: false }));
    const remote = mk(tmpDir('ds-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    const init = await runCommand('init', { yes: true, persona: 'Asha' }, ctxFor(repo));
    expect(init.ok, init.message).toBe(true);
    const bad = '1111111111111111111111111111111111111111';
    const r = spawnSync(process.execPath, [path.join(repoPaths(repo).hooks, 'ds-hook.js'), 'pre-push'], { cwd: repo, encoding: 'utf8', input: `refs/heads/main ${bad} refs/heads/main 0000000000000000000000000000000000000000\n` });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/INCOMPLETE|did not run/);
    expect(r.stdout + r.stderr).not.toMatch(/review: clean/);
  }, 300000);
});

describe('tester run (MASTER 10.2)', () => {
  it('passes, fails and cannot-run are three different results', async () => {
    const repo = await initialized('python-fastapi');
    const set = (cmd: string) => {
      const cfg = loadConfig(repo)!;
      cfg.commandOverrides = { test: cmd };
      saveConfig(repo, cfg);
    };
    set('node -e "process.exit(0)"');
    const pass = await runCommand('test', {}, ctxFor(repo));
    expect(pass.message).toMatch(/ds-tester: PASS/);
    expect(pass.ok).toBe(true);

    set('node -e "console.error(\'1 failing\'); process.exit(1)"');
    const fail = await runCommand('test', {}, ctxFor(repo));
    expect(fail.message).toMatch(/ds-tester: FAIL/);
    expect(fail.message).toMatch(/failed: node -e/);
    expect(fail.ok).toBe(false);

    set('definitely-not-a-real-command-xyz --run');
    const nope = await runCommand('test', {}, ctxFor(repo));
    expect(nope.message).toMatch(/ds-tester: INCOMPLETE/);
    expect(nope.message).toMatch(/ds-tester did not run: definitely-not-a-real-command-xyz/);
    expect(nope.ok).toBe(false);
    expect(fs.readFileSync(path.join(repoPaths(repo).state, 'notices.jsonl'), 'utf8')).toMatch(/ds-tester did not run/);
  }, 300000);

  it('maps acceptance criteria and lists changed functions without tests', async () => {
    const repo = await initialized('python-fastapi');
    write(repo, 'specs/pricing.md', '# Pricing\n\n## Acceptance criteria\n- AC-1: add tax of 20 percent to the total\n- AC-2: apply discount percentage to the total\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'spec');
    await runCommand('enhance', { request: 'add tax and discount', spec: 'specs/pricing.md' }, ctxFor(repo));
    const cfg = loadConfig(repo)!;
    cfg.commandOverrides = { test: 'node -e "process.exit(0)"' };
    saveConfig(repo, cfg);
    git(repo, 'checkout', '-q', '-b', 'feature/pricing');
    commit(repo, {
      'app/pricing.py': 'def apply_discount(total, pct):\n    return total - total * pct / 100\n\n\ndef add_tax(total):\n    return total * 1.2\n',
      'tests/test_pricing.py': 'from app import pricing\n\n\ndef test_add_tax_to_total():\n    assert pricing.add_tax(100) == 120\n'
    });
    const res = await runCommand('test', {}, ctxFor(repo));
    expect(res.message).toMatch(/no test for: app\/pricing\.py::apply_discount/);
    expect(res.message).toMatch(/AC-1: (pass|untested)/);
    expect(res.message).toMatch(/AC-2: untested/);
    expect(res.ok).toBe(false); // a missing test is not a clean result
  }, 300000);
});

describe('prompt enhancer (MASTER 13, 14)', () => {
  const spec = `# Webhook retry\n\n## Acceptance criteria\n- AC-1: a failed delivery to the user service is retried three times\n- AC-2: the retry count is logged for each user lookup\n`;

  it('produces the fixed section order with real files and symbols, inside the size limit', async () => {
    const repo = await initialized('angular-app');
    write(repo, 'specs/user.md', spec);
    const res = await runCommand('enhance', { request: 'retry getUser lookup when it fails', spec: 'specs/user.md' }, ctxFor(repo));
    expect(res.ok, res.message).toBe(true);
    const d = res.data as { status: string; prompt: string; chars: number; cap: number };
    expect(d.status).toBe('ready');
    const order = ['Task:', 'Spec:', 'Files:', 'Impact:', 'Constraints:', 'Acceptance:'].map((s) => d.prompt.indexOf(s));
    expect(order.every((i) => i >= 0), d.prompt).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(d.prompt).toMatch(/src\/app\/services\/user\.service\.ts:getUser/);
    expect(d.prompt).toContain('specs/user.md (AC-1..AC-2)');
    expect(d.prompt).toContain('.claude/rules/ds-core.md');
    expect(d.chars).toBeLessThanOrEqual(d.cap);
    expect(res.message).toMatch(/^Preview \(nothing has been sent/);
  }, 240000);

  it('records the spec hash at work start, and review warns when the spec changes after that', async () => {
    const repo = await initialized('python-fastapi');
    write(repo, 'specs/s.md', '# S\n\n## Acceptance criteria\n- AC-1: users can be looked up by id\n');
    await runCommand('enhance', { request: 'look up users', spec: 'specs/s.md' }, ctxFor(repo));
    const active = JSON.parse(fs.readFileSync(path.join(repoPaths(repo).state, 'active-spec.json'), 'utf8'));
    expect(active.ref).toBe('specs/s.md');
    expect(active.hash).toMatch(/^[0-9a-f]{64}$/);

    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, { 'app/z.py': 'def z():\n    return 3\n' });
    const before = await review(repo, { range: `${base}..${head}` });
    expect(before.message).not.toMatch(/spec .* changed after work started/i);

    write(repo, 'specs/s.md', '# S\n\n## Acceptance criteria\n- AC-1: users can be looked up by id\n- AC-2: new requirement from the PM\n');
    const after = await review(repo, { range: `${base}..${head}` });
    expect(after.message).toMatch(/The spec specs\/s\.md changed after work started/);
    expect(after.message).toMatch(/Warning: the spec changed/);
  }, 300000);

  it('lists ambiguities and conflicts and stops; it never fills the gaps (D-22)', async () => {
    const repo = await initialized('python-fastapi');
    write(repo, 'specs/vague.md', '# Vague\n\nUse `legacy_exporter` to export.\n\n## Acceptance criteria\n- AC-1: the export is fast and user-friendly\n- AC-2: TBD\n');
    const res = await runCommand('enhance', { request: 'build the export', spec: 'specs/vague.md' }, ctxFor(repo));
    expect(res.ok).toBe(true);
    expect((res.data as { status: string }).status).toBe('needs-confirmation');
    expect(res.message).toMatch(/AC-1 is vague/);
    expect(res.message).toMatch(/`legacy_exporter`, which is not in the code/);
    expect(res.message).not.toMatch(/^Task:/m); // no prompt was produced

    const go = await runCommand('enhance', { request: 'build the export', spec: 'specs/vague.md', confirm: true }, ctxFor(repo));
    expect((go.data as { status: string }).status).toBe('ready');
    expect((go.data as { prompt: string }).prompt).toContain('Open questions:');
  }, 240000);

  it('a spec without acceptance criteria is a problem, and no spec at all is asked about', async () => {
    const repo = await initialized('python-fastapi');
    write(repo, 'specs/none.md', '# No criteria\n\nJust some text.\n');
    const a = await runCommand('enhance', { request: 'do it', spec: 'specs/none.md' }, ctxFor(repo));
    expect(a.message).toMatch(/no acceptance criteria/);
    const b = await runCommand('enhance', { request: 'do it' }, ctxFor(repo));
    expect(b.message).toMatch(/No spec or ticket was given/);
    expect((b.data as { status: string }).status).toBe('needs-confirmation');
  }, 240000);

  it('Jira failure asks for a paste and never proceeds on partial context (D-23)', async () => {
    const repo = await initialized('python-fastapi');
    const miss = await runCommand('enhance', { request: 'fix it', jira: 'PAY-12' }, ctxFor(repo));
    expect(miss.ok).toBe(false);
    expect(miss.exitCode).toBe(3);
    expect(miss.message).toMatch(/PAY-12 is not available/);
    expect(miss.message).toMatch(/Paste the ticket text/);

    const pasted = '# PAY-12 retry payments\n\n## Acceptance criteria\n- AC-1: payment lookup retried twice with get_user\n';
    const ok = await runCommand('enhance', { request: 'fix it', jira: 'PAY-12', paste: pasted }, ctxFor(repo));
    expect(ok.ok, ok.message).toBe(true);
    expect(fs.readFileSync(path.join(repoPaths(repo).specsCache, 'PAY-12.md'), 'utf8')).toBe(pasted); // cached read-only for traceability
    expect((ok.data as { prompt: string }).prompt).toContain('Spec: PAY-12');
    const again = await runCommand('enhance', { request: 'fix it', jira: 'PAY-12' }, ctxFor(repo));
    expect(again.ok).toBe(true); // the cache now serves it
  }, 240000);

  it('never removes the spec reference or the core rules, even under a tiny cap (I-9)', () => {
    const spec2 = parseSpec('specs/a.md', '# A\n\n## Acceptance criteria\n- AC-1: one thing\n- AC-2: another thing\n- AC-3: third\n');
    const ctx: EnhanceContext = { files: Array.from({ length: 8 }, (_, i) => ({ path: `src/a/f${i}.ts`, symbol: `fn${i}`, kind: 'function' })), impact: { callers: 9, files: ['a.ts', 'b.ts'], confidence: 'medium', top: 'a.ts, b.ts' }, modules: 3 };
    const c = compose({ request: 'x'.repeat(500), spec: spec2, ctx, questions: ['q1', 'q2'], cap: 60 });
    expect(c.trimmed).toBe(true);
    expect(c.prompt).toContain('Spec: specs/a.md');
    expect(c.prompt).toContain('Constraints: follow .claude/rules/ds-core.md');
    expect(c.prompt).toMatch(/^Task:/);
  });

  it('the size cap is adaptive: simple tasks stay near 400, cross-module tasks may grow to the ceiling', () => {
    const cfg = ConfigSchema.parse({ toolVersion: '0', baselineBranch: 'main', persona: { name: 'a', title: 'b' } });
    const simple: EnhanceContext = { files: [{ path: 'a.ts', symbol: 'f', kind: 'function' }], impact: { callers: 0, files: [], confidence: 'high', top: '' }, modules: 1 };
    const complex: EnhanceContext = { files: Array.from({ length: 6 }, (_, i) => ({ path: `m${i}/x/y/f.ts`, symbol: 'f', kind: 'function' })), impact: { callers: 20, files: Array.from({ length: 8 }, (_, i) => `f${i}.ts`), confidence: 'low', top: '' }, modules: 4 };
    const manyCriteria = Array.from({ length: 6 }, (_, i) => ({ id: `AC-${i + 1}`, text: 'x' }));
    expect(capFor(cfg, simple, [])).toBe(400);
    expect(capFor(cfg, complex, manyCriteria)).toBe(cfg.thresholds.enhanceCeilingChars);
  });

  it('records the outcome and keeps prompt text out of the metrics events (I-8)', async () => {
    const repo = await initialized('python-fastapi');
    write(repo, 'specs/s.md', '# S\n\n## Acceptance criteria\n- AC-1: users can be looked up by id\n');
    await runCommand('enhance', { request: 'look up the confidential payroll users', spec: 'specs/s.md' }, ctxFor(repo));
    const o = await runCommand('enhance', { outcome: 'edited' }, ctxFor(repo));
    expect(o.ok).toBe(true);
    expect((await runCommand('enhance', { outcome: 'maybe' }, ctxFor(repo))).ok).toBe(false);
    const events = fs.readFileSync(path.join(repoPaths(repo).metricsDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"type":"enhance-outcome"');
    expect(events).not.toContain('payroll');
  }, 240000);

  it('spec issue detection finds contradictions between criteria', () => {
    const s = parseSpec('x.md', '# X\n\n## Acceptance criteria\n- AC-1: always store the session token in the browser cookie\n- AC-2: never store the session token in the browser cookie\n');
    expect(specIssues(s, () => true).map((i) => i.kind)).toContain('contradiction');
  });
});

describe('the CLI exposes review and enhance', () => {
  it('runs review from the binary and exits 0 for a clean change', async () => {
    const repo = await initialized('python-fastapi');
    const base = git(repo, 'rev-parse', 'HEAD');
    const head = commit(repo, { 'README.md': '# hi\n' });
    const r = spawnSync(process.execPath, [CLI, 'review', '--range', `${base}..${head}`, '-C', repo], { encoding: 'utf8', env: process.env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/review: clean/);
  }, 240000);
});
