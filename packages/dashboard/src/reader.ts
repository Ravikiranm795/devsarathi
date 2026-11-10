import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Pure readers for the dashboard (MASTER 18). They read a FIXED list of files inside `<repo>/.claude/devsarathi/` and
 * nothing else. The client never supplies a path (it sends an opaque repo id), and every field is whitelisted: a
 * missing or corrupt file yields null for that field, never an exception (I-3). Counts, timings and folder names
 * only: no prompt text, no source, no finding detail (I-8, D-16).
 */

const STATE = ['.claude', 'devsarathi'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 400;

export type Health = 'ok' | 'missing' | 'uninitialized';

export interface RepoListItem {
  id: string;
  name: string;
  /** Folder name only: the full path never leaves the machine's process. */
  dir: string;
  stacks: string[];
  baselineBranch: string | null;
  health: Health;
  focus: boolean;
}

export interface RepoEntry {
  id: string;
  name: string;
  path: string;
  stacks: string[];
  baselineBranch: string | null;
  focus: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Short, stable id from the lower-cased absolute path. Opaque to the client. */
export function repoId(repoPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(repoPath).toLowerCase()).digest('hex').slice(0, 12);
}

export function defaultRegistryPath(): string {
  return path.join(process.env.DEVSARATHI_HOME || path.join(os.homedir(), '.devsarathi'), 'registry.json');
}

function readText(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file: string): unknown {
  const t = readText(file);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Registry entries plus the optional focus repo. Never throws. */
export function loadRepoEntries(registryPath: string, focusRepo?: string): RepoEntry[] {
  const raw = readJson(registryPath);
  const list = isObj(raw) && Array.isArray(raw.repos) ? raw.repos : [];
  const out: RepoEntry[] = [];
  const seen = new Set<string>();
  const focusId = focusRepo ? repoId(focusRepo) : null;
  for (const r of list) {
    if (!isObj(r) || typeof r.path !== 'string' || !r.path) continue;
    const id = repoId(r.path);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: str(r.name, 120) || path.basename(r.path),
      path: path.resolve(r.path),
      stacks: Array.isArray(r.stacks) ? r.stacks.filter((s): s is string => typeof s === 'string').slice(0, 10) : [],
      baselineBranch: str(r.baselineBranch, 120),
      focus: id === focusId
    });
  }
  if (focusRepo && focusId && !seen.has(focusId)) {
    // Served as an extra repo even when not registered, so `devsarathi dashboard` works right after init.
    const cfg = readConfig(path.resolve(focusRepo));
    out.unshift({
      id: focusId,
      name: path.basename(path.resolve(focusRepo)),
      path: path.resolve(focusRepo),
      stacks: cfg?.stacks.map((s) => s.id) ?? [],
      baselineBranch: cfg?.baselineBranch ?? null,
      focus: true
    });
  }
  return out;
}

export function healthOf(repoPath: string): Health {
  if (!fs.existsSync(repoPath)) return 'missing';
  return fs.existsSync(path.join(repoPath, ...STATE, 'config.json')) ? 'ok' : 'uninitialized';
}

export function listRepos(registryPath: string, focusRepo?: string): RepoListItem[] {
  return loadRepoEntries(registryPath, focusRepo).map((e) => ({
    id: e.id,
    name: e.name,
    dir: path.basename(e.path),
    stacks: e.stacks,
    baselineBranch: e.baselineBranch,
    health: healthOf(e.path),
    focus: e.focus
  }));
}

// ---------------------------------------------------------------------------------------------------------------------

function readConfig(repo: string) {
  const c = readJson(path.join(repo, ...STATE, 'config.json'));
  if (!isObj(c)) return null;
  const persona = isObj(c.persona) ? { name: str(c.persona.name, 80), title: str(c.persona.title, 80) } : null;
  const stacks = (Array.isArray(c.stacks) ? c.stacks : [])
    .filter(isObj)
    .map((s) => ({ id: str(s.id, 40) ?? '', dir: str(s.dir, 200) ?? '.' }))
    .filter((s) => s.id);
  return {
    persona,
    baselineBranch: str(c.baselineBranch, 120),
    stacks,
    disabled: c.disabled === true,
    initializedAt: str(c.initializedAt, 40),
    coverageThreshold: isObj(c.thresholds) ? num(c.thresholds.coverage) : null
  };
}

