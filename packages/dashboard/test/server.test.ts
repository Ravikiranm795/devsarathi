import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { startDashboard, listRepos, readRepoSummary, repoId, type DashboardHandle } from '../src';
import { addFailure, CANARIES, makeCorruptRepo, makeRepo, tmpDir, writeRegistry } from './fixture';

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

/** Raw http so tests can set Host/Origin and send paths exactly as written (fetch normalises both). */
function raw(port: number, p: string, o: { method?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: o.method ?? 'GET', headers: o.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end();
  });
}

describe('dashboard server', () => {
  const parent = tmpDir();
  const repo = makeRepo(parent);
  const nonBase = makeRepo(parent, { name: 'branchy', baseline: false });
  const broken = makeCorruptRepo(parent);
  const gone = path.join(parent, 'deleted-repo');
  const uninit = path.join(parent, 'fresh-repo');
  const registry = path.join(parent, 'home', 'registry.json');
  let srv: DashboardHandle;
  const auth = () => ({ 'x-ds-token': srv.token });

  beforeAll(async () => {
    fs.mkdirSync(uninit, { recursive: true });
    addFailure(nonBase);
    writeRegistry(registry, [{ path: repo }, { path: nonBase }, { path: broken }, { path: gone }, { path: uninit }]);
    srv = await startDashboard({ registryPath: registry });
  });
  afterAll(async () => {
    await srv.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('binds to 127.0.0.1 only, on a random port, with a random token', async () => {
    expect(srv.url).toBe(`http://127.0.0.1:${srv.port}/?token=${srv.token}`);
    expect(srv.token).toMatch(/^[0-9a-f]{32}$/);
    const other = await startDashboard({ registryPath: registry });
    try {
      expect(other.port).not.toBe(srv.port);
      expect(other.token).not.toBe(srv.token);
    } finally {
      await other.close();
    }
    // Through the machine's LAN address (when it has one) nothing may be listening.
    const ifaces = Object.values(os.networkInterfaces()).flat() as { address: string; internal: boolean; family: string }[];
    const lan = ifaces.find((i) => i && !i.internal && i.family === 'IPv4');
    if (lan) {
      const outcome = await new Promise<string>((resolve) => {
        const s = http.get({ host: lan.address, port: srv.port, path: '/healthz', agent: false, timeout: 1500 }, (res) => { res.resume(); resolve('reachable'); });
        s.on('error', () => resolve('refused'));
        s.on('timeout', () => { s.destroy(); resolve('refused'); });
      });
      expect(outcome).toBe('refused');
    }
  });

  it('exposes the bound address as 127.0.0.1 (checked on the socket)', async () => {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    expect((probe.address() as AddressInfo).address).toBe('127.0.0.1');
    probe.close();
    // The handle exposes no server object, so verify via a connection's local address.
    const local = await new Promise<string>((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port: srv.port, path: '/healthz', agent: false }, (res) => { resolve(res.socket.localAddress ?? ''); res.resume(); });
      r.on('error', reject);
    });
    expect(local).toBe('127.0.0.1');
  });

  it('refuses a non-loopback host option', async () => {
    await expect(startDashboard({ host: '0.0.0.0', registryPath: registry })).rejects.toThrow(/127\.0\.0\.1/);
    await expect(startDashboard({ host: 'localhost', registryPath: registry })).rejects.toThrow(/127\.0\.0\.1/);
    const ok = await startDashboard({ host: '127.0.0.1', port: 0, token: 'fixed-token', registryPath: registry });
    expect(ok.token).toBe('fixed-token');
    await ok.close();
  });

  it('requires the token on every route except /healthz', async () => {
    for (const p of ['/', '/app.js', '/style.css', '/api/repos', `/api/repos/${repoId(repo)}`, '/nope']) {
      expect((await raw(srv.port, p)).status, p).toBe(401);
      expect((await raw(srv.port, `${p}${p.includes('?') ? '&' : '?'}token=wrong`)).status, p).toBe(401);
      expect((await raw(srv.port, p, { headers: { 'x-ds-token': 'x'.repeat(32) } })).status, p).toBe(401);
    }
    const health = await raw(srv.port, '/healthz');
    expect(health.status).toBe(200);
    expect(health.body).toBe('ok');
    expect((await raw(srv.port, '/api/repos', { headers: auth() })).status).toBe(200);
    expect((await raw(srv.port, `/api/repos?token=${srv.token}`)).status).toBe(200);
    expect((await raw(srv.port, `/?token=${srv.token}`)).status).toBe(200);
  });

  it('rejects a foreign Host (DNS rebinding) and cross-origin requests', async () => {
    for (const host of ['evil.example.com', `evil.example.com:${srv.port}`, '127.0.0.1', `127.0.0.1:${srv.port + 1}`, '[::1]:' + srv.port]) {
      expect((await raw(srv.port, '/api/repos', { headers: { ...auth(), Host: host } })).status, host).toBe(403);
    }
    expect((await raw(srv.port, '/healthz', { headers: { Host: 'evil.example.com' } })).status).toBe(403);
    expect((await raw(srv.port, '/api/repos', { headers: { ...auth(), Host: `localhost:${srv.port}` } })).status).toBe(200);
    for (const origin of ['http://evil.example.com', 'null', `http://127.0.0.1:${srv.port + 1}`, `https://127.0.0.1:${srv.port}`]) {
      expect((await raw(srv.port, '/api/repos', { headers: { ...auth(), Origin: origin } })).status, origin).toBe(403);
    }
    expect((await raw(srv.port, '/api/repos', { headers: { ...auth(), Origin: `http://127.0.0.1:${srv.port}` } })).status).toBe(200);
  });

  it('is read-only: only GET and HEAD are allowed', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await raw(srv.port, '/api/repos', { method, headers: auth() });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe('GET, HEAD');
    }
    const head = await raw(srv.port, '/api/repos', { method: 'HEAD', headers: auth() });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('sets no-store, nosniff and a strict CSP that allows the VS Code iframe, and no X-Frame-Options', async () => {
    const r = await raw(srv.port, `/?token=${srv.token}`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeUndefined();
    const csp = String(r.headers['content-security-policy']);
    for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self' vscode-webview:"]) expect(csp).toContain(d);
    expect(csp).not.toMatch(/https?:|unsafe-inline|unsafe-eval|\*/);
    const api = await raw(srv.port, '/api/repos', { headers: auth() });
    expect(api.headers['cache-control']).toBe('no-store');
    expect(api.headers['content-type']).toContain('application/json');
  });

  it('serves the page with the session token wired into the asset URLs', async () => {
    const r = await raw(srv.port, `/?token=${srv.token}`);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).not.toContain('{{TOKEN}}');
    expect(r.body).toContain(`app.js?token=${srv.token}`);
    expect(r.body).not.toMatch(/(src|href)="https?:/);
    const js = await raw(srv.port, `/app.js?token=${srv.token}`);
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
  });

  it('lists repos with ids, folder names and health, never full paths', async () => {
    const r = await raw(srv.port, '/api/repos', { headers: auth() });
    const body = JSON.parse(r.body) as { repos: { id: string; name: string; dir: string; health: string; stacks: string[]; baselineBranch: string }[] };
    expect(body.repos).toHaveLength(5);
    const by = (name: string) => body.repos.find((x) => x.name === name)!;
    expect(by('acme-shop')).toMatchObject({ id: repoId(repo), dir: 'acme-shop', health: 'ok', stacks: ['react'], baselineBranch: 'main' });
    expect(by('deleted-repo').health).toBe('missing');
    expect(by('fresh-repo').health).toBe('uninitialized');
    expect(r.body).not.toContain(parent);
    expect(r.body).not.toContain(parent.replace(/\\/g, '/'));
    expect(body.repos.every((x) => /^[0-9a-f]{12}$/.test(x.id))).toBe(true);
  });

  it('builds the merged summary from the fixture state folder', async () => {
    const r = await raw(srv.port, `/api/repos/${repoId(repo)}`, { headers: auth() });
    expect(r.status).toBe(200);
    const s = JSON.parse(r.body);
    expect(s).toMatchObject({ name: 'acme-shop', dir: 'acme-shop', health: 'ok' });
    expect(s.config).toEqual({ persona: { name: 'Asha', title: 'Frontend Developer' }, baselineBranch: 'main', stacks: [{ id: 'react', dir: '.' }, { id: 'java', dir: 'services/api' }], disabled: false, initializedAt: expect.any(String), coverageThreshold: 0.8 });
    expect(s.build).toMatchObject({ branch: 'main', baseline: true, status: 'completed', commit: expect.stringMatching(/^9fceb02d/), coverage: { ratio: 0.936, parsedFiles: 412 } });
    expect(s.graph).toMatchObject({ files: 412, symbols: 3150, languages: { '.ts': 250 } });
    expect(s.graph.modules).toHaveLength(4);
    expect(s.metrics.prompts).toMatchObject({ enhanced: 40, accepted: 24, acceptanceRate: 0.6 });
    expect(s.metrics.turnsPerTask).toMatchObject({ baseline: { tasks: 12, avgTurns: 6.5 }, withEnhancer: { tasks: 9, avgTurns: 3.8 }, improvement: 0.415 });
    expect(s.metrics.usage.activeDays).toBe(13);
    expect(s.reviews).toHaveLength(2);
    expect(s.reviews[0]).toMatchObject({ runId: '20260102-bbb', verdict: 'incomplete', range: 'origin/main..HEAD', runs: [{ agent: 'security', status: 'completed' }, { agent: 'tester', status: 'timeout' }] });
    expect(s.reviews[1]).toMatchObject({ verdict: 'findings', findingsBySeverity: { high: 1, low: 1, medium: 1 }, findingsByAgent: { security: 2, 'peer-review': 1 }, redFlags: 1 });
    expect(s.audit).toMatchObject({ status: 'fix', findings: 2, bySeverity: { medium: 1, low: 1 }, checked: { files: 8, rules: 61 } });
    expect(s.changelog.total).toBe(3);
    expect(s.changelog.entries.map((e: { risk: string }) => e.risk)).toEqual(['high', 'medium', 'low']);
    expect(s.changelog.entries[2]).toMatchObject({ how: 'auto-applied', op: 'add', file: 'CLAUDE.md', reason: 'new test command detected' });
    expect(s.pendingRules).toBe(2);
    expect(s.notices).toHaveLength(3); // the corrupt line is skipped, the rest survive
    expect(s.notices[0].message).toContain('not installed');
    expect(s.lastBuildFailure).toBeNull();
  });

  it('serves a non-baseline build as such and exposes the last build failure', async () => {
    const s = JSON.parse((await raw(srv.port, `/api/repos/${repoId(nonBase)}`, { headers: auth() })).body);
    expect(s.build).toMatchObject({ baseline: false, branch: 'feature/login-flow' });
    expect(s.lastBuildFailure).toMatchObject({ branch: 'feature/login-flow' });
  });

  it('never leaks full repo paths, prompt text, finding detail, rule bodies or config secrets', async () => {
    for (const r of [repo, nonBase]) {
      const res = await raw(srv.port, `/api/repos/${repoId(r)}`, { headers: auth() });
      for (const c of CANARIES) expect(res.body, c).not.toContain(c);
      expect(res.body).not.toContain(parent);
      expect(res.body).not.toContain(parent.replace(/\\/g, '/'));
      expect(res.body).not.toContain('secret.ts');
    }
    const s = JSON.parse((await raw(srv.port, `/api/repos/${repoId(nonBase)}`, { headers: auth() })).body);
    expect(s.notices.some((n: { message: string }) => n.message.includes('<repo>'))).toBe(true);
    expect(s.lastBuildFailure.error).toContain('<repo>');
  });

  it('tolerates missing and corrupt files: null fields, never a 500', async () => {
    const r = await raw(srv.port, `/api/repos/${repoId(broken)}`, { headers: auth() });
    expect(r.status).toBe(200);
    const s = JSON.parse(r.body);
    expect(s).toMatchObject({ health: 'ok', config: null, build: null, graph: null, metrics: null, reviews: null, audit: null, pendingRules: null, lastBuildFailure: null });
    expect(s.changelog).toEqual({ total: 0, entries: [] });
    expect(s.notices).toHaveLength(1);
    for (const id of [repoId(gone), repoId(uninit)]) {
      const m = await raw(srv.port, `/api/repos/${id}`, { headers: auth() });
      expect(m.status).toBe(200);
      expect(JSON.parse(m.body)).toMatchObject({ build: null, metrics: null, notices: null });
    }
  });

  it('blocks path traversal and client-supplied paths', async () => {
    const attempts = ['/../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json', '/....//package.json', '/%00', '/../src/server.ts', '/web/../../package.json', '/.hidden', '/app.js%00.png', `/api/repos/${encodeURIComponent(repo)}`, '/api/repos/..%2f..', '/api/repos/../../x', `/api/repos/${repo.replace(/\\/g, '/')}`];
    for (const p of attempts) {
      const r = await raw(srv.port, `${p}${p.includes('?') ? '&' : '?'}token=${srv.token}`);
      expect([400, 404], `${p} -> ${r.status}`).toContain(r.status);
      expect(r.body).not.toContain('"name": "@devsarathi');
      expect(r.body).not.toContain('startDashboard');
    }
    expect((await raw(srv.port, '/api/repos/0123456789ab', { headers: auth() })).status).toBe(404);
    // Only known static types are served, even from inside web/.
    expect((await raw(srv.port, `/index.html.map?token=${srv.token}`)).status).toBe(404);
  });
});

describe('pure readers', () => {
  const parent = tmpDir();
  const repo = makeRepo(parent);
  afterAll(() => fs.rmSync(parent, { recursive: true, force: true }));

  it('listRepos reads the registry, tolerates a missing or corrupt file, and serves an unregistered focus repo', () => {
    const reg = path.join(parent, 'reg.json');
    expect(listRepos(path.join(parent, 'nope.json'))).toEqual([]);
    fs.writeFileSync(reg, '{ broken');
    expect(listRepos(reg)).toEqual([]);
    fs.writeFileSync(reg, JSON.stringify({ version: 1, repos: [{ path: repo }, { nothing: true }, null, { path: repo }] }));
    const list = listRepos(reg);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'acme-shop', dir: 'acme-shop', health: 'ok', focus: false });
    const other = makeRepo(parent, { name: 'extra-one' });
    const withFocus = listRepos(reg, other);
    expect(withFocus.map((x) => x.name)).toEqual(['extra-one', 'acme-shop']);
    expect(withFocus[0]).toMatchObject({ focus: true, stacks: ['react', 'java'], baselineBranch: 'main' });
    expect(listRepos(reg, repo)[0].focus).toBe(true);
  });

  it('repo ids ignore case and are stable', () => {
    expect(repoId('C:\\Work\\App')).toBe(repoId('c:\\work\\app'));
    expect(repoId(repo)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('readRepoSummary only caps and whitelists what it reads', () => {
    const s = readRepoSummary(repo);
    expect(Object.keys(s).sort()).toEqual(['audit', 'build', 'changelog', 'config', 'dir', 'graph', 'health', 'id', 'lastBuildFailure', 'metrics', 'name', 'notices', 'pendingRules', 'reviews']);
    expect(Object.keys(s.config!)).not.toContain('commandOverrides');
    expect(s.metrics).not.toHaveProperty('events');
  });
});
