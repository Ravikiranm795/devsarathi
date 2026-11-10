import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AgentRun, DevSarathiConfig, Finding, ReviewResult, Severity } from '@devsarathi/shared';
import { requireConfig } from '../lib/config';
import { repoPaths } from '../lib/paths';
import { writeJson, writeFileAtomic } from '../lib/fsutil';
import { collectChanges, ChangeSet } from '../lib/diff';
import { git, currentBranch, headCommit } from '../lib/git';
import { recordEvent } from '../lib/events';
import { notifyFailure } from '../lib/notify';
import { DrishtiClient, resolveBaselineRef } from '../graph/drishti';
import { computeOverlay, overlayImpact, OverlayResult } from '../graph/overlay';
import { brain } from '../graph/brain';
import { scanChanges } from '../security/scanner';
import { loadStackProfile, SecurityPattern } from '../generate/templates';
import { stacksOf } from '../generate/service';
import { checkTestPresence } from './tester';
import { checkSpecChanged } from '../enhance/spec';
import { tokens } from '../audit/auditor';

export interface ReviewOptions {
  /** A..B: the commits being pushed. Without it, everything that differs from the baseline right now. */
  range?: string;
  trigger?: 'manual' | 'pre-push' | 'selftest';
  /** Run only one agent's checks (used by the ds-security and ds-peer-review agents). */
  only?: AgentRun['agent'];
}

export interface ReviewOutcome {
  result: ReviewResult;
  redFlags: Finding[];
  markdown: string;
  text: string;
}

type Agent = AgentRun['agent'];

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Time and guard one check. Any throw becomes a `failed` run: it can never read as a pass (I-4). */
async function step(agent: Agent, body: () => Promise<Finding[]> | Finding[]): Promise<AgentRun> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    const findings = await body();
    return { agent, status: 'completed', startedAt, durationMs: Date.now() - started, findings };
  } catch (err) {
    return { agent, status: 'failed', error: err instanceof Error ? err.message : String(err), startedAt, durationMs: Date.now() - started, findings: [] };
  }
}

const skipped = (agent: Agent, why: string): AgentRun => ({ agent, status: 'skipped', error: why, startedAt: new Date().toISOString(), durationMs: 0, findings: [] });

