import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { git } from '../lib/git';
import { AgentRun, DevSarathiConfig, Finding } from '@devsarathi/shared';
import { ChangeSet } from '../lib/diff';
import { DrishtiClient } from '../graph/drishti';
import { OverlayResult } from '../graph/overlay';
import { brain } from '../graph/brain';
import { redact } from '../security/secretPatterns';
import { loadStackProfile, stackCommand, StackProfileFiles } from '../generate/templates';
import { stacksOf } from '../generate/service';
import { Criterion } from '../enhance/spec';
import { tokens } from '../audit/auditor';

/* eslint-disable @typescript-eslint/no-explicit-any */

let seq = 0;
const nextId = () => `TST-${String(++seq).padStart(3, '0')}`;

const SKIP_NAMES = new Set(['constructor', '__init__', 'main', 'ngOnInit', 'ngOnDestroy', 'toString', 'hashCode', 'equals']);

const MAX_TEST_BYTES = 300 * 1024;
const MAX_TEST_TOTAL = 8 * 1024 * 1024;
const MAX_LISTED = 20;

/**
 * The text of every test file in the tree being reviewed (the pushed tip, or the working tree). A function is covered when
 * ANY test mentions it, not just tests touched by this change: otherwise every function of a branch that already has
 * tests would be reported as untested.
 */
async function readTestTree(root: string, tip: string | undefined, isTest: (p: string) => boolean): Promise<string> {
  const supported: Set<string> = brain.config().SUPPORTED_EXTENSIONS;
  let names: string[] = [];
  if (tip) {
    const r = await git(['ls-tree', '-r', '--name-only', tip], root);
    names = r.ok ? r.stdout.split('\n').filter(Boolean) : [];
  } else {
    const tracked = await git(['ls-files'], root);
    const others = await git(['ls-files', '--others', '--exclude-standard'], root);
    names = [...(tracked.ok ? tracked.stdout.split('\n') : []), ...(others.ok ? others.stdout.split('\n') : [])].filter(Boolean);
  }
  const out: string[] = [];
  let total = 0;
  for (const rel of names) {
    if (!isTest(rel) || !supported.has(path.extname(rel)) || total > MAX_TEST_TOTAL) continue;
    try {
      let text: string;
      if (tip) {
        const shown = await git(['show', `${tip}:${rel}`], root);
        if (!shown.ok) continue;
        text = shown.stdout;
      } else {
        const abs = path.join(root, rel);
        if (fs.statSync(abs).size > MAX_TEST_BYTES) continue;
        text = fs.readFileSync(abs, 'utf8');
      }
      if (text.length > MAX_TEST_BYTES) continue;
      total += text.length;
      out.push(text);
    } catch {
      /* deleted or unreadable: skip */
    }
  }
  return out.join('\n');
}

/** Changed or new functions that no test reaches: the deterministic half of ds-tester. */
export async function checkTestPresence(
  client: DrishtiClient,
  overlay: OverlayResult,
  changes: ChangeSet,
  opts: { root: string; range?: string }
): Promise<{ findings: Finding[]; missing: string[] }> {
  seq = 0;
  const findings: Finding[] = [];
  const missing: string[] = [];
  if (!client.hasGraph()) return { findings, missing };
  const isTest: (p: string) => boolean = brain.config().isTestFile;
  const changedTestText = changes.files
    .filter((f) => isTest(f.path))
    .map((f) => f.added.map((a) => a.text).join('\n'))
    .join('\n');
  const testText = `${changedTestText}\n${await readTestTree(opts.root, opts.range?.split('..')[1], isTest)}`;
  const h = client.open();
  try {
    for (const s of overlay.symbols) {
      if (s.change === 'removed' || isTest(s.path) || !['function', 'method'].includes(s.kind) || SKIP_NAMES.has(s.name)) continue;
      const word = new RegExp(`\\b${s.name.replace(/[$]/g, '\\$')}\\b`);
      let covered = word.test(testText);
      if (!covered && s.symbolId != null) {
        const tests = h.store.getTestsForSymbol(s.symbolId, 6, { limit: 5, minConfidence: 0 }) as { confidence?: number }[];
        covered = tests.some((t) => (t.confidence ?? 0) >= 0.2);
      }
      if (!covered && s.change === 'added') {
        const hit = h.store.db
          .prepare('SELECT 1 FROM chunks c JOIN symbols x ON x.id = c.symbol_id JOIN files f ON f.id = x.file_id WHERE f.is_test = 1 AND c.code LIKE ? LIMIT 1')
          .get(`%${s.name}%`);
        covered = !!hit;
      }
      if (!covered) {
        missing.push(`${s.path}::${s.name}`);
        findings.push({
          id: nextId(),
          agent: 'tester',
          severity: 'medium',
          title: `No test covers ${s.change === 'added' ? 'new' : 'changed'} ${s.kind} ${s.name}`,
          file: s.path,
          detail: 'No test file in the tree mentions it, and the graph finds no test that reaches it.',
          suggestion: 'Add a test that follows the repo\'s test conventions (see .claude/rules/ds-testing.md).',
          redFlag: false
        });
      }
    }
  } finally {
    h.close();
  }
  // A big change would bury everything else: keep the first ones and summarize the rest.
  if (findings.length > MAX_LISTED) {
    const rest = findings.splice(MAX_LISTED);
    const byFile = new Map<string, number>();
    for (const f of rest) byFile.set(f.file ?? '?', (byFile.get(f.file ?? '?') ?? 0) + 1);
    const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, n]) => `${f} (${n})`);
    findings.push({
      id: nextId(),
      agent: 'tester',
      severity: 'medium',
      title: `${rest.length} more changed or new functions have no test mentioning them`,
      detail: `Most in: ${top.join(', ')}. The full list is in devsarathi test.`,
      suggestion: "Add tests that follow the repo's test conventions (see .claude/rules/ds-testing.md).",
      redFlag: false
    });
  }
  return { findings, missing };
}

