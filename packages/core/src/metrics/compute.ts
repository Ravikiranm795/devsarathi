import * as path from 'path';
import { loadConfig, TOOL_VERSION } from '../lib/config';
import { repoPaths } from '../lib/paths';
import { writeJson, readJson } from '../lib/fsutil';
import { readEvents } from '../lib/events';

type Ev = ReturnType<typeof readEvents>[number];

/**
 * metrics.json is the single source of truth (D-18). The markdown and Word reports and the dashboard are all
 * generated from it, so they can never disagree. It holds counts, timings and hashes only: no prompt text, no
 * code, no secret values (I-8, MASTER 16).
 */
export interface Metrics {
  schema: 1;
  generatedAt: string;
  toolVersion: string;
  repo: string;
  since: string | null;
  baselineWindow: { startsAt: string | null; endsAt: string | null; days: number };
  prompts: { enhanced: number; needsConfirmation: number; accepted: number; edited: number; rejected: number; acceptanceRate: number | null };
  turnsPerTask: {
    tasks: number;
    definition: string;
    baseline: { tasks: number; avgTurns: number | null };
    withEnhancer: { tasks: number; avgTurns: number | null };
    other: { tasks: number; avgTurns: number | null };
    improvement: number | null; // fraction fewer turns with the enhancer than at baseline; null until both have data
    note: string;
    history: { at: string; turns: number; phase: 'baseline' | 'enhancer' | 'other' }[];
  };
  review: {
    runs: number;
    byVerdict: Record<string, number>;
    findingsBySeverity: Record<string, number>;
    findingsByAgent: Record<string, number>;
    findingsActedOn: number;
    findingsActedOnByAgent: Record<string, number>;
    redFlagsAtPush: number;
    redFlagsTotal: number;
    pushReviews: number;
  };
  graph: {
    builds: number;
    failures: number;
    avgDurationMs: number | null;
    lastCoverage: number | null;
    belowThreshold: number;
    history: { at: string; durationMs: number; coverage: number | null; baseline: boolean | null; full: boolean | null; status: string }[];
  };
  rules: { autoApplied: number; approved: number; rejected: number };
  agents: Record<string, { completed: number; failed: number; timeout: number; skipped: number }>;
  usage: { commands: Record<string, number>; activeDays: number; days: string[]; daily: { date: string; commands: number; prompts: number }[] };
  selftest: { runs: { at: string; passed: number; total: number; failed: string[] }[]; lastPassed: boolean | null };
}

const IDLE_MS = 30 * 60 * 1000;
const AUTOMATIC = new Set(['session-start', 'refresh-triggered', 'task-end', 'graph-build']);
const day = (t: string) => t.slice(0, 10);
const avg = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null);
const n = (v: unknown) => (typeof v === 'number' ? v : 0);

interface Task {
  start: string;
  end: string;
  turns: number;
  enhancer: boolean;
}

/**
 * Q-02: a task opens on the first prompt after the previous task ended (or after 30 minutes idle) and closes on the
 * next agent-stop. A turn is one prompt inside the window. Counts only: the prompt text is never read.
 */
export function tasksFromEvents(events: Ev[]): Task[] {
  const tasks: Task[] = [];
  let cur: Task | undefined;
  let lastAt = 0;
  const flush = (end: string) => {
    if (cur && cur.turns > 0) tasks.push({ ...cur, end });
    cur = undefined;
  };
  for (const e of events) {
    const at = Date.parse(e.t);
    if (e.type === 'prompt') {
      if (cur && at - lastAt > IDLE_MS) flush(new Date(lastAt).toISOString());
      if (!cur) cur = { start: e.t, end: e.t, turns: 0, enhancer: false };
      cur.turns++;
      lastAt = at;
    } else if (e.type === 'enhance' && e.data?.status === 'ready') {
      if (cur) cur.enhancer = true;
      else cur = { start: e.t, end: e.t, turns: 0, enhancer: true };
      lastAt = at;
    } else if (e.type === 'task-end') {
      flush(e.t);
    }
  }
  if (cur && cur.turns > 0) tasks.push({ ...cur, end: new Date(lastAt).toISOString() });
  return tasks;
}

