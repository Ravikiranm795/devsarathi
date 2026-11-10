import { CliOutcome, RunSpec } from './cli';

/*
 * Turns a CLI outcome into what the developer should be told. Rule I-4 / D-13: a command that failed, threw, or
 * whose run did not complete is NEVER shown as a pass; it becomes "<Agent or command> did not run: <error>".
 */

export interface Failure {
  label: string;
  error: string;
}

export type Verdict =
  | { kind: 'ok'; text: string }
  /** The command ran, but it reports problems (review findings, failing tests, a self-test that did not pass). */
  | { kind: 'problems'; text: string }
  | { kind: 'not-run'; failures: Failure[]; text: string }
  | { kind: 'cancelled'; text: string };

/** Names shown to the developer: the agent for agent runs, `devsarathi <command>` for everything else. */
export function commandLabel(command: string[]): string {
  const key = command.join(' ');
  if (key === 'test') return 'ds-tester';
  if (key === 'review') return 'Review';
  return `devsarathi ${key}`;
}

/** First line of an error, without a redundant "<x> did not run:" prefix the core already added. */
export function cleanError(msg: string): string {
  const first = msg.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const stripped = first.replace(/^[\w .@/-]{1,40}?\s+did not run:\s*/i, '');
  const text = (stripped || first || 'unknown error').replace(/^error:\s*/i, '');
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

export const didNotRun = (f: Failure): string => `${f.label} did not run: ${f.error}`;

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function notRun(failures: Failure[]): Verdict {
  return { kind: 'not-run', failures, text: failures.map(didNotRun).join('\n') };
}

function reviewVerdict(label: string, ok: boolean, message: string, data: unknown): Verdict | undefined {
  const d = obj(data);
  const runs = Array.isArray(d?.runs) ? (d!.runs as unknown[]).map(obj).filter((r): r is Record<string, unknown> => !!r) : [];
  const bad = runs.filter((r) => r.status === 'failed' || r.status === 'timeout');
  if (bad.length) return notRun(bad.map((r) => ({ label: `ds-${String(r.agent)}`, error: cleanError(String(r.error ?? r.status)) })));
  if (d?.verdict === 'incomplete') {
    const skipped = runs.filter((r) => r.status === 'skipped').map((r) => `${String(r.agent)}: ${cleanError(String(r.error ?? 'skipped'))}`);
    return notRun([{ label, error: skipped.length ? `some checks did not run (${skipped.join('; ')})` : 'the review finished incomplete' }]);
  }
  if (!ok) return notRun([{ label, error: cleanError(message) }]);
  if (d?.verdict === 'findings') {
    const n = runs.reduce((sum, r) => sum + (Array.isArray(r.findings) ? r.findings.length : 0), 0);
    return { kind: 'problems', text: `${label} found ${n} finding${n === 1 ? '' : 's'}.` };
  }
  return undefined;
}

function testVerdict(label: string, ok: boolean, message: string, data: unknown): Verdict | undefined {
  const d = obj(data);
  const run = obj(d?.run);
  if (run && run.status !== 'completed') return notRun([{ label, error: cleanError(String(run.error ?? run.status)) }]);
  if (d?.status === 'incomplete') return notRun([{ label, error: cleanError(String(run?.error ?? 'the test run is incomplete')) }]);
  if (!ok && d) return { kind: 'problems', text: `${label} reported problems: ${message.split(/\r?\n/).slice(0, 3).join(' | ')}` };
  return undefined;
}

export function evaluate(spec: RunSpec, outcome: CliOutcome): Verdict {
  const label = commandLabel(spec.command);
  const key = spec.command.join(' ');
  switch (outcome.status) {
    case 'cancelled':
      return { kind: 'cancelled', text: `${label} was cancelled. No result was produced.` };
    case 'unavailable':
      return notRun([{ label, error: outcome.error }]);
    case 'failed':
      return notRun([{ label, error: cleanError(outcome.error) }]);
  }
  const { ok, message, data } = outcome.result;
  const specific = key === 'review' ? reviewVerdict(label, ok, message, data) : key === 'test' ? testVerdict(label, ok, message, data) : undefined;
  if (specific) return specific;

  // Generic: a run record that says failed/timeout is not a pass even if the command itself returned ok.
  const d = obj(data);
  const status = d?.status;
  if (status === 'failed' || status === 'timeout') return notRun([{ label, error: cleanError(String(d?.error ?? message ?? status)) }]);
  if (!ok) {
    if (key === 'selftest') return { kind: 'problems', text: `Self-test did not pass: ${message.split(/\r?\n/)[0]}` };
    return notRun([{ label, error: cleanError(message) }]);
  }
  return { kind: 'ok', text: message.trim() };
}

/** Shorten command output for a notification; the full text goes to the output channel. */
export function summarize(text: string, max = 300): string {
  const flat = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' | ');
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}