function readBuild(repo: string) {
  const b = readJson(path.join(repo, ...STATE, 'graph', 'build-record.json'));
  if (!isObj(b)) return null;
  const cov = isObj(b.coverage) ? b.coverage : {};
  return {
    branch: str(b.branch, 200),
    commit: str(b.commit, 64),
    baseline: bool(b.baseline),
    builtAt: str(b.builtAt, 40),
    durationMs: num(b.durationMs),
    full: bool(b.full),
    status: b.status === 'completed' || b.status === 'failed' ? b.status : null,
    belowThreshold: bool(b.belowThreshold),
    error: str(b.error),
    coverage: {
      eligibleFiles: num(cov.eligibleFiles),
      parsedFiles: num(cov.parsedFiles),
      ratio: num(cov.ratio),
      symbols: num(cov.symbols),
      resolvedCallEdges: num(cov.resolvedCallEdges),
      unresolvedCalls: num(cov.unresolvedCalls)
    }
  };
}

function readGraphSummary(repo: string) {
  const s = readJson(path.join(repo, ...STATE, 'graph', 'summary.json'));
  if (!isObj(s)) return null;
  const languages: Record<string, number> = {};
  if (isObj(s.languages)) for (const [k, v] of Object.entries(s.languages).slice(0, 40)) if (num(v) !== null) languages[k.slice(0, 20)] = v as number;
  return {
    files: num(s.files),
    symbols: num(s.symbols),
    modules: (Array.isArray(s.modules) ? s.modules : [])
      .filter(isObj)
      .slice(0, 40)
      .map((m) => ({ name: str(m.name, 160) ?? '', files: num(m.files) ?? 0, symbols: num(m.symbols) ?? 0 }))
      .filter((m) => m.name),
    languages
  };
}

/** Top-level whitelist: if metrics.json grows a field that could carry text, it is not served until added here. */
const METRIC_KEYS = ['schema', 'generatedAt', 'toolVersion', 'repo', 'since', 'baselineWindow', 'prompts', 'turnsPerTask', 'review', 'graph', 'rules', 'agents', 'usage', 'selftest'];
function readMetrics(repo: string) {
  const m = readJson(path.join(repo, ...STATE, 'metrics', 'metrics.json'));
  if (!isObj(m)) return null;
  const out: Obj = {};
  for (const k of METRIC_KEYS) if (k in m) out[k] = m[k];
  return out;
}

function newestFiles(dir: string, re: RegExp, limit: number): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, limit)
      .map((x) => path.join(dir, x.f));
  } catch {
    return [];
  }
}

const countMap = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

function readReviews(repo: string) {
  const dir = path.join(repo, ...STATE, 'reviews');
  if (!fs.existsSync(dir)) return null;
  const out = [];
  for (const file of newestFiles(dir, /^review-.*\.json$/, 20)) {
    const r = readJson(file);
    if (!isObj(r)) continue;
    const bySeverity: Record<string, number> = {};
    const byAgent: Record<string, number> = {};
    const runs: { agent: string; status: string }[] = [];
    let redFlags = 0;
    for (const run of Array.isArray(r.runs) ? r.runs : []) {
      if (!isObj(run)) continue;
      const agent = str(run.agent, 40) ?? 'unknown';
      runs.push({ agent, status: str(run.status, 20) ?? 'unknown' });
      // Only counts leave this function: titles, files, detail and suggestions are never copied.
      for (const f of Array.isArray(run.findings) ? run.findings : []) {
        if (!isObj(f)) continue;
        countMap(bySeverity, str(f.severity, 20) ?? 'unknown');
        countMap(byAgent, agent);
        if (f.redFlag === true) redFlags++;
      }
    }
    out.push({
      runId: str(r.runId, 80),
      createdAt: str(r.createdAt, 40),
      branch: str(r.branch, 200),
      range: str(r.range, 200),
      verdict: r.verdict === 'clean' || r.verdict === 'findings' || r.verdict === 'incomplete' ? r.verdict : null,
      findingsBySeverity: bySeverity,
      findingsByAgent: byAgent,
      redFlags,
      runs
    });
  }
  out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return out.length ? out : null;
}

