import { Suggestion } from './research';
import { StackSummary } from './summary';

export interface RepoInfo {
  private: boolean;
  archived: boolean;
  stars: number;
  pushedAt: string;
  license?: string;
  defaultBranch: string;
}

export interface RemoteFile {
  path: string; // relative to the skill folder
  size: number;
  url: string;
}

/** Everything verification needs from GitHub. Injectable so tests never touch the network. */
export interface GithubClient {
  repo(owner: string, repo: string): Promise<RepoInfo | null>;
  resolveCommit(owner: string, repo: string, ref: string): Promise<string | null>;
  listFiles(owner: string, repo: string, sha: string, dir: string): Promise<RemoteFile[]>;
  fetchText(url: string): Promise<string>;
}

export interface Thresholds {
  minStars: number;
  maxAgeDays: number;
  maxFiles: number;
  maxFileBytes: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { minStars: 50, maxAgeDays: 365, maxFiles: 25, maxFileBytes: 200 * 1024 };

export interface Risk {
  severity: 'high' | 'medium';
  file: string;
  what: string;
}

export interface Verified {
  suggestion: Suggestion;
  verified: boolean;
  /** Why it is not verified (shown with a warning badge), or what was checked. */
  reasons: string[];
  stars?: number;
  pushedAt?: string;
  license?: string;
  commit?: string;
  dir?: string;
  files: RemoteFile[];
  risks: Risk[];
  match: number;
  score: number;
  preTick: boolean;
}

// ---- source parsing ----------------------------------------------------------------------------------------------

export interface Source {
  owner: string;
  repo: string;
  ref?: string;
  dir: string;
}

export function parseSource(url: string): Source | undefined {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)\/?(.*))?\/?$/.exec(url.trim());
  if (!m) return undefined;
  let dir = (m[4] ?? '').replace(/\/+$/, '');
  if (/SKILL\.md$/i.test(dir)) dir = dir.replace(/\/?SKILL\.md$/i, '');
  return { owner: m[1], repo: m[2], ref: m[3], dir };
}

// ---- risky content scan --------------------------------------------------------------------------------------------