let peerSeq = 0;
const DEBUG_RE = /console\.(log|debug)\(|System\.out\.print|printStackTrace\(|\bdebugger\b|var_dump\(|\bdd\(|(^|\s)print\(/;
const CODE_LIKE = /[;{}]\s*$|\s=\s|\)\s*\{?$/;

/** Deterministic peer-review checks: debug leftovers, new TODOs, commented-out code (MASTER 10.4). */
function peerChecks(changes: ChangeSet, isTest: (p: string) => boolean): Finding[] {
  peerSeq = 0;
  const out: Finding[] = [];
  const add = (f: Omit<Finding, 'id' | 'agent' | 'redFlag'>) => out.push({ id: `PEER-${String(++peerSeq).padStart(3, '0')}`, agent: 'peer-review', redFlag: false, ...f });
  for (const f of changes.files) {
    if (f.secret || f.binary || isTest(f.path) || !/\.(ts|tsx|js|jsx|java|py|php|cs|kt)$/.test(f.path)) continue;
    if (/(^|\/)(bin|scripts|cli)\//.test(f.path)) continue; // command-line code prints by design
    let run = 0;
    for (const l of f.added) {
      if (DEBUG_RE.test(l.text) && !/^\s*(\/\/|#|\*)/.test(l.text)) add({ severity: 'low', title: 'Debug output left in code', file: f.path, line: l.line, suggestion: 'Remove it or use the project logger.' });
      if (/\b(TODO|FIXME|XXX)\b/.test(l.text)) add({ severity: 'low', title: 'New TODO/FIXME', file: f.path, line: l.line, detail: l.text.trim().slice(0, 120), suggestion: 'Resolve it, or link it to a ticket.' });
      const commented = /^\s*(\/\/|#)\s?\S/.test(l.text) && CODE_LIKE.test(l.text.replace(/^\s*(\/\/|#)\s?/, ''));
      run = commented ? run + 1 : 0;
      if (run === 3) add({ severity: 'low', title: 'Commented-out code', file: f.path, line: l.line - 2, suggestion: 'Delete it; version control remembers.' });
    }
  }
  return out;
}

function criteriaEvidence(changes: ChangeSet, criteria: { id: string; text: string }[]): Finding[] {
  const added = changes.files.filter((f) => !f.secret && !f.binary).map((f) => f.added.map((a) => a.text).join('\n')).join('\n').toLowerCase();
  const out: Finding[] = [];
  let n = 0;
  for (const c of criteria) {
    const hits = [...tokens(c.text)].filter((t) => added.includes(t)).length;
    if (hits < 2) {
      out.push({ id: `SPEC-${String(++n).padStart(3, '0')}`, agent: 'spec', severity: 'low', title: `No evidence in this change for ${c.id}`, detail: `"${c.text.slice(0, 140)}": nothing in the added code or tests mentions it. Confirm it is covered elsewhere.`, redFlag: false });
    }
  }
  return out;
}

const fingerprint = (f: Finding) => `${f.agent}|${f.title}|${f.file ?? ''}`;

/** Findings from the previous review of this branch that are gone from this one: "findings acted on" (MASTER 16). */
function countResolved(reviewsDir: string, current: ReviewResult): Record<string, number> {
  try {
    const prev = fs
      .readdirSync(reviewsDir)
      .filter((f) => /^review-.*.json$/.test(f))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(reviewsDir, f), 'utf8')) as ReviewResult)
      .filter((r) => r.branch === current.branch && r.runId !== current.runId)
      .pop();
    if (!prev) return {};
    const now = new Set(current.runs.flatMap((r) => r.findings).map(fingerprint));
    const gone = prev.runs.flatMap((r) => r.findings).filter((f) => f.severity !== 'info' && !now.has(fingerprint(f)));
    const by: Record<string, number> = {};
    for (const f of gone) by[f.agent] = (by[f.agent] ?? 0) + 1;
    return by;
  } catch {
    return {};
  }
}

export function verdictOf(runs: AgentRun[]): ReviewResult['verdict'] {
  if (runs.some((r) => r.status === 'failed' || r.status === 'timeout')) return 'incomplete'; // I-4
  const real = runs.flatMap((r) => r.findings).filter((f) => f.severity !== 'info');
  return real.length ? 'findings' : 'clean';
}

export async function runReview(root: string, opts: ReviewOptions = {}): Promise<ReviewOutcome> {
  const cfg = requireConfig(root);
  const client = new DrishtiClient(root);
  const started = Date.now();
  const baselineRef = await resolveBaselineRef(root, cfg.baselineBranch);
  const want = (a: Agent) => !opts.only || opts.only === a;

  const branch = await currentBranch(root);
  const head = await headCommit(root);
  const runs: AgentRun[] = [];

  let changes: ChangeSet | undefined;
  let overlay: OverlayResult | undefined;
  let prepError: string | undefined;
  try {
    changes = await collectChanges(root, { range: opts.range, baseRef: baselineRef });
    if (client.hasGraph()) overlay = await computeOverlay(root, client, { range: opts.range, persist: false });
  } catch (err) {
    prepError = err instanceof Error ? err.message : String(err);
  }
  const isTest: (p: string) => boolean = brain.config().isTestFile;

  // --- security --------------------------------------------------------------------------------------------------
  if (want('security')) {
    if (!cfg.agents.security) runs.push(skipped('security', 'turned off in config'));
    else
      runs.push(
        await step('security', async () => {
          if (!changes) throw new Error(prepError ?? 'could not read the changes');
          const patterns: SecurityPattern[] = stacksOf(cfg).flatMap((s) => loadStackProfile(s.id)?.security.patterns ?? []);
          const tracked = new Set((await git(['ls-files'], root)).stdout.split('\n').filter(Boolean));
          return scanChanges(changes, { stackPatterns: patterns, trackedSecretFiles: tracked });
        })
      );
  }

  // --- impact: every changed symbol's callers must have been considered (MASTER 7.6) -------------------------------
  if (want('impact') || want('peer-review')) {
    runs.push(
      await step('impact', async () => {
        if (!changes) throw new Error(prepError ?? 'could not read the changes');
        if (!client.hasGraph() || !overlay) throw new Error('there is no graph, so impact could not be checked. Run: devsarathi graph build');
        const findings: Finding[] = [];
        let n = 0;
        for (const oi of overlayImpact(client, overlay)) {
          if (oi.untouchedCallers.length === 0) continue;
          const names = [...new Set(oi.untouchedCallers.map((c) => `${c.name} (${c.path}:${c.startLine})`))];
          const removed = oi.changed.change === 'removed';
          findings.push({
            id: `IMP-${String(++n).padStart(3, '0')}`,
            agent: 'impact',
            severity: removed || oi.changed.signatureChanged ? 'high' : 'medium',
            title: `${removed ? 'Removed' : oi.changed.signatureChanged ? 'Changed the signature of' : 'Changed'} ${oi.changed.name} without touching its ${names.length} caller${names.length === 1 ? '' : 's'}`,
            file: oi.changed.path,
            detail: `Callers in files this change does not touch: ${names.slice(0, 5).join('; ')}${names.length > 5 ? `; and ${names.length - 5} more` : ''}. Impact confidence: ${oi.impact.confidence.toUpperCase()}. ${oi.impact.reasons[0] ?? ''}`,
            suggestion: 'Check each caller still works, or update it in this change.',
            redFlag: false
          });
        }
        return findings;
      })
    );
  }

  // --- tester (presence of tests; the test command itself is `devsarathi test`) ------------------------------------
  if (want('tester')) {
    if (!cfg.agents.tester) runs.push(skipped('tester', 'turned off in config'));
    else
      runs.push(
        await step('tester', async () => {
          if (!changes) throw new Error(prepError ?? 'could not read the changes');
          if (!client.hasGraph() || !overlay) throw new Error('there is no graph, so test coverage could not be checked');
          return (await checkTestPresence(client, overlay, changes, { root, range: opts.range })).findings;
        })
      );
  }

  // --- peer review ---------------------------------------------------------------------------------------------------
  if (want('peer-review')) {
    if (!cfg.agents['peer-review']) runs.push(skipped('peer-review', 'turned off in config'));
    else
      runs.push(
        await step('peer-review', async () => {
          if (!changes) throw new Error(prepError ?? 'could not read the changes');
          return peerChecks(changes, isTest);
        })
      );
  }

  // --- spec ------------------------------------------------------------------------------------------------------------
  let specHash: string | undefined;
  let specChanged = false;
  if (want('spec') || !opts.only) {
    runs.push(
      await step('spec', async () => {
        const findings: Finding[] = [];
        const s = checkSpecChanged(root);
        if (!s.active) {
          findings.push({ id: 'SPEC-000', agent: 'spec', severity: 'info', title: 'No spec is recorded for this work', detail: 'Acceptance criteria were not checked. Start work with: devsarathi enhance "<request>" --spec <path>', redFlag: false });
          return findings;
        }
        specHash = s.active.hash;
        if (s.missing) findings.push({ id: 'SPEC-001', agent: 'spec', severity: 'medium', title: `The recorded spec ${s.active.ref} can no longer be read`, redFlag: false });
        if (s.changed) {
          specChanged = true;
          findings.push({ id: 'SPEC-002', agent: 'spec', severity: 'medium', title: `The spec ${s.active.ref} changed after work started`, detail: 'The work was built against an earlier version. Re-read the spec and check the acceptance criteria again.', redFlag: false });
        }
        if (s.current && changes) findings.push(...criteriaEvidence(changes, s.current.criteria));
        return findings;
      })
    );
  }

  const result: ReviewResult = {
    runId: `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`,
    createdAt: new Date().toISOString(),
    branch,
    head,
    range: opts.range ?? changes?.label ?? 'working tree',
    specHash,
    specChanged,
    runs,
    verdict: verdictOf(runs)
  };
  if (prepError && result.verdict === 'clean') result.verdict = 'incomplete';

  const outcome = formatReview(result, opts.trigger === 'pre-push');
  const p = repoPaths(root);
  const resolved = countResolved(p.reviews, result);
  writeJson(path.join(p.reviews, `review-${result.runId}.json`), result);
  writeFileAtomic(path.join(p.reviews, `review-${result.runId}.md`), outcome.markdown);

  // D-13: a run that did not complete is a visible notification (with the error), never a quiet pass.
  for (const r of runs) if (r.status === 'failed' || r.status === 'timeout') notifyFailure(root, `ds-${r.agent}`, r.error ?? r.status);

  const all = runs.flatMap((r) => r.findings);
  const bySeverity = Object.fromEntries((['critical', 'high', 'medium', 'low', 'info'] as Severity[]).map((s) => [s, all.filter((f) => f.severity === s).length]));
  recordEvent(root, {
    type: 'review',
    data: {
      trigger: opts.trigger ?? 'manual',
      verdict: result.verdict,
      redFlags: outcome.redFlags.length,
      resolved: Object.values(resolved).reduce((a, b) => a + b, 0),
      ...Object.fromEntries(Object.entries(resolved).map(([k, v]) => [`resolved_${k}`, v])),
      durationMs: Date.now() - started,
      ...bySeverity,
      ...Object.fromEntries(runs.map((r) => [`run_${r.agent}`, r.status])),
      ...Object.fromEntries(runs.map((r) => [`findings_${r.agent}`, r.findings.filter((f) => f.severity !== 'info').length]))
    }
  });
  return outcome;
}

export function formatReview(result: ReviewResult, compact = false): ReviewOutcome {
  const all = result.runs.flatMap((r) => r.findings).filter((f) => f.severity !== 'info' || !compact);
  const redFlags = all.filter((f) => f.redFlag);
  const rest = all.filter((f) => !f.redFlag).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const ordered = [...redFlags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]), ...rest];

  const lines: string[] = [];
  const head =
    result.verdict === 'clean'
      ? `DevSarathi review: clean (${result.range}).`
      : result.verdict === 'incomplete'
        ? `DevSarathi review: INCOMPLETE (${result.range}). This is not a clean review.`
        : `DevSarathi review: ${ordered.length} finding(s) (${result.range}).`;
  lines.push(head);
  for (const r of result.runs) {
    if (r.status === 'failed' || r.status === 'timeout') lines.push(`  ! ${r.agent} did not run: ${r.error ?? r.status}`);
  }
  if (redFlags.length) lines.push('', `RED FLAGS (${redFlags.length}): secrets or environment files. These never block your push.`);
  const limit = Math.max(compact ? 25 : 150, redFlags.length);
  ordered.slice(0, limit).forEach((f, i) => {
    if (i === redFlags.length && redFlags.length) lines.push('', 'Other findings:');
    const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    lines.push(`${i + 1}. [${f.severity}] (${f.agent}) ${f.title}${where}`);
    if (f.detail) lines.push(`   ${f.detail.replace(/\n/g, '\n   ')}`);
    if (f.suggestion && !compact) lines.push(`   Fix: ${f.suggestion}`);
  });
  if (ordered.length > limit) lines.push('', `... and ${ordered.length - limit} more${compact ? ' (run /ds-review or devsarathi review for the full list)' : ''}.`);
  const skippedRuns = result.runs.filter((r) => r.status === 'skipped').map((r) => r.agent);
  if (skippedRuns.length) lines.push('', `Skipped (turned off): ${skippedRuns.join(', ')}.`);
  if (result.specChanged) lines.push('', 'Warning: the spec changed after work started.');

  const text = lines.join('\n');
  const md = [`# DevSarathi review ${result.runId}`, '', `- Range: ${result.range}`, `- Branch: ${result.branch} @ ${result.head.slice(0, 7)}`, `- Verdict: **${result.verdict}**`, '', '```', text, '```', ''].join('\n');
  return { result, redFlags, markdown: md, text };
}

export type { DevSarathiConfig };