export interface TestRunResult {
  run: AgentRun;
  status: 'pass' | 'fail' | 'incomplete';
  commands: { command: string; cwd: string; exitCode: number | null; ran: boolean; tail: string }[];
  criteria: { id: string; result: 'pass' | 'fail' | 'untested' }[];
  missingTests: string[];
  failures: string[];
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; error?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // The command strings come from the shipped profiles or the developer's own config, never from a prompt or a diff.
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let out = '';
    const keep = (d: Buffer) => {
      out += d.toString();
      if (out.length > 40000) out = out.slice(-40000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, error: e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

const NOT_FOUND = /is not recognized as an internal or external command|command not found|not found: |ENOENT|No such file or directory/i;

export function testCommands(cfg: DevSarathiConfig): { command: string; cwd: string; stack: string }[] {
  if (cfg.commandOverrides.test) return [{ command: cfg.commandOverrides.test, cwd: '.', stack: 'override' }];
  const out: { command: string; cwd: string; stack: string }[] = [];
  const profiles = new Map<string, StackProfileFiles>();
  for (const s of stacksOf(cfg)) {
    const p = loadStackProfile(s.id);
    if (p) profiles.set(s.id, p);
    const c = stackCommand(s, p, 'test');
    if (c) {
      // gradle's wrapper needs ./ on POSIX
      const command = process.platform !== 'win32' && /^gradlew\b/.test(c.command) ? `./${c.command}` : c.command;
      out.push({ command, cwd: c.cwd, stack: s.id });
    }
  }
  return out;
}

/** Run the stack's test command(s) and map the outcome to the spec's acceptance criteria (MASTER 10.2). */
export async function runTests(root: string, cfg: DevSarathiConfig, opts: { criteria?: Criterion[]; changedTestText?: string; timeoutMs?: number }): Promise<TestRunResult> {
  seq = 100;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const commands: TestRunResult['commands'] = [];
  const findings: Finding[] = [];
  const failures: string[] = [];
  const list = testCommands(cfg);
  let status: TestRunResult['status'] = 'pass';
  let error: string | undefined;
  let runStatus: AgentRun['status'] = 'completed';

  if (list.length === 0) {
    runStatus = 'failed';
    error = 'no test command is known for this stack; set commandOverrides.test in .claude/devsarathi/config.json';
    status = 'incomplete';
  }
  for (const c of list) {
    const cwd = path.resolve(root, c.cwd);
    const r = await runShell(c.command, cwd, opts.timeoutMs ?? 30 * 60 * 1000);
    const tail = redact(r.out.split('\n').slice(-25).join('\n')).slice(-2500);
    const couldNotRun = r.error !== undefined || (r.code !== 0 && r.code !== null && (r.code === 127 || NOT_FOUND.test(r.out) && r.out.length < 600));
    commands.push({ command: c.command, cwd: c.cwd, exitCode: r.code, ran: !couldNotRun && !r.timedOut, tail });
    if (r.timedOut) {
      runStatus = 'timeout';
      error = `${c.command} did not finish in time`;
      status = 'incomplete';
    } else if (couldNotRun) {
      runStatus = 'failed';
      error = `${c.command} could not run: ${r.error ?? tail.split('\n').filter(Boolean).slice(-1)[0] ?? 'command not found'}`;
      status = 'incomplete';
    } else if (r.code !== 0) {
      if (status === 'pass') status = 'fail';
      failures.push(`${c.command}: exit ${r.code}`);
      findings.push({ id: nextId(), agent: 'tester', severity: 'high', title: 'Tests failed', detail: `${c.command} exited with ${r.code}.\n${tail.slice(-800)}`, suggestion: 'Fix the failing tests before pushing.', redFlag: false });
    }
  }

  const criteria = (opts.criteria ?? []).map((cr) => {
    if (status === 'incomplete') return { id: cr.id, result: 'untested' as const };
    const mentioned = [...tokens(cr.text)].filter((t) => (opts.changedTestText ?? '').toLowerCase().includes(t)).length >= 2;
    return { id: cr.id, result: status === 'fail' ? ('fail' as const) : mentioned ? ('pass' as const) : ('untested' as const) };
  });

  return {
    run: { agent: 'tester', status: runStatus, error, startedAt, durationMs: Date.now() - started, findings },
    status,
    commands,
    criteria,
    missingTests: [],
    failures
  };
}
