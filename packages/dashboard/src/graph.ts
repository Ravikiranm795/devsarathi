import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import type { RepoEntry } from './reader';

/**
 * The 3D graph page (`/graph/`). It reuses the brain's city viewer (brain/src/viewer) and its snapshot format instead of
 * drawing a second one, so `brain view` and the dashboard always show the same model. Everything here is read-only:
 * the repo's graph.sqlite is opened read-only, the client names a repo only by the opaque id from /api/repos, and the
 * answers are the viewer's own files plus one snapshot per repo. Same-origin only, so the dashboard's offline rule holds.
 */

const STATE = ['.claude', 'devsarathi'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// Resolves from src/ and dist/ in a checkout and in the published package: packages/dashboard/{src,dist} -> brain/src.
const BRAIN_SRC = path.resolve(__dirname, '..', '..', '..', 'brain', 'src');
const VIEWER = path.join(BRAIN_SRC, 'viewer');

/** The viewer draws on a canvas and builds a little markup with style attributes; no remote fonts, scripts or images. */
export const GRAPH_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' vscode-webview:";

export interface GraphReply {
  status: number;
  type: string;
  body: string | Buffer;
  /** Set for the pages of the 3D view, which need a slightly wider policy than the rest of the dashboard. */
  csp?: string;
}

const JS = 'text/javascript; charset=utf-8';
const FILES: Record<string, { file: () => string; type: string }> = {
  'app.js': { file: () => path.join(VIEWER, 'app.js'), type: JS },
  'core.js': { file: () => path.join(VIEWER, 'core.js'), type: JS },
  'app.css': { file: () => path.join(VIEWER, 'app.css'), type: 'text/css; charset=utf-8' },
  'vendor/three.min.js': { file: threeBuild, type: JS }
};

function threeBuild(): string {
  const req = createRequire(path.join(BRAIN_SRC, 'viewer.js'));
  return path.join(path.dirname(req.resolve('three')), 'three.min.js');
}

const notFound = (): GraphReply => ({ status: 404, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: 'Not found' }) });

interface BuildInfo {
  builtAt: string;
  symbols: number;
  edges: number;
  files: number;
}

function readJson(file: string): unknown {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const dbOf = (repo: string) => path.join(repo, ...STATE, 'graph', 'graph.sqlite');

/** What the graph's build record says, or null when there is no finished graph to draw. */
function buildOf(repo: string): BuildInfo | null {
  if (!fs.existsSync(dbOf(repo))) return null;
  const b = readJson(path.join(repo, ...STATE, 'graph', 'build-record.json')) as Record<string, unknown> | null;
  if (!b || b.status !== 'completed' || typeof b.builtAt !== 'string') return null;
  const cov = (b.coverage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { builtAt: b.builtAt, symbols: n(cov.symbols), edges: n(cov.resolvedCallEdges), files: n(cov.parsedFiles) };
}

/** `2026-11-05T07:41:44.482Z` -> `20261105T074144Z`, the viewer's version id (same rule as brain/src/vizData.js). */
const versionIdFor = (builtAt: string) => new Date(builtAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

interface Cached {
  key: string;
  text: string;
}
// One snapshot per repo: a new build replaces it, so the cache never grows past the number of repos.
const cache = new Map<string, Cached>();

function snapshotText(entry: RepoEntry, info: BuildInfo, versionId: string): string {
  const key = `${info.builtAt}|${fs.statSync(dbOf(entry.path)).mtimeMs}`;
  const hit = cache.get(entry.id);
  if (hit && hit.key === key) return hit.text;
  const req = createRequire(path.join(BRAIN_SRC, 'graphStore.js'));
  const Database = req('better-sqlite3') as new (file: string, opts: { readonly: boolean; fileMustExist: boolean }) => { close(): void };
  const { exportSnapshot } = req('./vizData') as { exportSnapshot(store: unknown, meta: Record<string, unknown>): unknown };
  const db = new Database(dbOf(entry.path), { readonly: true, fileMustExist: true });
  try {
    // rootDir stays null: an absolute path never goes to the browser.
    const snap = exportSnapshot({ db }, { repoId: entry.id, rootDir: null, builtAt: info.builtAt, versionId });
    // The viewer asks for the repo by id, and shows the registry's name rather than a folder-derived one.
    (snap as { name: string }).name = entry.name;
    const text = `BRAIN_VIZ.register(${JSON.stringify(snap)});\n`;
    cache.set(entry.id, { key, text });
    return text;
  } finally {
    db.close();
  }
}

function indexScript(entries: RepoEntry[], token: string): string {
  const repos = entries.map((e) => {
    const info = buildOf(e.path);
    return {
      repoId: e.id,
      name: e.name,
      rootDir: null,
      empty: !info,
      versions: info ? [{ id: versionIdFor(info.builtAt), builtAt: info.builtAt, counts: { files: info.files, symbols: info.symbols, edges: info.edges } }] : []
    };
  });
  // Tags the viewer adds later (the snapshot <script>) cannot send a header, so they carry the session token in the URL.
  const suffix = `?token=${encodeURIComponent(token)}`;
  return `window.BRAIN_VIZ_SUFFIX = ${JSON.stringify(suffix)};\nwindow.BRAIN_VIZ_INDEX = ${JSON.stringify({ schema: 1, updatedAt: null, repos })};\n`;
}

/** The viewer page with this session's token on its asset URLs and without the remote font links the CSP would block. */
function pageHtml(token: string): string {
  let html = fs.readFileSync(path.join(VIEWER, 'index.html'), 'utf8');
  html = html.replace(/^.*fonts\.(?:googleapis|gstatic)\.com.*\n/gm, '');
  // An empty icon, as on the dashboard page: /favicon.ico would be asked for without a token.
  html = html.replace('<head>', '<head>\n<link rel="icon" href="data:,">');
  const t = encodeURIComponent(token);
  for (const asset of ['app.css', 'vendor/three.min.js', 'index.js', 'core.js', 'app.js']) {
    html = html.split(`"${asset}"`).join(`"${asset}?token=${t}"`);
  }
  return html;
}

/** Answers `/graph/...` requests that already passed the dashboard's host, origin and token checks. Null: not a graph path. */
export function graphReply(pathname: string, entries: RepoEntry[], token: string): GraphReply | null {
  if (pathname === '/graph') return { status: 301, type: 'text/plain; charset=utf-8', body: '' };
  if (!pathname.startsWith('/graph/')) return null;
  const rest = pathname.slice('/graph/'.length);
  try {
    if (rest === '' || rest === 'index.html') return { status: 200, type: 'text/html; charset=utf-8', body: pageHtml(token), csp: GRAPH_CSP };
    if (rest === 'index.js') return { status: 200, type: JS, body: indexScript(entries, token), csp: GRAPH_CSP };
    const asset = Object.prototype.hasOwnProperty.call(FILES, rest) ? FILES[rest] : undefined;
    if (asset) return { status: 200, type: asset.type, body: fs.readFileSync(asset.file()), csp: GRAPH_CSP };
    const m = /^repos\/([0-9a-f]{12})\/([0-9]{8}T[0-9]{6}Z)\.js$/.exec(rest);
    if (m) {
      const entry = entries.find((e) => e.id === m[1]);
      const info = entry ? buildOf(entry.path) : null;
      if (!entry || !info || versionIdFor(info.builtAt) !== m[2]) return notFound();
      return { status: 200, type: JS, body: snapshotText(entry, info, m[2]), csp: GRAPH_CSP };
    }
  } catch {
    return { status: 500, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: 'Internal error' }) };
  }
  return notFound();
}