const RISKS: { re: RegExp; severity: Risk['severity']; what: string }[] = [
  { re: /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, severity: 'high', what: 'downloads and runs a script from the network' },
  { re: /\b(Invoke-Expression|iex)\b\s*[(\s]|powershell[^\n]*-enc(odedcommand)?\b/i, severity: 'high', what: 'runs obfuscated or downloaded PowerShell' },
  { re: /\brm\s+-rf?\s+(\/|~|\$HOME|\.\.)/i, severity: 'high', what: 'deletes files outside the project' },
  { re: /base64\s+(-d|--decode)|atob\(/i, severity: 'high', what: 'decodes hidden payloads' },
  { re: /(~|\$HOME|%USERPROFILE%)[/\\]\.(ssh|aws|gnupg|kube)|id_rsa|\.npmrc|\.netrc|\.pypirc|security\s+find-generic-password/i, severity: 'high', what: 'reads credentials or key files' },
  { re: /\bcat\s+\.env\b|\bprintenv\b|\benv\s*\|/i, severity: 'high', what: 'reads environment secrets' },
  { re: /curl[^\n]*(-d|--data|-F|--upload-file)[^\n]*https?:|\bnc\s+(-e|\S+\s+\d+)|\/dev\/tcp\//i, severity: 'high', what: 'sends data to a remote host' },
  { re: /[​-‏‪-‮⁠-⁤﻿]/, severity: 'high', what: 'contains hidden or direction-changing characters' },
  { re: /ignore (all )?(previous|prior) instructions|disregard (the )?(above|system)/i, severity: 'high', what: 'tries to override your instructions' },
  { re: /^allowed-tools:.*\bBash\b(?!\()/im, severity: 'medium', what: 'asks for unrestricted shell access' },
  { re: /\b(sudo|chmod\s+\+x)\b/i, severity: 'medium', what: 'asks for elevated or executable permissions' }
];

export function scanContent(file: string, text: string): Risk[] {
  const out: Risk[] = [];
  for (const r of RISKS) if (r.re.test(text)) out.push({ severity: r.severity, file, what: r.what });
  return out;
}

const SCRIPT_EXT = /\.(sh|bash|ps1|bat|cmd|py|js|mjs|ts|rb|pl)$/i;

// ---- ranking ----------------------------------------------------------------------------------------------------------

export function stackTerms(summary: StackSummary): string[] {
  const t = new Set<string>();
  for (const s of summary.stacks) {
    [s.name, ...s.frameworks, s.testFramework, s.buildTool, s.stateManagement].filter(Boolean).forEach((x) => (x as string).toLowerCase().split(/[^a-z0-9.+#]+/).filter((w) => w.length > 2).forEach((w) => t.add(w)));
  }
  return [...t];
}

export function matchScore(s: Suggestion, summary: StackSummary): number {
  const terms = stackTerms(summary);
  if (terms.length === 0) return 0;
  const hay = `${s.name} ${s.description} ${s.stackTerms.join(' ')}`.toLowerCase();
  const primary = summary.stacks.map((x) => x.name.toLowerCase());
  const hits = terms.filter((w) => hay.includes(w));
  const primaryHit = primary.some((p) => hay.includes(p));
  return Math.min(1, (primaryHit ? 0.5 : 0) + hits.length / Math.max(4, terms.length) / 2 + (hits.length ? 0.1 : 0));
}

/** Stars alone never rank a skill: stack match and recency count too (MASTER 19.6). */
export function rankScore(match: number, stars: number, pushedAt: string | undefined, now = Date.now()): number {
  const starPart = Math.min(1, Math.log10(stars + 1) / 4);
  const ageDays = pushedAt ? (now - Date.parse(pushedAt)) / 86400000 : 999;
  const recency = ageDays <= 90 ? 1 : ageDays >= 365 ? 0 : 1 - (ageDays - 90) / 275;
  return Number((0.4 * match + 0.35 * starPart + 0.25 * recency).toFixed(4));
}

// ---- verification -------------------------------------------------------------------------------------------------------

export async function verifySuggestion(s: Suggestion, summary: StackSummary, gh: GithubClient, th: Thresholds = DEFAULT_THRESHOLDS, now = Date.now()): Promise<Verified> {
  const base: Verified = { suggestion: s, verified: false, reasons: [], files: [], risks: [], match: matchScore(s, summary), score: 0, preTick: false };
  const fail = (...why: string[]): Verified => {
    base.reasons.push(...why);
    base.score = rankScore(base.match, base.stars ?? 0, base.pushedAt, now);
    return base;
  };

  const src = parseSource(s.source);
  if (!src) return fail('the source is not a public GitHub URL, so it cannot be checked');
  let info: RepoInfo | null;
  try {
    info = await gh.repo(src.owner, src.repo);
  } catch (e) {
    return fail(`GitHub could not be reached to check it (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!info) return fail('the repository does not exist or is not public');
  base.stars = info.stars;
  base.pushedAt = info.pushedAt;
  base.license = info.license;
  const problems: string[] = [];
  if (info.private) problems.push('the repository is private');
  if (info.archived) problems.push('the repository is archived');
  if (info.stars < th.minStars) problems.push(`only ${info.stars} stars (minimum ${th.minStars})`);
  const age = (now - Date.parse(info.pushedAt)) / 86400000;
  if (!(age <= th.maxAgeDays)) problems.push(`not updated for ${Math.round(age)} days (maximum ${th.maxAgeDays})`);

  let commit: string | null = null;
  try {
    commit = await gh.resolveCommit(src.owner, src.repo, src.ref ?? info.defaultBranch);
  } catch {
    commit = null;
  }
  if (!commit) problems.push('the version to pin could not be resolved');
  else base.commit = commit;
  base.dir = src.dir;

  // The files, and what is in them
  if (commit) {
    try {
      const files = await gh.listFiles(src.owner, src.repo, commit, src.dir);
      if (!files.some((f) => /^SKILL\.md$/i.test(f.path))) problems.push('no SKILL.md was found in that folder');
      if (files.length > th.maxFiles) problems.push(`it ships ${files.length} files (maximum ${th.maxFiles})`);
      const usable = files.filter((f) => f.size <= th.maxFileBytes).slice(0, th.maxFiles);
      if (usable.length < files.length) problems.push('some files are too large to inspect');
      base.files = usable;
      for (const f of usable) {
        if (SCRIPT_EXT.test(f.path)) base.risks.push({ severity: 'medium', file: f.path, what: 'ships an executable script' });
        let text = '';
        try {
          text = await gh.fetchText(f.url);
        } catch {
          problems.push(`could not read ${f.path} to scan it`);
          continue;
        }
        base.risks.push(...scanContent(f.path, text));
      }
    } catch (e) {
      problems.push(`its files could not be listed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const high = base.risks.filter((r) => r.severity === 'high');
  for (const r of high) problems.push(`${r.file} ${r.what}`);

  if (problems.length) return fail(...problems);
  base.verified = true;
  base.reasons.push(`public repository, ${info.stars} stars, updated ${Math.round(age)} days ago, pinned to ${commit!.slice(0, 7)}, no risky instructions found`);
  base.score = rankScore(base.match, info.stars, info.pushedAt, now);
  base.preTick = base.match >= 0.5;
  return base;
}

/** Verified first, then by score; unverified are never pre-ticked. */
export function orderResults(list: Verified[]): Verified[] {
  return [...list].sort((a, b) => Number(b.verified) - Number(a.verified) || b.score - a.score);
}

// ---- the real GitHub client ----------------------------------------------------------------------------------------------

async function getJson<T>(url: string, timeoutMs = 15000): Promise<{ status: number; body?: T }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'devsarathi-skills-verify' } });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached; try again later');
    return { status: res.status, body: res.ok ? ((await res.json()) as T) : undefined };
  } finally {
    clearTimeout(timer);
  }
}

/** Unauthenticated, public metadata only. No token, no repo data, nothing about the developer's project is sent. */
export const githubClient: GithubClient = {
  async repo(owner, repo) {
    const r = await getJson<{ private: boolean; archived: boolean; stargazers_count: number; pushed_at: string; license?: { spdx_id?: string } | null; default_branch: string }>(`https://api.github.com/repos/${owner}/${repo}`);
    if (!r.body) return null;
    return { private: r.body.private, archived: r.body.archived, stars: r.body.stargazers_count, pushedAt: r.body.pushed_at, license: r.body.license?.spdx_id ?? undefined, defaultBranch: r.body.default_branch };
  },
  async resolveCommit(owner, repo, ref) {
    const r = await getJson<{ sha: string }>(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
    return r.body?.sha ?? null;
  },
  async listFiles(owner, repo, sha, dir) {
    const out: RemoteFile[] = [];
    const walk = async (d: string, depth: number): Promise<void> => {
      const r = await getJson<{ type: string; path: string; size: number; download_url: string | null }[]>(`https://api.github.com/repos/${owner}/${repo}/contents/${d.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`);
      if (!r.body) throw new Error(`folder not found (${r.status})`);
      for (const e of r.body) {
        if (e.type === 'file' && e.download_url) out.push({ path: dir ? e.path.slice(dir.length + 1) : e.path, size: e.size, url: e.download_url });
        else if (e.type === 'dir' && depth < 3) await walk(e.path, depth + 1);
        if (out.length > 60) return;
      }
    };
    await walk(dir, 0);
    return out;
  },
  async fetchText(url) {
    if (!/^https:\/\/raw\.githubusercontent\.com\//.test(url)) throw new Error('refusing to fetch from a non-GitHub host');
    const res = await fetch(url, { headers: { 'user-agent': 'devsarathi-skills-verify' } });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.text();
  }
};
