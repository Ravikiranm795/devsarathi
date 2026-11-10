/*
 * Display-only helpers for the `devsarathi status --json` data. The numbers come from core; nothing is computed here
 * beyond turning them into short text.
 */

export interface StatusView {
  initialized: boolean;
  toolVersion: string;
  disabled: boolean;
  baselineBranch?: string;
  currentBranch?: string;
  build?: {
    branch: string;
    commit: string;
    baseline: boolean;
    builtAt: string;
    ageMs: number;
    belowThreshold: boolean;
    coverageRatio?: number;
    status?: string;
    error?: string;
  };
  behindBaseline: number;
  pendingRules: number;
  newerVersion?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function parseStatus(data: unknown): StatusView | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.initialized !== 'boolean') return undefined;
  const b = d.build && typeof d.build === 'object' ? (d.build as Record<string, unknown>) : undefined;
  const cov = b?.coverage && typeof b.coverage === 'object' ? (b.coverage as Record<string, unknown>) : undefined;
  return {
    initialized: d.initialized,
    toolVersion: str(d.toolVersion) ?? '',
    disabled: d.disabled === true,
    baselineBranch: str(d.baselineBranch),
    currentBranch: str(d.currentBranch),
    build: b
      ? {
          branch: str(b.branch) ?? '?',
          commit: str(b.commit) ?? '',
          baseline: b.baseline === true,
          builtAt: str(b.builtAt) ?? '',
          ageMs: num(b.ageMs),
          belowThreshold: b.belowThreshold === true,
          coverageRatio: cov && typeof cov.ratio === 'number' ? cov.ratio : undefined,
          status: str(b.status),
          error: str(b.error)
        }
      : undefined,
    behindBaseline: num(d.behindBaseline),
    pendingRules: num(d.pendingRules),
    newerVersion: str(d.newerVersion)
  };
}

/** Same rounding as the CLI's status line so the two never disagree. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Age of the graph now: the age core reported plus the time since we asked. */
export function graphAgeNow(s: StatusView, fetchedAt: number, now = Date.now()): number {
  return s.build ? s.build.ageMs + Math.max(0, now - fetchedAt) : 0;
}

export function statusBarText(s: StatusView | undefined, fetchedAt = Date.now(), now = Date.now()): string {
  if (!s) return '$(warning) DevSarathi: unavailable';
  if (!s.initialized) return '$(circle-slash) DevSarathi: not set up';
  if (s.disabled) return '$(debug-pause) DevSarathi: OFF';
  if (!s.build) return '$(sparkle) DevSarathi: no graph';
  if (s.build.status === 'failed') return '$(warning) DevSarathi: graph build failed';
  const age = formatAge(graphAgeNow(s, fetchedAt, now));
  const label = s.build.baseline ? '' : ' (non-baseline)';
  const pending = s.pendingRules > 0 ? ` · ${s.pendingRules} pending` : '';
  return `$(sparkle) DevSarathi: graph ${age}${label}${pending}`;
}

export interface StatusRow {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
}

/** The rows of the sidebar status block. */
export function statusRows(s: StatusView, fetchedAt = Date.now(), now = Date.now()): StatusRow[] {
  const rows: StatusRow[] = [];
  rows.push({ label: 'Kill switch', value: s.disabled ? 'ON: hooks and automatic behavior are off' : 'off: hooks active', tone: s.disabled ? 'bad' : 'ok' });
  if (!s.initialized) return rows;
  if (s.build) {
    const b = s.build;
    if (b.status === 'failed') rows.push({ label: 'Graph', value: `last build failed${b.error ? `: ${b.error}` : ''}`, tone: 'bad' });
    else rows.push({ label: 'Graph age', value: `${formatAge(graphAgeNow(s, fetchedAt, now))} old`, tone: 'ok' });
    rows.push({ label: 'Graph source', value: b.baseline ? `baseline ${b.branch}` : `NON-BASELINE build of ${b.branch}`, tone: b.baseline ? 'ok' : 'warn' });
    if (b.commit) rows.push({ label: 'Baseline commit', value: b.commit.slice(0, 7) });
    if (b.belowThreshold) rows.push({ label: 'Coverage', value: `${b.coverageRatio !== undefined ? Math.round(b.coverageRatio * 100) + '% ' : ''}below threshold: template rules only`, tone: 'warn' });
  } else {
    rows.push({ label: 'Graph', value: 'none yet (run Refresh)', tone: 'warn' });
  }
  if (s.baselineBranch) rows.push({ label: 'Baseline branch', value: s.baselineBranch });
  if (s.currentBranch) rows.push({ label: 'Current branch', value: s.currentBranch });
  rows.push(
    s.behindBaseline > 0
      ? { label: 'Branch drift', value: `${s.behindBaseline} commit(s) behind ${s.baselineBranch ?? 'the baseline'}`, tone: 'warn' }
      : { label: 'Branch drift', value: 'none', tone: 'ok' }
  );
  rows.push({ label: 'Pending approvals', value: String(s.pendingRules), tone: s.pendingRules > 0 ? 'warn' : 'ok' });
  if (s.newerVersion) rows.push({ label: 'New version', value: `${s.newerVersion} available (npm i -g @ravikiranm795/dev-sarathi@latest)`, tone: 'warn' });
  if (s.toolVersion) rows.push({ label: 'Version', value: s.toolVersion });
  return rows;
}

/** Rule-change records from `rules pending --json` (core's RuleChange[]). */
export interface PendingChange {
  id: string;
  file: string;
  op: 'add' | 'change' | 'remove';
  risk: string;
  text: string;
  reason: string;
}

export function parsePending(data: unknown): PendingChange[] {
  if (!Array.isArray(data)) return [];
  const out: PendingChange[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id) continue;
    const op = c.op === 'add' || c.op === 'change' || c.op === 'remove' ? c.op : 'change';
    const line = str(c.newLine) ?? str(c.oldLine) ?? '';
    out.push({
      id: c.id,
      file: str(c.file) ?? '',
      op,
      risk: str(c.risk) ?? 'high',
      text: line.replace(/<!--.*?-->/g, '').trim(),
      reason: str(c.reason) ?? ''
    });
  }
  return out;
}

export const describeOp = (c: PendingChange): string => (c.op === 'add' ? `add to ${c.file}` : c.op === 'remove' ? `remove from ${c.file}` : `change in ${c.file}`);
