import * as fs from 'fs';
import * as path from 'path';
import { BuildRecord, BuildRecordSchema, GRAPH_FORMAT_VERSION } from '@devsarathi/shared';
import { repoPaths, modelsDir } from '../lib/paths';
import { requireConfig } from '../lib/config';
import { ensureDir, readJson, writeJson, exists } from '../lib/fsutil';
import { branchExists, currentBranch, git, headCommit, withWorktree } from '../lib/git';
import { writeNotice } from '../lib/failopen';
import { recordEvent } from '../lib/events';
import { brain } from './brain';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type BuildMode = 'baseline' | 'current';

export interface BuildOptions {
  /** Rebuild from scratch instead of incrementally (`graph build --full`). */
  full?: boolean;
  /** baseline (default): the configured baseline branch. current: whatever is checked out, labeled as such. */
  mode?: BuildMode;
  onProgress?: (stage: string, message?: string) => void;
}

export interface BuildOutcome {
  record: BuildRecord;
  notes: string[];
}

/** Never leave a failed build looking like a graph: the previous one stays in use (D-10, MASTER 7.4). */
const FAILURE_FILE = 'last-build-failure.json';

function hasModel(): boolean {
  return exists(path.join(modelsDir(), 'Xenova', 'all-MiniLM-L6-v2', 'onnx'));
}

/** Env wiring: where the embedding model lives and whether to use the deterministic test embedder. */
export function configureEmbedder(): void {
  if (!process.env.BRAIN_MODEL_DIR) process.env.BRAIN_MODEL_DIR = modelsDir();
  if (process.env.DEVSARATHI_EMBEDDER === 'fake') process.env.BRAIN_EMBEDDER = 'fake';
  if (process.env.DEVSARATHI_OFFLINE === '1') process.env.BRAIN_OFFLINE = '1';
}

