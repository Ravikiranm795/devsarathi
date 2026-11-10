import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Canary strings that must never appear in any served payload (prompt text, finding detail, rule bodies, secrets). */
export const CANARIES = ['CANARY-FINDING-DETAIL', 'CANARY-FINDING-TITLE', 'CANARY-RULE-BODY', 'CANARY-PROMPT-TEXT', 'CANARY-OVERRIDE-CMD', 'CANARY-PENDING-RULE'];

const day = 86400000;
export const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const dayStr = (daysAgo: number) => iso(daysAgo * day).slice(0, 10);

export function tmpDir(prefix = 'ds-dash-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function put(file: string, content: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** metrics.json in the shape of core's `Metrics` (computeMetricsFrom output). Numbers are chosen so tests can assert on them. */
export function fixtureMetrics(repoName: string) {
  const daily = [20, 19, 18, 15, 14, 13, 8, 7, 6, 5, 2, 1, 0].map((d, i) => ({ date: dayStr(d), commands: 3 + (i % 4), prompts: 2 + (i % 3) }));
  return {
    schema: 1,
    generatedAt: iso(2 * 3600000),
    toolVersion: '0.1.0',
    repo: repoName,
    since: iso(21 * day),
    baselineWindow: { startsAt: iso(21 * day), endsAt: iso(14 * day), days: 7 },
    prompts: { enhanced: 40, needsConfirmation: 3, accepted: 24, edited: 10, rejected: 6, acceptanceRate: 0.6 },
    turnsPerTask: {
      tasks: 21,
      definition: 'A task opens at the first prompt after the previous task ended. A turn is one prompt in that window.',
      baseline: { tasks: 12, avgTurns: 6.5 },
      withEnhancer: { tasks: 9, avgTurns: 3.8 },
      other: { tasks: 0, avgTurns: null },
      improvement: 0.415,
      note: 'Compare turns per task BEFORE (first 7 days, enhancer optional) with tasks that used the enhancer. Acceptance rate is shown beside it because acceptance alone can be inflated.',
      history: [7, 6, 8, 5, 6, 7, 4, 3, 4, 5].map((turns, i) => ({ at: iso((20 - i) * day), turns, phase: i < 5 ? 'baseline' : 'enhancer' }))
    },
    review: {
      runs: 5,
      byVerdict: { clean: 2, findings: 2, incomplete: 1 },
      findingsBySeverity: { critical: 1, high: 2, medium: 4, low: 3 },
      findingsByAgent: { security: 3, impact: 2, tester: 1, 'peer-review': 4, spec: 0 },
      findingsActedOn: 6,
      redFlagsAtPush: 2,
      redFlagsTotal: 3,
      pushReviews: 4
    },
    graph: {
      builds: 7,
      failures: 1,
      avgDurationMs: 4200,
      lastCoverage: 0.93,
      belowThreshold: 0,
      history: [0.9, 0.91, 0.92, 0.93].map((coverage, i) => ({ at: iso((10 - i) * day), durationMs: 4000 + i * 100, coverage, baseline: true, full: i === 0, status: 'completed' }))
        .concat([{ at: iso(5 * day), durationMs: 900, coverage: null as unknown as number, baseline: null as unknown as boolean, full: null as unknown as boolean, status: 'failed' }])
    },
    rules: { autoApplied: 5, approved: 3, rejected: 1 },
    agents: {
      security: { completed: 4, failed: 1, timeout: 0, skipped: 0 },
      impact: { completed: 5, failed: 0, timeout: 0, skipped: 0 },
      tester: { completed: 3, failed: 0, timeout: 2, skipped: 0 }
    },
    usage: { commands: { review: 9, 'graph build': 7, enhance: 5 }, activeDays: 13, days: daily.map((d) => d.date), daily },
    selftest: {
      runs: [
        { at: iso(9 * day), passed: 12, total: 12, failed: [] },
        { at: iso(4 * day), passed: 10, total: 12, failed: ['hooks-installed', 'graph-fresh'] },
        { at: iso(1 * day), passed: 12, total: 12, failed: [] }
      ],
      lastPassed: true
    }
  };
}

export interface FixtureOpts {
  name?: string;
  baseline?: boolean;
  branch?: string;
}

/** A realistic `<repo>/.claude/devsarathi/` state folder, including canary text the dashboard must never serve. */
export function makeRepo(parent: string, o: FixtureOpts = {}): string {
  const name = o.name ?? 'acme-shop';
  const repo = path.join(parent, name);
  const st = path.join(repo, '.claude', 'devsarathi');
  const baseline = o.baseline ?? true;
  put(path.join(st, 'config.json'), {
    schemaVersion: 1,
    toolVersion: '0.1.0',
    baselineBranch: 'main',
    persona: { name: 'Asha', title: 'Frontend Developer' },
    stacks: [{ id: 'react', category: 'frontend', dir: '.', frameworks: ['next'] }, { id: 'java', category: 'backend', dir: 'services/api', frameworks: [] }],
    thresholds: { coverage: 0.8, enhanceTargetChars: 400 },
    commandOverrides: { test: 'CANARY-OVERRIDE-CMD --token=abc' },
    disabled: false,
    initializedAt: iso(21 * day)
  });
  put(path.join(st, 'graph', 'build-record.json'), {
    graphFormat: 1,
    branch: o.branch ?? (baseline ? 'main' : 'feature/login-flow'),
    commit: '9fceb02d4a7c1e5b8d3f60a1c2b4d5e6f7a8b9c0',
    baseline,
    builtAt: iso(3 * 3600000),
    durationMs: 4321,
    full: false,
    coverage: { eligibleFiles: 440, parsedFiles: 412, ratio: 0.936, symbols: 3150, resolvedCallEdges: 9000, unresolvedCalls: 120 },
    belowThreshold: false,
    status: 'completed'
  });
  put(path.join(st, 'graph', 'summary.json'), {
    files: 412,
    symbols: 3150,
    modules: [
      { name: 'src/components', files: 120, symbols: 900 },
      { name: 'src/services', files: 60, symbols: 1400 },
      { name: 'services/api', files: 90, symbols: 600 },
      { name: '(root)', files: 5, symbols: 20 }
    ],
    languages: { '.ts': 250, '.tsx': 100, '.java': 50, '.json': 12 }
  });
  put(path.join(st, 'metrics', 'metrics.json'), fixtureMetrics(name));
  // Raw events are never exposed; the canary proves it.
  put(path.join(st, 'metrics', 'events.jsonl'), JSON.stringify({ t: iso(day), type: 'prompt', data: { text: 'CANARY-PROMPT-TEXT' } }) + '\n');
  const finding = (agent: string, severity: string, redFlag = false) => ({ id: `${agent}-${severity}`, agent, severity, title: 'CANARY-FINDING-TITLE', file: 'src/secret.ts', line: 4, detail: 'CANARY-FINDING-DETAIL', suggestion: 'CANARY-FINDING-DETAIL', redFlag });
  put(path.join(st, 'reviews', 'review-20260101-aaa.json'), {
    runId: '20260101-aaa', createdAt: iso(2 * day), branch: 'feature/login-flow', head: 'abc', range: 'main...HEAD', specChanged: false, verdict: 'findings',
    runs: [
      { agent: 'security', status: 'completed', startedAt: iso(2 * day), durationMs: 10, findings: [finding('security', 'high', true), finding('security', 'low')] },
      { agent: 'peer-review', status: 'completed', startedAt: iso(2 * day), durationMs: 10, findings: [finding('peer-review', 'medium')] }
    ]
  });
  put(path.join(st, 'reviews', 'review-20260102-bbb.json'), {
    runId: '20260102-bbb', createdAt: iso(1 * day), branch: 'main', head: 'def', range: 'origin/main..HEAD', specChanged: false, verdict: 'incomplete',
    runs: [
      { agent: 'security', status: 'completed', startedAt: iso(day), durationMs: 10, findings: [] },
      { agent: 'tester', status: 'timeout', error: 'CANARY-FINDING-DETAIL timed out', startedAt: iso(day), durationMs: 90000, findings: [] }
    ]
  });
  put(path.join(st, 'reviews', 'review-20260102-bbb.md'), 'CANARY-FINDING-DETAIL markdown');
  put(path.join(st, 'reviews', 'audit-1700000000000.json'), { status: 'fix', findings: [finding('auditor', 'medium'), finding('auditor', 'low')], checked: { files: 8, rules: 61 } });
  put(
    path.join(st, 'changelog.md'),
    '# DevSarathi rule changelog\n\n' +
      `- ${iso(5 * day)} auto-applied (low risk) add in CLAUDE.md: new test command detected\n  + CANARY-RULE-BODY one\n` +
      `- ${iso(3 * day)} approved (medium risk) replace in .claude/rules/react.md: component naming changed\n  - CANARY-RULE-BODY old\n  + CANARY-RULE-BODY new\n` +
      `- ${iso(1 * day)} rejected (high risk) remove in .claude/rules/security.md: contradicts policy\n`
  );
  put(path.join(st, 'pending-rules.json'), [{ id: 1, newLine: 'CANARY-PENDING-RULE' }, { id: 2, newLine: 'CANARY-PENDING-RULE' }]);
  put(
    path.join(st, 'notices.jsonl'),
    [
      JSON.stringify({ at: iso(3 * day), source: 'review', message: 'security did not run: boom' }),
      '{ this line is corrupt',
      JSON.stringify({ at: iso(2 * day), source: 'graph-build', message: `Graph build failed in ${repo}: out of memory` }),
      JSON.stringify({ at: iso(1 * day), source: 'hook', message: 'DevSarathi is not installed at the recorded location.' })
    ].join('\n') + '\n'
  );
  return repo;
}

export function addFailure(repo: string): void {
  put(path.join(repo, '.claude', 'devsarathi', 'last-build-failure.json'), { at: iso(5 * day), branch: 'feature/login-flow', commit: 'abc', error: `ENOSPC while writing ${repo}\\graph.db` });
}

/** A repo whose every state file is garbage, to prove nothing 500s. */
export function makeCorruptRepo(parent: string): string {
  const repo = path.join(parent, 'broken-repo');
  const st = path.join(repo, '.claude', 'devsarathi');
  put(path.join(st, 'config.json'), '{ not json');
  put(path.join(st, 'graph', 'build-record.json'), '[1,2,3]');
  put(path.join(st, 'graph', 'summary.json'), '"a string"');
  put(path.join(st, 'metrics', 'metrics.json'), '[]');
  put(path.join(st, 'reviews', 'review-x.json'), 'nope');
  put(path.join(st, 'reviews', 'audit-1.json'), '{{');
  put(path.join(st, 'changelog.md'), '\u0000\u0001 binary-ish\n- not a valid entry\n');
  put(path.join(st, 'pending-rules.json'), '{"not":"an array"}');
  put(path.join(st, 'notices.jsonl'), 'garbage\n{"at":1}\n');
  put(path.join(st, 'last-build-failure.json'), 'null');
  return repo;
}

export function writeRegistry(file: string, repos: { path: string; name?: string; stacks?: string[]; baselineBranch?: string }[]): void {
  put(file, { version: 1, repos: repos.map((r) => ({ name: path.basename(r.path), stacks: ['react'], baselineBranch: 'main', registeredAt: iso(day), ...r })) });
}