export function computeMetricsFrom(events: Ev[], opts: { repo: string; initializedAt?: string; now?: Date; buildHistory?: Metrics['graph']['history'] }): Metrics {
  const now = opts.now ?? new Date();
  const since = events.length ? events[0].t : null;
  const start = opts.initializedAt ?? since;
  const baselineDays = 7;
  const endsAt = start ? new Date(Date.parse(start) + baselineDays * 86400000).toISOString() : null;

  // prompts ---------------------------------------------------------------------------------------------------------
  const outcome = (o: string) => events.filter((e) => e.type === 'enhance-outcome' && e.data?.outcome === o).length;
  const accepted = outcome('accepted');
  const edited = outcome('edited');
  const rejected = outcome('rejected');
  const decided = accepted + edited + rejected;
  const prompts: Metrics['prompts'] = {
    enhanced: events.filter((e) => e.type === 'enhance' && e.data?.status === 'ready').length,
    needsConfirmation: events.filter((e) => e.type === 'enhance' && e.data?.status === 'needs-confirmation').length,
    accepted,
    edited,
    rejected,
    acceptanceRate: decided ? Number((accepted / decided).toFixed(3)) : null
  };

  // turns per task ----------------------------------------------------------------------------------------------------
  const tasks = tasksFromEvents(events);
  const phaseOf = (t: Task): 'baseline' | 'enhancer' | 'other' =>
    t.enhancer ? 'enhancer' : endsAt && Date.parse(t.start) <= Date.parse(endsAt) ? 'baseline' : 'other';
  const phases = tasks.map((t) => ({ t, phase: phaseOf(t) }));
  const turnsOf = (p: 'baseline' | 'enhancer' | 'other') => phases.filter((x) => x.phase === p).map((x) => x.t.turns);
  const baseAvg = avg(turnsOf('baseline'));
  const enhAvg = avg(turnsOf('enhancer'));
  const turnsPerTask: Metrics['turnsPerTask'] = {
    tasks: tasks.length,
    definition: 'A task opens at the first prompt after the previous task ended (or after 30 minutes idle) and closes at the next agent stop. A turn is one prompt in that window. Only counts are stored.',
    baseline: { tasks: turnsOf('baseline').length, avgTurns: baseAvg },
    withEnhancer: { tasks: turnsOf('enhancer').length, avgTurns: enhAvg },
    other: { tasks: turnsOf('other').length, avgTurns: avg(turnsOf('other')) },
    improvement: baseAvg && enhAvg != null ? Number(((baseAvg - enhAvg) / baseAvg).toFixed(3)) : null,
    note: 'Compare turns per task BEFORE (first 7 days, enhancer optional) with tasks that used the enhancer. Acceptance rate is shown beside it because acceptance alone can be inflated.',
    history: phases.map((x) => ({ at: x.t.start, turns: x.t.turns, phase: x.phase }))
  };

  // review --------------------------------------------------------------------------------------------------------------
  const reviews = events.filter((e) => e.type === 'review');
  const sumKey = (k: string) => reviews.reduce((s, e) => s + n(e.data?.[k]), 0);
  const AGENTS = ['security', 'impact', 'tester', 'peer-review', 'spec'];
  const byVerdict: Record<string, number> = {};
  for (const r of reviews) byVerdict[String(r.data?.verdict ?? 'unknown')] = (byVerdict[String(r.data?.verdict ?? 'unknown')] ?? 0) + 1;
  const review: Metrics['review'] = {
    runs: reviews.length,
    byVerdict,
    findingsBySeverity: Object.fromEntries(['critical', 'high', 'medium', 'low'].map((s) => [s, sumKey(s)])),
    findingsByAgent: Object.fromEntries(AGENTS.map((a) => [a, sumKey(`findings_${a}`)])),
    findingsActedOn: sumKey('resolved'),
    findingsActedOnByAgent: Object.fromEntries(AGENTS.map((a) => [a, sumKey(`resolved_${a}`)])),
    redFlagsAtPush: reviews.filter((e) => e.data?.trigger === 'pre-push').reduce((s, e) => s + n(e.data?.redFlags), 0),
    redFlagsTotal: sumKey('redFlags'),
    pushReviews: reviews.filter((e) => e.data?.trigger === 'pre-push').length
  };

  // graph ------------------------------------------------------------------------------------------------------------------
  const builds = events.filter((e) => e.type === 'graph-build');
  const done = builds.filter((e) => e.data?.status === 'completed');
  const graph: Metrics['graph'] = {
    builds: builds.length,
    failures: builds.filter((e) => e.data?.status === 'failed').length,
    avgDurationMs: done.length ? Math.round(done.reduce((s, e) => s + n(e.data?.durationMs), 0) / done.length) : null,
    lastCoverage: done.length ? (done[done.length - 1].data?.coverage as number) ?? null : null,
    belowThreshold: done.filter((e) => e.data?.belowThreshold === true).length,
    history: builds.map((e) => ({ at: e.t, durationMs: n(e.data?.durationMs), coverage: typeof e.data?.coverage === 'number' ? e.data.coverage : null, baseline: typeof e.data?.baseline === 'boolean' ? e.data.baseline : null, full: typeof e.data?.full === 'boolean' ? e.data.full : null, status: String(e.data?.status) }))
  };

  // rules ---------------------------------------------------------------------------------------------------------------------
  const rc = (how: string) => events.filter((e) => e.type === 'rule-change' && e.data?.how === how).length;
  const rules = { autoApplied: rc('auto-applied'), approved: rc('approved'), rejected: rc('rejected') };

  // agent runs ------------------------------------------------------------------------------------------------------------------
  const agents: Metrics['agents'] = {};
  const bump = (agent: string, status: string) => {
    const a = (agents[agent] ??= { completed: 0, failed: 0, timeout: 0, skipped: 0 });
    if (status in a) a[status as 'completed']++;
  };
  for (const r of reviews) for (const a of AGENTS) if (r.data?.[`run_${a}`] !== undefined) bump(a, String(r.data[`run_${a}`]));
  for (const t of events.filter((e) => e.type === 'tester-run')) bump('tester-run', String(t.data?.run));

  // usage -------------------------------------------------------------------------------------------------------------------------
  const commands: Record<string, number> = {};
  for (const e of events.filter((x) => x.type === 'command')) {
    const name = String(e.data?.name);
    commands[name] = (commands[name] ?? 0) + 1;
  }
  const manual = events.filter((e) => !AUTOMATIC.has(e.type));
  const daysSet = new Set(manual.map((e) => day(e.t)));
  const dailyMap = new Map<string, { commands: number; prompts: number }>();
  for (const e of manual) {
    const d = dailyMap.get(day(e.t)) ?? { commands: 0, prompts: 0 };
    if (e.type === 'command') d.commands++;
    if (e.type === 'prompt') d.prompts++;
    dailyMap.set(day(e.t), d);
  }
  const usage: Metrics['usage'] = {
    commands,
    activeDays: daysSet.size,
    days: [...daysSet].sort(),
    daily: [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }))
  };

  // selftest ------------------------------------------------------------------------------------------------------------------------
  const st = events.filter((e) => e.type === 'selftest').map((e) => ({ at: e.t, passed: n(e.data?.passed), total: n(e.data?.total), failed: String(e.data?.failed ?? '').split(',').filter(Boolean) }));
  const selftest: Metrics['selftest'] = { runs: st, lastPassed: st.length ? st[st.length - 1].passed === st[st.length - 1].total : null };

  return {
    schema: 1,
    generatedAt: now.toISOString(),
    toolVersion: TOOL_VERSION,
    repo: opts.repo,
    since,
    baselineWindow: { startsAt: start ?? null, endsAt, days: baselineDays },
    prompts,
    turnsPerTask,
    review,
    graph,
    rules,
    agents,
    usage,
    selftest
  };
}

export function metricsPath(root: string): string {
  return repoPaths(root).metricsJson;
}

/** Recompute metrics.json from the local event log. Deterministic: the same events give the same file. */
export function computeMetrics(root: string, now = new Date()): Metrics {
  const cfg = loadConfig(root);
  const m = computeMetricsFrom(readEvents(root), { repo: path.basename(root), initializedAt: cfg?.initializedAt, now });
  writeJson(metricsPath(root), m);
  return m;
}

export function readMetrics(root: string): Metrics | undefined {
  return readJson<Metrics>(metricsPath(root));
}