export async function resolveBaselineRef(root: string, baselineBranch: string): Promise<string | undefined> {
  if (await branchExists(root, baselineBranch)) return baselineBranch;
  const remote = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baselineBranch}`], root);
  if (remote.ok) return `origin/${baselineBranch}`;
  return undefined;
}

async function trackedTreeClean(root: string): Promise<boolean> {
  const r = await git(['status', '--porcelain', '--untracked-files=no'], root);
  return r.ok && r.stdout.trim() === '';
}

function copyDir(src: string, dst: string): void {
  ensureDir(dst);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile() && !/\.(lock|queued)$/.test(e.name)) fs.copyFileSync(s, d);
  }
}

async function swapDirs(live: string, staged: string): Promise<void> {
  const old = `${live}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  // Windows can hold a just-closed sqlite file for a moment; retry briefly before giving up.
  const attempt = async <T>(fn: () => T): Promise<T> => {
    let last: unknown;
    for (let i = 0; i < 10; i++) {
      try {
        return fn();
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
    throw last;
  };
  if (exists(live)) await attempt(() => fs.renameSync(live, old));
  await attempt(() => fs.renameSync(staged, live));
  fs.rmSync(old, { recursive: true, force: true });
}

export class DrishtiClient {
  readonly paths;

  constructor(readonly root: string) {
    this.paths = repoPaths(root);
    configureEmbedder();
    // Queries made against the real repo root read the graph kept inside .claude/devsarathi/graph.
    brain.config().registerBrainDirOverride(this.root, this.paths.graph);
  }

  lastBuild(): BuildRecord | undefined {
    const raw = readJson<unknown>(this.paths.buildRecord);
    const parsed = BuildRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  hasGraph(): boolean {
    return exists(path.join(this.paths.graph, 'graph.sqlite')) && !!this.lastBuild();
  }

  /**
   * Builds (or incrementally refreshes) the graph. The build runs against a staging copy and replaces the live
   * graph only on success, so a crash or a failed parse never corrupts the graph the developer is using.
   */
  async build(opts: BuildOptions = {}): Promise<BuildOutcome> {
    const progress = opts.onProgress ?? (() => undefined);
    const cfg = requireConfig(this.root);
    const notes: string[] = [];
    const started = Date.now();
    const branch = await currentBranch(this.root);

    const baselineRef = await resolveBaselineRef(this.root, cfg.baselineBranch);
    const clean = await trackedTreeClean(this.root);
    const onBaseline = branch === cfg.baselineBranch;
    const mode: BuildMode = opts.mode ?? 'baseline';

    // Where the files come from, and whether the result may be labeled "baseline".
    let useWorktreeRef: string | undefined;
    let isBaseline: boolean;
    if (mode === 'baseline') {
      if (!baselineRef) {
        notes.push(`Baseline branch "${cfg.baselineBranch}" was not found locally or on origin. Built the current branch instead and labeled it non-baseline.`);
        isBaseline = false;
      } else if (onBaseline && clean) {
        isBaseline = true;
      } else {
        useWorktreeRef = baselineRef;
        isBaseline = true;
      }
    } else {
      isBaseline = onBaseline && clean;
    }

    const sourceCommit = useWorktreeRef ? await headCommit(this.root, useWorktreeRef) : await headCommit(this.root);
    const sourceBranch = useWorktreeRef ? cfg.baselineBranch : branch;

    const live = this.paths.graph;
    const staged = `${live}.next`;
    fs.rmSync(staged, { recursive: true, force: true });
    const full = !!opts.full || !this.hasGraph();
    if (!full && exists(live)) copyDir(live, staged);
    else ensureDir(staged);

    if (!hasModel() && process.env.BRAIN_EMBEDDER !== 'fake') {
      progress('Scanning', 'The embedding model (~90 MB) is downloaded once and cached; no repo data is sent.');
    }

    const buildBrain = brain.buildBrain();
    const repoIdOf = brain.config().getRepoId(this.root);
    const run = async (srcRoot: string) =>
      buildBrain(srcRoot, {
        storeDir: staged,
        repoId: repoIdOf,
        force: full,
        instructions: false,
        viz: false,
        onProgress: (m: string) => progress('Building graph', m)
      });

    let result: any;
    try {
      progress('Scanning', useWorktreeRef ? `Reading ${useWorktreeRef} in a temporary worktree (your branch is not switched).` : 'Reading the working tree.');
      result = useWorktreeRef ? await withWorktree(this.root, useWorktreeRef, run) : await run(this.root);
    } catch (err) {
      fs.rmSync(staged, { recursive: true, force: true });
      const message = err instanceof Error ? err.message : String(err);
      writeJson(path.join(this.paths.state, FAILURE_FILE), { at: new Date().toISOString(), branch: sourceBranch, commit: sourceCommit, error: message });
      writeNotice(this.root, 'graph-build', `Graph build failed: ${message}. The previous graph is still in use. Re-run: devsarathi graph build`);
      recordEvent(this.root, { type: 'graph-build', data: { status: 'failed', durationMs: Date.now() - started, full } });
      throw new Error(`graph build failed: ${message}`);
    }

    await swapDirs(live, staged);
    brain.config().registerBrainDirOverride(this.root, live);
    fs.rmSync(path.join(this.paths.state, FAILURE_FILE), { force: true });

    const cov = result.coverage;
    const record: BuildRecord = BuildRecordSchema.parse({
      graphFormat: GRAPH_FORMAT_VERSION,
      branch: sourceBranch,
      commit: sourceCommit,
      baseline: isBaseline,
      builtAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      full,
      coverage: {
        eligibleFiles: cov.eligibleFiles,
        parsedFiles: cov.parsedFiles,
        ratio: cov.ratio,
        symbols: cov.symbols,
        resolvedCallEdges: cov.resolvedCallEdges,
        unresolvedCalls: cov.unresolvedCalls
      },
      belowThreshold: cov.ratio < cfg.thresholds.coverage,
      status: 'completed'
    });
    writeJson(this.paths.buildRecord, record);
    this.writeSummary();
    recordEvent(this.root, { type: 'graph-build', data: { status: 'completed', durationMs: record.durationMs, full: record.full, baseline: record.baseline, coverage: Number(record.coverage.ratio.toFixed(3)), symbols: record.coverage.symbols, belowThreshold: record.belowThreshold } });

    if (record.belowThreshold) {
      notes.push(
        `Coverage is ${(cov.ratio * 100).toFixed(0)}% (threshold ${(cfg.thresholds.coverage * 100).toFixed(0)}%). Only the template rule layer will be generated. Rebuild with: devsarathi graph build --full`
      );
    }
    if (!isBaseline) notes.push(`This graph was built from "${sourceBranch}", not the baseline branch, and is labeled non-baseline.`);
    return { record, notes };
  }

  /** Opens the live graph read-only-ish; callers MUST close the store. */
  open(): { store: any; vectorIndex: any; close(): void } {
    if (!this.hasGraph()) throw new Error('No graph yet. Run: devsarathi graph build');
    const store = new (brain.GraphStore())(this.paths.graph);
    let vectorIndex: any;
    try {
      vectorIndex = new (brain.VectorIndex())(this.paths.graph);
    } catch {
      vectorIndex = undefined;
    }
    return { store, vectorIndex, close: () => store.close() };
  }

  async search(queryText: string, k = 10, filters: Record<string, unknown> = {}): Promise<any[]> {
    const h = this.open();
    try {
      return await brain.query().search(this.root, queryText, k, filters, { store: h.store, vectorIndex: h.vectorIndex });
    } finally {
      h.close();
    }
  }

  /** graph/summary.json: what the dashboard shows per repo (modules, files, symbols, languages). Counts and folder names only. */
  writeSummary(): void {
    try {
      const h = this.open();
      try {
        const files = h.store.db.prepare('SELECT f.path AS path, f.ext AS ext, COUNT(s.id) AS symbols FROM files f LEFT JOIN symbols s ON s.file_id = f.id GROUP BY f.id').all() as { path: string; ext: string | null; symbols: number }[];
        const modules = new Map<string, { files: number; symbols: number }>();
        const languages: Record<string, number> = {};
        for (const f of files) {
          const parts = f.path.split('/');
          const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : '(root)';
          const m = modules.get(key) ?? { files: 0, symbols: 0 };
          m.files++;
          m.symbols += f.symbols;
          modules.set(key, m);
          const ext = f.ext || '(none)';
          languages[ext] = (languages[ext] ?? 0) + 1;
        }
        writeJson(path.join(this.paths.graph, 'summary.json'), {
          files: files.length,
          symbols: files.reduce((n, f) => n + f.symbols, 0),
          modules: [...modules.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.symbols - a.symbols).slice(0, 40),
          languages
        });
      } finally {
        h.close();
      }
    } catch {
      /* the summary is derived data: never fail a build over it */
    }
  }

  /** Secret files seen at the last build: path only, never content (I-8). */
  secretFiles(): string[] {
    const m = readJson<{ secretFiles?: string[] }>(path.join(this.paths.graph, 'manifest.json'));
    return m?.secretFiles ?? [];
  }

  /** Graph symbols recorded for one file, with their stored (already redacted) bodies. */
  symbolsInFile(store: any, relPath: string): { id: number; name: string; kind: string; start: number; end: number; signature: string | null; body: string | null }[] {
    const rows = store.db
      .prepare(
        `SELECT s.id, s.name, s.kind, s.start_line AS start, s.end_line AS end, s.signature AS signature, c.code AS body
         FROM symbols s JOIN files f ON f.id = s.file_id LEFT JOIN chunks c ON c.symbol_id = s.id
         WHERE f.path = ? ORDER BY s.start_line`
      )
      .all(relPath);
    return rows;
  }
}