function readAudit(repo: string) {
  const dir = path.join(repo, ...STATE, 'reviews');
  const files = newestFiles(dir, /^audit-.*\.json$/, 1);
  if (!files.length) return null;
  const a = readJson(files[0]);
  if (!isObj(a)) return null;
  const bySeverity: Record<string, number> = {};
  for (const f of Array.isArray(a.findings) ? a.findings : []) if (isObj(f)) countMap(bySeverity, str(f.severity, 20) ?? 'unknown');
  const checked = isObj(a.checked) ? a.checked : {};
  let at: string | null = null;
  try {
    at = fs.statSync(files[0]).mtime.toISOString();
  } catch {
    /* keep null */
  }
  return {
    at,
    status: a.status === 'pass' || a.status === 'fix' ? a.status : null,
    findings: Array.isArray(a.findings) ? a.findings.length : 0,
    bySeverity,
    checked: { files: num(checked.files), rules: num(checked.rules) }
  };
}

const CHANGE_RE = /^- (\S+) (\S+) \((\w+) risk\) (\S+) in (.+?): (.*)$/;
function readChangelog(repo: string) {
  const t = readText(path.join(repo, ...STATE, 'changelog.md'));
  if (t === null) return null;
  const entries = [];
  // Continuation lines ("  + new rule text") are rule bodies: skipped, only the header line is served.
  for (const line of t.split(/\r?\n/)) {
    const m = CHANGE_RE.exec(line);
    if (m) entries.push({ at: m[1], how: m[2], risk: m[3], op: m[4], file: m[5].slice(0, 200), reason: m[6].slice(0, MAX_TEXT) });
  }
  return { total: entries.length, entries: entries.slice(-50).reverse() };
}

function readPending(repo: string): number | null {
  const p = readJson(path.join(repo, ...STATE, 'pending-rules.json'));
  return Array.isArray(p) ? p.length : null;
}

function readNotices(repo: string) {
  const t = readText(path.join(repo, ...STATE, 'notices.jsonl'));
  if (t === null) return null;
  const out = [];
  for (const line of t.split(/\r?\n/).filter(Boolean).slice(-20)) {
    try {
      const n = JSON.parse(line) as unknown;
      if (isObj(n)) out.push({ at: str(n.at, 40), source: str(n.source, 60), message: str(n.message) });
    } catch {
      /* one bad line never hides the rest */
    }
  }
  return out.reverse();
}

function readFailure(repo: string) {
  const f = readJson(path.join(repo, ...STATE, 'last-build-failure.json'));
  if (!isObj(f)) return null;
  return { at: str(f.at, 40), branch: str(f.branch, 200), commit: str(f.commit, 64), error: str(f.error) };
}

/** Replace the repo's absolute path in any served string, so nothing reveals where it lives on disk. */
function scrub<T>(value: T, repo: string): T {
  const variants = [repo, repo.replace(/\\/g, '/')].filter(Boolean);
  const re = new RegExp(variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(re, '<repo>');
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function readRepoSummary(repoPath: string, meta?: { id?: string; name?: string }) {
  const repo = path.resolve(repoPath);
  const health = healthOf(repo);
  const summary = {
    id: meta?.id ?? repoId(repo),
    name: meta?.name ?? path.basename(repo),
    dir: path.basename(repo),
    health,
    config: readConfig(repo),
    build: readBuild(repo),
    graph: readGraphSummary(repo),
    metrics: readMetrics(repo),
    reviews: readReviews(repo),
    audit: readAudit(repo),
    changelog: readChangelog(repo),
    pendingRules: readPending(repo),
    notices: readNotices(repo),
    lastBuildFailure: readFailure(repo)
  };
  return scrub(summary, repo);
}

export type RepoSummary = ReturnType<typeof readRepoSummary>;
