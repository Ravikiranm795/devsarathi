import * as path from 'path';
import { BuildRecord } from '@devsarathi/shared';
import { registerCommand, CommandDef } from '../registry';
import { loadConfig, TOOL_VERSION } from '../lib/config';
import { repoPaths, userHome } from '../lib/paths';
import { readJson } from '../lib/fsutil';
import { branchExists, commitsBehind, currentBranch, headCommit, isGitRepo } from '../lib/git';

export function ageString(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export interface StatusData {
  initialized: boolean;
  toolVersion: string;
  disabled: boolean;
  baselineBranch?: string;
  currentBranch?: string;
  build?: BuildRecord & { ageMs: number };
  behindBaseline: number;
  pendingRules: number;
  newerVersion?: string;
}

/** One-line summary, also used by the Claude Code SessionStart hook. */
export function statusLine(d: StatusData): string {
  if (!d.initialized) return 'DevSarathi: not initialized in this repo (run: devsarathi init)';
  const parts: string[] = [`DevSarathi v${d.toolVersion}`];
  if (d.disabled) parts.push('DISABLED (kill switch on)');
  if (d.build) {
    const label = d.build.baseline ? 'baseline' : `NON-BASELINE build of ${d.build.branch}`;
    parts.push(`graph ${ageString(d.build.ageMs)} old @ ${d.build.commit.slice(0, 7)} (${label})`);
    if (d.build.belowThreshold) parts.push(`coverage ${(d.build.coverage.ratio * 100).toFixed(0)}% below threshold: template rules only`);
  } else {
    parts.push('no graph yet (run: devsarathi graph build)');
  }
  if (d.behindBaseline > 0) parts.push(`your branch is ${d.behindBaseline} commit(s) behind ${d.baselineBranch}`);
  if (d.pendingRules > 0) parts.push(`${d.pendingRules} rule change(s) awaiting approval`);
  if (d.newerVersion) parts.push(`new version ${d.newerVersion} available (npm i -g @ravikiranm795/dev-sarathi@latest)`);
  return parts.join(' | ');
}

export async function collectStatus(root: string): Promise<StatusData> {
  const cfg = loadConfig(root);
  const data: StatusData = {
    initialized: !!cfg,
    toolVersion: TOOL_VERSION,
    disabled: cfg?.disabled ?? false,
    behindBaseline: 0,
    pendingRules: 0
  };
  if (!cfg) return data;
  const p = repoPaths(root);
  data.baselineBranch = cfg.baselineBranch;
  const rec = readJson<BuildRecord>(p.buildRecord);
  if (rec) data.build = { ...rec, ageMs: Date.now() - Date.parse(rec.builtAt) };
  const pending = readJson<unknown[]>(p.pendingRules);
  data.pendingRules = Array.isArray(pending) ? pending.length : 0;
  if (await isGitRepo(root)) {
    data.currentBranch = await currentBranch(root);
    if (data.currentBranch !== cfg.baselineBranch && (await branchExists(root, cfg.baselineBranch))) {
      data.behindBaseline = await commitsBehind(root, cfg.baselineBranch);
    }
    void headCommit; // head is reported by the graph record; kept imported for adapters
  }
  if (cfg.versionCheck) {
    const cache = readJson<{ latest?: string }>(path.join(userHome(), 'version-check.json'));
    if (cache?.latest && cache.latest !== TOOL_VERSION && isNewer(cache.latest, TOOL_VERSION)) data.newerVersion = cache.latest;
  }
  return data;
}

export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

const status: CommandDef = {
  name: 'status',
  description: 'Graph age, baseline commit, branch drift, pending rule changes, kill-switch state, version notice',
  args: [],
  async run(ctx) {
    const data = await collectStatus(ctx.repoRoot);
    return { ok: true, message: statusLine(data), data };
  }
};

registerCommand(status);
