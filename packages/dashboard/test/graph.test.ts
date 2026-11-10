import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { createRequire } from 'module';
import { startDashboard, repoId, type DashboardHandle } from '../src';
import { makeRepo, tmpDir, writeRegistry } from './fixture';

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

function raw(port: number, p: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

/** A graph.sqlite with the three tables the 3D snapshot reads, next to the build record makeRepo already wrote. */
function writeGraph(repo: string): void {
  const req = createRequire(path.resolve(__dirname, '..', '..', '..', 'brain', 'src', 'graphStore.js'));
  const Database = req('better-sqlite3') as new (file: string) => { exec(sql: string): void; close(): void };
  const db = new Database(path.join(repo, '.claude', 'devsarathi', 'graph', 'graph.sqlite'));
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, ext TEXT, is_test INTEGER);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, kind TEXT, start_line INTEGER, end_line INTEGER, signature TEXT);
    CREATE TABLE edges (id INTEGER PRIMARY KEY, src_symbol_id INTEGER, dst_symbol_id INTEGER, resolution TEXT);
    INSERT INTO files VALUES (1, 'src/app/a.service.ts', '.ts', 0), (2, 'src/app/a.service.spec.ts', '.ts', 1);
    INSERT INTO symbols VALUES (1, 1, 'load', 'method', 3, 9, 'load(id: string)'), (2, 1, 'save', 'method', 11, 20, NULL), (3, 2, 'loads', 'test', 1, 5, NULL);
    INSERT INTO edges VALUES (1, 3, 1, 'heuristic'), (2, 1, 2, 'lsp'), (3, 1, NULL, 'heuristic');
  `);
  db.close();
}

describe('3D graph routes', () => {
  const parent = tmpDir();
  const repo = makeRepo(parent);
  const noGraph = makeRepo(parent, { name: 'no-graph' });
  const registry = path.join(parent, 'home', 'registry.json');
  let srv: DashboardHandle;
  const q = () => `token=${srv.token}`;

  beforeAll(async () => {
    writeGraph(repo);
    writeRegistry(registry, [{ path: repo }, { path: noGraph }]);
    srv = await startDashboard({ registryPath: registry });
  });
  afterAll(async () => {
    await srv.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('needs the session token on every graph path', async () => {
    for (const p of ['/graph/', '/graph/index.js', '/graph/app.js', '/graph/vendor/three.min.js', `/graph/repos/${repoId(repo)}/20260101T000000Z.js`]) {
      expect((await raw(srv.port, p)).status, p).toBe(401);
      expect((await raw(srv.port, `${p}?token=wrong`)).status, p).toBe(401);
    }
  });

  it('serves the viewer page with the token on its assets, no remote font links and an empty icon', async () => {
    const r = await raw(srv.port, `/graph/?${q()}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(r.body).toContain('<link rel="icon" href="data:,">');
    for (const asset of ['app.css', 'vendor/three.min.js', 'index.js', 'core.js', 'app.js']) expect(r.body, asset).toContain(`"${asset}?token=${srv.token}"`);
    const redirect = await raw(srv.port, `/graph?${q()}`);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.location).toBe(`/graph/?${q()}`);
  });

  it('allows inline style attributes for this page only, and nothing remote', async () => {
    const page = String((await raw(srv.port, `/graph/?${q()}`)).headers['content-security-policy']);
    expect(page).toContain("style-src-attr 'unsafe-inline'");
    expect(page).toContain("script-src 'self'");
    expect(page).not.toMatch(/https?:|unsafe-eval|\*/);
    const dash = String((await raw(srv.port, `/?${q()}`)).headers['content-security-policy']);
    expect(dash).not.toContain('unsafe-inline');
  });

  it('lists each registered repo with its one build, and never an absolute path', async () => {
    const r = await raw(srv.port, `/graph/index.js?${q()}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain(`window.BRAIN_VIZ_SUFFIX = "?token=${srv.token}"`);
    const idx = JSON.parse(/window\.BRAIN_VIZ_INDEX = (.*);/.exec(r.body)![1]) as { repos: { repoId: string; name: string; rootDir: unknown; empty: boolean; versions: { id: string; counts: { symbols: number } }[] }[] };
    const mine = idx.repos.find((x) => x.repoId === repoId(repo))!;
    expect(mine.versions).toHaveLength(1);
    expect(mine.versions[0].counts.symbols).toBe(3150);
    expect(mine.rootDir).toBeNull();
    expect(r.body).not.toContain(parent.replace(/\\/g, '\\\\'));
    const bare = idx.repos.find((x) => x.repoId === repoId(noGraph))!;
    expect(bare.empty).toBe(true);
    expect(bare.versions).toHaveLength(0);
  });

  it('exports a repo snapshot from its graph, read-only', async () => {
    const idx = JSON.parse(/window\.BRAIN_VIZ_INDEX = (.*);/.exec((await raw(srv.port, `/graph/index.js?${q()}`)).body)![1]);
    const version = idx.repos.find((x: { repoId: string }) => x.repoId === repoId(repo)).versions[0].id as string;
    const r = await raw(srv.port, `/graph/repos/${repoId(repo)}/${version}.js?${q()}`);
    expect(r.status).toBe(200);
    expect(r.body.startsWith('BRAIN_VIZ.register(')).toBe(true);
    const snap = JSON.parse(r.body.slice('BRAIN_VIZ.register('.length, r.body.lastIndexOf(');')));
    expect(snap.repoId).toBe(repoId(repo));
    expect(snap.versionId).toBe(version);
    expect(snap.rootDir).toBeNull();
    expect(snap.files).toHaveLength(2);
    expect(snap.symbols).toHaveLength(3);
    // Two resolved edges; the unresolved one (no destination) is left out. Flat triples: src, dst, resolution.
    expect(snap.edges).toEqual([2, 0, 0, 0, 1, 1]);
  });

  it('answers 404 for an unknown repo, a stale version, a repo without a graph and files outside the whitelist', async () => {
    expect((await raw(srv.port, `/graph/repos/${repoId(repo)}/20000101T000000Z.js?${q()}`)).status).toBe(404);
    expect((await raw(srv.port, `/graph/repos/${'0'.repeat(12)}/20260101T000000Z.js?${q()}`)).status).toBe(404);
    expect((await raw(srv.port, `/graph/repos/${repoId(noGraph)}/20260101T000000Z.js?${q()}`)).status).toBe(404);
    for (const p of ['/graph/package.json', '/graph/vendor/other.js', '/graph/vendor/%2e%2e/%2e%2e/package.json', '/graph/toString', '/graph/constructor', '/graph/repos/x/y.js']) {
      expect((await raw(srv.port, `${p}?${q()}`)).status, p).toBe(404);
    }
  });
});
