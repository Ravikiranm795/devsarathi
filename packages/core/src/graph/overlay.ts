import * as fs from 'fs';
import * as path from 'path';
import { writeJson } from '../lib/fsutil';
import { git, currentBranch } from '../lib/git';
import { OWN_DIR } from '../lib/diff';
import { DrishtiClient, resolveBaselineRef } from './drishti';
import { impactOfSymbol, ImpactResult } from './impact';
import { brain } from './brain';
import { requireConfig } from '../lib/config';
import { repoPaths } from '../lib/paths';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The overlay is a READ-ONLY tracker of what differs from the baseline graph: uncommitted work and
 * commits not on the baseline (D-09). It never rebuilds the graph (I-6); impact queries combine both.
 */
export interface OverlayFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  source: 'uncommitted' | 'unpushed' | 'both';
  oldPath?: string;
}

export interface ChangedSymbol {
  path: string;
  name: string;
  kind: string;
  change: 'added' | 'modified' | 'removed';
  /** id in the baseline graph (absent for added symbols). */
  symbolId?: number;
  /** True when the declaration line changed, not just the body: callers are likely to break. */
  signatureChanged?: boolean;
}

export interface OverlayResult {
  generatedAt: string;
  branch: string;
  comparedTo?: string;
  files: OverlayFile[];
  symbols: ChangedSymbol[];
}

type Status = OverlayFile['status'];

/** `git diff --name-status -z` output: STATUS NUL path NUL (renames: STATUS NUL old NUL new NUL). */
export function parseNameStatusZ(out: string): { status: Status; path: string; oldPath?: string }[] {
  const tok = out.split('\0');
  const res: { status: Status; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < tok.length; ) {
    const code = tok[i++];
    if (!code) continue;
    const c = code[0];
    if (c === 'R' || c === 'C') {
      const oldPath = tok[i++];
      const p = tok[i++];
      if (p) res.push({ status: c === 'R' ? 'modified' : 'added', path: p, oldPath: c === 'R' ? oldPath : undefined });
    } else {
      const p = tok[i++];
      if (!p) continue;
      res.push({ status: c === 'A' ? 'added' : c === 'D' ? 'deleted' : 'modified', path: p });
    }
  }
  return res;
}

const collapse = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

async function changedFiles(root: string, baselineRef: string | undefined): Promise<OverlayFile[]> {
  const byPath = new Map<string, OverlayFile>();
  const add = (p: string, status: Status, source: 'uncommitted' | 'unpushed', oldPath?: string) => {
    const prev = byPath.get(p);
    if (prev) {
      prev.source = prev.source === source ? source : 'both';
      // a file added on the branch then deleted locally nets out to deleted; otherwise keep the strongest change
      if (status === 'deleted') prev.status = 'deleted';
    } else byPath.set(p, { path: p, status, source, oldPath });
  };

  const branch = await currentBranch(root);
  let base = baselineRef && baselineRef !== branch ? baselineRef : undefined;
  if (!base) {
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
    if (up.ok && up.stdout.trim()) base = up.stdout.trim();
  }
  if (base) {
    const committed = await git(['diff', '--name-status', '-z', '-M', `${base}...HEAD`], root);
    if (committed.ok) for (const f of parseNameStatusZ(committed.stdout)) add(f.path, f.status, 'unpushed', f.oldPath);
  }
  const work = await git(['diff', '--name-status', '-z', '-M', 'HEAD'], root);
  if (work.ok) for (const f of parseNameStatusZ(work.stdout)) add(f.path, f.status, 'uncommitted', f.oldPath);
  const untracked = await git(['ls-files', '-z', '--others', '--exclude-standard'], root);
  if (untracked.ok) for (const p of untracked.stdout.split('\0').filter(Boolean)) add(p, 'added', 'uncommitted');
  return [...byPath.values()].filter((f) => !OWN_DIR.test(f.path));
}

/** Files changed between two revisions (A..B): what a push would add. */
async function changedFilesInRange(root: string, range: string): Promise<OverlayFile[]> {
  const [a, b] = range.split('..');
  const r = await git(['diff', '--name-status', '-z', '-M', a, b], root);
  return r.ok ? parseNameStatusZ(r.stdout).filter((f) => !OWN_DIR.test(f.path)).map((f) => ({ path: f.path, status: f.status, source: 'unpushed' as const, oldPath: f.oldPath })) : [];
}

