import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigSchema, DevSarathiConfig } from '@devsarathi/shared';
import {
  detectStacks,
  personaTitle,
  saveConfig,
  loadConfig,
  planWorkspace,
  applyPlan,
  budgetPreview,
  auditWorkspace,
  formatAudit,
  DrishtiClient,
  resolveRules,
  parseTemplateRules,
  parseRenderedRules,
  runCommand,
  createLogger,
  readPending,
  stripStamp,
  parseStamp,
  ruleId,
  Rule
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

/** Detect, write a config, build the graph: the state `init` leaves behind. */
async function setup(fixture: string, over: Record<string, unknown> = {}): Promise<{ repo: string; cfg: DevSarathiConfig }> {
  const repo = mk(fixtureRepo(fixture, { configure: false }));
  const det = detectStacks(repo);
  const cfg = ConfigSchema.parse({
    toolVersion: '0.1.0',
    baselineBranch: 'main',
    persona: { name: 'Asha', title: personaTitle(det.stacks).title },
    stacks: det.stacks.map((s) => ({ id: s.id, category: s.category, dir: s.dir, frameworks: s.frameworks, testFramework: s.testFramework, linter: s.linter, buildTool: s.buildTool, packageManager: s.packageManager, stateManagement: s.stateManagement })),
    ...over
  });
  saveConfig(repo, cfg);
  await new DrishtiClient(repo).build({ full: true });
  return { repo, cfg };
}

function generate(repo: string): ReturnType<typeof planWorkspace> & { applied: ReturnType<typeof applyPlan>; cfg: DevSarathiConfig } {
  const cfg = loadConfig(repo)!;
  const wp = planWorkspace(repo, cfg);
  const applied = applyPlan(repo, cfg, wp.plan);
  cfg.managedFiles = applied.managedFiles;
  saveConfig(repo, cfg);
  return { ...wp, applied, cfg };
}

const ctxFor = (root: string) => ({ repoRoot: root, log: createLogger(undefined), progress: () => undefined });

describe('rule engine (MASTER 9.1)', () => {
  const mkRule = (layer: Rule['layer'], topic: string, text: string): Rule => ({ id: ruleId(text), text, layer, topic, source: 'x', file: 'core' });

  it('precedence is developer > template-strict > graph > template-default', () => {
    const { kept, dropped } = resolveRules([
      mkRule('template-default', 'test-location', 'Put tests in src/test.'),
      mkRule('graph', 'test-location', 'Tests sit next to the source.'),
      mkRule('template-strict', 'di', 'Use constructor injection.'),
      mkRule('graph', 'di', 'Fields are injected.'),
      mkRule('developer', 'naming', 'Use kebab-case files.'),
      mkRule('template-strict', 'naming', 'Use camelCase files.')
    ]);
    const texts = kept.map((r) => r.text).sort();
    expect(texts).toEqual(['Tests sit next to the source.', 'Use constructor injection.', 'Use kebab-case files.'].sort());
    expect(dropped.map((d) => d.reason).join(' ')).toMatch(/graph outranks template-default/);
  });

  it('parses template rule attributes', () => {
    const [a, b] = parseTemplateRules('- One thing. <!-- strict topic:x -->\n- Another. <!-- default topic:y -->\n', 'core', '1.0.0');
    expect(a).toMatchObject({ layer: 'template-strict', topic: 'x', text: 'One thing.' });
    expect(b).toMatchObject({ layer: 'template-default', topic: 'y' });
  });
});

describe('workspace generation (MASTER 8-10)', () => {
  it('Angular: generates ds- prefixed rules, agents and commands with stamps and the right loading', async () => {
    const { repo } = await setup('angular-app');
    const { plan, applied } = generate(repo);
    const names = plan.files.map((f) => f.path);
    expect(names).toEqual(expect.arrayContaining(['.claude/rules/ds-core.md', '.claude/rules/ds-stack-angular.md', '.claude/rules/ds-testing.md', '.claude/agents/ds-developer.md', '.claude/agents/ds-auditor.md', '.claude/commands/ds-review.md']));
    for (const f of plan.files) expect(path.posix.basename(f.path).startsWith('ds-'), f.path).toBe(true);
    expect(applied.skipped).toEqual([]);

    const core = fs.readFileSync(path.join(repo, '.claude/rules/ds-core.md'), 'utf8');
    expect(core).not.toMatch(/^---/); // no paths: always loaded
    expect(core).toContain('ds-stack-angular.md');
    expect(core).toMatch(/Read the spec or Jira ticket first/);
    const stamp = parseStamp(core);
    expect(stamp.template).toBeTruthy();
    expect(stamp.source).toMatch(/^template@/);

    const stack = fs.readFileSync(path.join(repo, '.claude/rules/ds-stack-angular.md'), 'utf8');
    expect(stack).toMatch(/^---\npaths: \[.*"src\/\*\*\/\*\.ts"/);

    const dev = fs.readFileSync(path.join(repo, '.claude/agents/ds-developer.md'), 'utf8');
    expect(dev).toMatch(/^---\nname: ds-developer\n/);
    expect(dev).toContain('Asha, Angular Developer');
    expect(dev).not.toMatch(/\{\{/); // every placeholder was filled

    expect(plan.alwaysLoadedTokens).toBeLessThan(3000); // core + workspace map + persona
    expect(budgetPreview(plan)).toMatch(/Always loaded: \d+ tokens/);
  }, 120000);

  it('graph-derived rules carry source, confidence and evidence that exists', async () => {
    const { repo } = await setup('angular-app');
    const { plan } = generate(repo);
    expect(plan.graphRules).toBeGreaterThan(0);
    const all = plan.files.filter((f) => f.kind === 'rule').flatMap((f) => parseRenderedRules(f.content));
    const graph = all.filter((r) => r.source?.startsWith('graph@'));
    expect(graph.length).toBeGreaterThan(0);
    for (const r of graph) {
      expect(['high', 'medium', 'low']).toContain(r.confidence);
      expect(r.evidence.length).toBeGreaterThan(0);
      for (const ev of r.evidence) expect(fs.existsSync(path.join(repo, ev)), ev).toBe(true);
    }
    expect(graph.map((r) => r.topic)).toEqual(expect.arrayContaining(['naming-observed', 'test-location']));
    expect(graph.find((r) => r.topic === 'naming-observed')!.text).toMatch(/\*\.component\.ts/);
  }, 120000);

  it('Java and Python get their own stack rule files and test commands', async () => {
    const java = await setup('java-spring');
    const jp = generate(java.repo);
    expect(jp.plan.files.map((f) => f.path)).toContain('.claude/rules/ds-stack-java.md');
    expect(fs.readFileSync(path.join(java.repo, '.claude/rules/ds-testing.md'), 'utf8')).toContain('mvn -q test');
    expect(fs.readFileSync(path.join(java.repo, '.claude/rules/ds-stack-java.md'), 'utf8')).toMatch(/constructor injection/i);

    const py = await setup('python-fastapi');
    const pp = generate(py.repo);
    expect(pp.plan.files.map((f) => f.path)).toContain('.claude/rules/ds-stack-python.md');
    expect(fs.readFileSync(path.join(py.repo, '.claude/agents/ds-tester.md'), 'utf8')).toContain('python -m pytest -q');
  }, 240000);

  it('graph rules beat the template default on the same topic (tests next to source for Angular)', async () => {
    const { repo } = await setup('angular-app');
    const { plan } = generate(repo);
    const texts = plan.files.flatMap((f) => parseRenderedRules(f.content)).filter((r) => r.topic === 'test-location').map((r) => r.text);
    expect(texts).toHaveLength(1); // the template default was outranked, not duplicated
    expect(texts[0]).toMatch(/next to the source/);
    expect(plan.dropped.map((d) => d.reason).join(' ')).toMatch(/test-location/);
  }, 120000);

  it('below the coverage threshold only the template layer is generated, with a warning (D-10)', async () => {
    const { repo } = await setup('python-fastapi', { thresholds: { coverage: 1.01 } }); // unreachable threshold
    const { plan, graphSkipped } = generate(repo);
    expect(graphSkipped).toMatch(/below the .*threshold/);
    expect(plan.graphRules).toBe(0);
    expect(plan.warnings[0]).toMatch(/graph build --full/);
    const all = plan.files.flatMap((f) => parseRenderedRules(f.content));
    expect(all.some((r) => r.source?.startsWith('graph@'))).toBe(false);
  }, 120000);

  it('optional agents can be turned off', async () => {
    const { repo } = await setup('python-fastapi', { agents: { tester: false, security: true, 'peer-review': true, auditor: true } });
    const { plan } = generate(repo);
    expect(plan.files.map((f) => f.path)).not.toContain('.claude/agents/ds-tester.md');
    expect(plan.files.map((f) => f.path)).toContain('.claude/agents/ds-developer.md');
  }, 120000);
});

describe('collision policy and developer edits (I-5, I-10)', () => {
  it('skips a clashing file it did not create and reports it, leaving it byte-identical', async () => {
    const { repo } = await setup('python-fastapi');
    write(repo, '.claude/agents/ds-developer.md', 'my own agent\n');
    write(repo, '.claude/agents/other-agent.md', 'unrelated\n');
    const { applied, plan } = generate(repo);
    expect(fs.readFileSync(path.join(repo, '.claude/agents/ds-developer.md'), 'utf8')).toBe('my own agent\n');
    expect(applied.skipped.map((s) => s.path)).toContain('.claude/agents/ds-developer.md');
    expect(plan.warnings.join(' ')).toMatch(/ds-developer.md already exists/);
    expect(fs.readFileSync(path.join(repo, '.claude/agents/other-agent.md'), 'utf8')).toBe('unrelated\n');
    // and it is not recorded as managed, so uninstall will never touch it
    expect(loadConfig(repo)!.managedFiles.map((m) => m.path)).not.toContain('.claude/agents/ds-developer.md');
  }, 120000);

  it('regenerating never overwrites a file the developer edited, and an untouched file is reported unchanged', async () => {
    const { repo } = await setup('python-fastapi');
    generate(repo);
    const target = path.join(repo, '.claude/rules/ds-stack-python.md');
    fs.appendFileSync(target, '- My own team rule about logging formats.\n');
    const edited = fs.readFileSync(target, 'utf8');

    const again = generate(repo);
    const byPath = Object.fromEntries(again.plan.files.map((f) => [f.path, f.status]));
    expect(byPath['.claude/rules/ds-stack-python.md']).toBe('dev-edited');
    expect(fs.readFileSync(target, 'utf8')).toBe(edited);
    expect(byPath['.claude/rules/ds-core.md']).toBe('unchanged');
    expect(again.applied.written).toEqual([]);
  }, 120000);

  it('generation adds files but modifies nothing that already existed', async () => {
    const { repo } = await setup('java-spring');
    const before = git(repo, 'status', '--porcelain');
    generate(repo);
    const after = git(repo, 'status', '--porcelain').split('\n').filter((l) => l && !l.includes('.claude'));
    expect(after).toEqual(before.split('\n').filter((l) => l && !l.includes('.claude')));
    // tracked files unchanged
    expect(git(repo, 'diff', '--stat')).toBe('');
  }, 120000);

  it('stamps are ignored when comparing, so a regeneration at a later time is not a change', async () => {
    const { repo } = await setup('python-fastapi');
    const first = generate(repo);
    const later = planWorkspace(repo, loadConfig(repo)!, new Date(Date.now() + 86_400_000));
    expect(later.plan.files.every((f) => f.status === 'unchanged')).toBe(true);
    expect(stripStamp(first.plan.files[0].content)).not.toMatch(/devsarathi-version/);
  }, 120000);
});

describe('auditor (MASTER 10.5)', () => {
  it('a freshly generated workspace audits clean for every stack', async () => {
    for (const fx of ['angular-app', 'java-spring', 'python-fastapi']) {
      const { repo } = await setup(fx);
      generate(repo);
      const client = new DrishtiClient(repo);
      const h = client.open();
      try {
        const report = auditWorkspace(repo, loadConfig(repo)!, h.store);
        expect(report.status, `${fx}\n${formatAudit(report)}`).toBe('pass');
        expect(report.checked.rules).toBeGreaterThan(8);
      } finally {
        h.close();
      }
    }
  }, 300000);

  it('flags planted contradictions, missing evidence, vague rules, and broken references without editing anything', async () => {
    const { repo } = await setup('java-spring', { agents: { tester: false, security: true, 'peer-review': true, auditor: true } });
    generate(repo);
    const rules = path.join(repo, '.claude/rules/ds-architecture.md');
    fs.appendFileSync(rules, [
      '- Always use constructor injection for dependencies. <!-- source:developer -->',
      '- Never use constructor injection for dependencies. <!-- source:developer -->',
      '- Names should follow the layout in the services folder. <!-- source:graph@abc1234 confidence:high evidence:src/does/not/exist.java -->',
      '- Be careful with the database layer. <!-- source:developer -->',
      '- See /ds-nothing for details. <!-- source:developer -->',
      ''
    ].join('\n'));
    const before = fs.readFileSync(rules, 'utf8');
    const client = new DrishtiClient(repo);
    const h = client.open();
    let report;
    try {
      report = auditWorkspace(repo, loadConfig(repo)!, h.store);
    } finally {
      h.close();
    }
    const titles = report.findings.map((f) => f.title);
    expect(report.status).toBe('fix');
    expect(titles).toContain('Contradicting rules');
    expect(titles).toContain('Rule evidence not found in the graph');
    expect(titles).toContain('Vague rule');
    expect(titles).toContain('Reference to a missing command');
    expect(titles).toContain('Reference to a missing agent'); // ds-developer hands off to ds-tester, which was turned off
    expect(fs.readFileSync(rules, 'utf8')).toBe(before); // never edits silently
  }, 120000);

  it('the audit command returns a non-zero result when there is something to fix', async () => {
    const { repo } = await setup('python-fastapi');
    generate(repo);
    fs.rmSync(path.join(repo, '.claude/rules/ds-core.md'));
    const res = await runCommand('audit', {}, ctxFor(repo));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ds-core.md is missing/);
  }, 120000);
});

describe('rule drift after a pull (D-05, MASTER 9.4)', () => {
  it('low-risk changes auto-apply and are logged; removals wait for approval; reject sticks', async () => {
    const { repo } = await setup('angular-app');
    generate(repo);
    const cfg0 = loadConfig(repo)!;
    expect(cfg0.managedFiles.length).toBeGreaterThan(5);

    // a new feature folder lands on the baseline: the structure rule changes (low risk)
    write(repo, 'src/app/orders/orders.service.ts', "import { Injectable } from '@angular/core';\n@Injectable({ providedIn: 'root' })\nexport class OrdersService {\n  list(): string[] {\n    return [];\n  }\n}\n");
    write(repo, 'src/app/orders/orders.component.ts', "import { Component } from '@angular/core';\n@Component({ selector: 'app-orders', template: '' })\nexport class OrdersComponent {}\n");
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'orders');

    const res = await runCommand('refresh', {}, ctxFor(repo));
    expect(res.ok).toBe(true);
    const changelog = fs.readFileSync(path.join(repo, '.claude/devsarathi/changelog.md'), 'utf8');
    expect(changelog).toMatch(/auto-applied \(low risk\)/);
    expect(fs.readFileSync(path.join(repo, '.claude/rules/ds-architecture.md'), 'utf8')).toContain('orders');

    // now remove the file a rule cites as evidence: pruning is high risk and must wait
    const arch = fs.readFileSync(path.join(repo, '.claude/rules/ds-testing.md'), 'utf8');
    const cited = parseRenderedRules(arch).find((r) => r.topic === 'test-location')!.evidence[0];
    git(repo, 'rm', '-q', cited);
    git(repo, 'commit', '-q', '-m', 'drop a spec');
    await runCommand('refresh', {}, ctxFor(repo));
    const pending = readPending(repo);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((c) => c.risk === 'high' || c.op === 'remove' || c.op === 'change')).toBe(true);
    const before = fs.readFileSync(path.join(repo, '.claude/rules/ds-testing.md'), 'utf8');

    // reject the first one: it is not applied and not proposed again
    const first = pending[0];
    const rej = await runCommand('rules reject', { id: first.id }, ctxFor(repo));
    expect(rej.ok).toBe(true);
    await runCommand('refresh', {}, ctxFor(repo));
    expect(readPending(repo).map((c) => c.id)).not.toContain(first.id);
    expect(fs.readFileSync(path.join(repo, '.claude/rules/ds-testing.md'), 'utf8')).toBe(before);

    // approve whatever is left
    const left = readPending(repo);
    if (left.length) {
      const ok = await runCommand('rules approve', { id: 'all' }, ctxFor(repo));
      expect(ok.ok).toBe(true);
      expect(readPending(repo)).toEqual([]);
      expect(fs.readFileSync(path.join(repo, '.claude/devsarathi/changelog.md'), 'utf8')).toMatch(/approved/);
    }
  }, 240000);

  it('a developer-edited rule file is never regenerated by a refresh (I-10)', async () => {
    const { repo } = await setup('python-fastapi');
    generate(repo);
    const f = path.join(repo, '.claude/rules/ds-architecture.md');
    fs.appendFileSync(f, '- Our team keeps feature flags in config/flags.yml.\n');
    const edited = fs.readFileSync(f, 'utf8');
    write(repo, 'app/orders.py', 'def list_orders():\n    return []\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'orders');
    await runCommand('refresh', {}, ctxFor(repo));
    const after = fs.readFileSync(f, 'utf8');
    expect(after).toContain('Our team keeps feature flags in config/flags.yml.');
    expect(after.startsWith(edited.split('\n')[0])).toBe(true);
  }, 120000);
});