export interface OverlayOptions {
  /** Compare a revision range (A..B) instead of the working tree: used by the pre-push review. */
  range?: string;
  /** Write overlay.json (default true for the working-tree overlay). */
  persist?: boolean;
}

export async function computeOverlay(root: string, client = new DrishtiClient(root), opts: OverlayOptions = {}): Promise<OverlayResult> {
  const cfg = requireConfig(root);
  const baselineRef = await resolveBaselineRef(root, cfg.baselineBranch);
  const branch = await currentBranch(root);
  const files = opts.range ? await changedFilesInRange(root, opts.range) : await changedFiles(root, baselineRef);
  const tip = opts.range ? opts.range.split('..')[1] : undefined;
  const { isSecretFile } = brain.secrets();
  const { redactSecrets } = brain.secrets();
  const supported: Set<string> = brain.config().SUPPORTED_EXTENSIONS;
  const parseFile = brain.parseFile();

  const symbols: ChangedSymbol[] = [];
  if (client.hasGraph()) {
    const h = client.open();
    try {
      for (const f of files) {
        const ext = path.extname(f.path);
        if (isSecretFile(f.path) || !supported.has(ext)) continue; // secrets are never read, not even for diffing
        const old = client.symbolsInFile(h.store, f.oldPath ?? f.path);
        const oldByName = new Map<string, typeof old>();
        for (const s of old) oldByName.set(s.name, [...(oldByName.get(s.name) ?? []), s]);

        if (f.status === 'deleted') {
          for (const s of old) symbols.push({ path: f.path, name: s.name, kind: s.kind, change: 'removed', symbolId: s.id });
          continue;
        }
        let source: string;
        try {
          if (tip) {
            const shown = await git(['show', `${tip}:${f.path}`], root);
            if (!shown.ok) continue;
            source = shown.stdout;
          } else source = fs.readFileSync(path.join(root, f.path), 'utf8');
        } catch {
          continue;
        }
        const parsed = parseFile(path.join(root, f.path), ext, source);
        const seen = new Set<number>();
        for (const s of parsed.symbols ?? []) {
          const candidates = (oldByName.get(s.name) ?? []).filter((o) => !seen.has(o.id));
          const match = candidates.find((o) => o.kind === s.kind) ?? candidates[0];
          if (!match) {
            symbols.push({ path: f.path, name: s.name, kind: s.kind, change: 'added' });
            continue;
          }
          seen.add(match.id);
          const body = collapse(redactSecrets(s.body != null ? s.body : s.signature));
          if (body !== collapse(match.body)) {
            const signatureChanged = collapse(redactSecrets(s.signature)) !== collapse(match.signature);
            symbols.push({ path: f.path, name: s.name, kind: s.kind, change: 'modified', symbolId: match.id, signatureChanged });
          }
        }
        for (const o of old) if (!seen.has(o.id)) symbols.push({ path: f.path, name: o.name, kind: o.kind, change: 'removed', symbolId: o.id });
      }
    } finally {
      h.close();
    }
  }

  const result: OverlayResult = {
    generatedAt: new Date().toISOString(),
    branch,
    comparedTo: baselineRef,
    files,
    symbols
  };
  if (opts.persist ?? !opts.range) writeJson(path.join(repoPaths(root).overlay, 'overlay.json'), result);
  return result;
}

export interface OverlayImpact {
  changed: ChangedSymbol;
  impact: ImpactResult;
  /** Callers that live in files this change does NOT touch: the "changed without updating its callers" signal. */
  untouchedCallers: ImpactResult['callers'];
}

/** Impact of every modified or removed symbol, combining the baseline graph with the overlay's changed-file set. */
export function overlayImpact(client: DrishtiClient, overlay: OverlayResult): OverlayImpact[] {
  if (!client.hasGraph()) return [];
  const touched = new Set(overlay.files.map((f) => f.path));
  const out: OverlayImpact[] = [];
  const h = client.open();
  try {
    for (const s of overlay.symbols) {
      if (s.change === 'added' || s.symbolId == null) continue;
      const impact = impactOfSymbol(h.store, s.symbolId);
      if (!impact) continue;
      out.push({ changed: s, impact, untouchedCallers: impact.callers.filter((c) => c.relation === 'caller' && c.path && !touched.has(c.path)) });
    }
  } finally {
    h.close();
  }
  return out;
}
