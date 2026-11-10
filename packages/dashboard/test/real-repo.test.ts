import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startDashboard, type DashboardHandle } from '../src';

/**
 * Real-repo check (Playwright + the installed Microsoft Edge). It is OFF unless you point it at a repo that has already
 * been through `devsarathi init`:
 *
 *   DS_REAL_REPO=D:\AI-brain DEVSARATHI_HOME=<home used for init> npx vitest run packages/dashboard/test/real-repo.test.ts
 *
 * The expected numbers are read from the repo's own state files, so the test proves the page shows what DevSarathi
 * actually recorded, not fixture data. Set DS_SHOT_DIR to save screenshots.
 */
const REAL = process.env.DS_REAL_REPO;
const state = (name: string) => (REAL ? path.join(REAL, '.claude', 'devsarathi', ...name.split('/')) : '');
const json = <T = any>(name: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(state(name), 'utf8')) as T; // eslint-disable-line
  } catch {
    return undefined;
  }
};

describe.skipIf(!REAL)('dashboard on a real repo (Playwright, Edge)', () => {
  let srv: DashboardHandle;
  let browser: Browser | undefined;

  beforeAll(async () => {
    srv = await startDashboard({ focusRepo: REAL });
    try {
      browser = await chromium.launch({ channel: 'msedge' });
    } catch (e) {
      throw new Error(`Microsoft Edge could not be launched for the real-repo test: ${(e as Error).message.split('\n')[0]}`);
    }
  });
  afterAll(async () => {
    await browser?.close();
    await srv?.close();
  });

  async function open(opts: { width?: number; scheme?: 'light' | 'dark' } = {}) {
    const ctx = await browser!.newContext({ viewport: { width: opts.width ?? 1280, height: 1000 }, colorScheme: opts.scheme ?? 'light' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(srv.url);
    await page.waitForSelector('#efficiency');
    return { ctx, page, errors, requests };
  }
  const text = async (page: Page, sel: string) => (await page.locator(sel).innerText()).replace(/\s+/g, ' ');
  const fmt = (n: number) => n.toLocaleString('en-US');

  it('the repo has been initialized (precondition)', () => {
    expect(json('config.json'), 'run devsarathi init on the repo first').toBeTruthy();
    expect(json('graph/build-record.json')).toBeTruthy();
    expect(json('graph/summary.json')).toBeTruthy();
  });

  it('shows the latest graph build exactly as recorded: branch, commit, baseline label, coverage, symbols, modules', async () => {
    const rec = json('graph/build-record.json');
    const sum = json('graph/summary.json');
    const { ctx, page, errors } = await open();
    const build = await text(page, '#build');
    expect(await text(page, '#build-branch')).toBe(rec.branch);
    expect(await text(page, '#build-commit')).toBe(rec.commit.slice(0, 10));
    expect(build).toContain(rec.baseline ? 'Baseline graph' : 'NOT BASELINE');
    expect(await page.locator('#build time').getAttribute('datetime')).toBeTruthy();
    const graph = await text(page, '#graph');
    expect(graph).toContain(fmt(sum.symbols));
    expect(graph).toContain(fmt(sum.files));
    expect(graph).toContain(`${Math.round(rec.coverage.ratio * 100)}%`);
    for (const m of sum.modules.slice(0, 3)) expect(graph).toContain(m.name);
    for (const ext of Object.keys(sum.languages).slice(0, 2)) expect(graph).toContain(ext);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('shows the persona, stack and baseline branch from the real config', async () => {
    const cfg = json('config.json');
    const { ctx, page } = await open();
    const body = await text(page, 'body');
    expect(body).toContain(cfg.persona.name);
    expect(body).toContain(cfg.baselineBranch);
    expect(await page.locator('#repo-select option').count()).toBeGreaterThan(0);
    await ctx.close();
  });

  it('shows the metrics that were really recorded: prompts, reviews, graph builds, agent runs, command usage', async () => {
    const m = json('metrics/metrics.json');
    expect(m, 'run devsarathi metrics first').toBeTruthy();
    const { ctx, page } = await open();
    const eff = await text(page, '#efficiency');
    if (m.prompts.enhanced > 0) expect(eff).toMatch(new RegExp(`${m.prompts.accepted}`));
    expect(eff).toMatch(/acceptance alone can be inflated/);
    const reviews = await text(page, '#reviews');
    expect(reviews).toMatch(new RegExp(`Red flags at push ${m.review.redFlagsAtPush}`));
    const usage = await text(page, '#usage');
    expect(usage).toContain(String(m.usage.activeDays));
    for (const [cmd, n] of Object.entries(m.usage.commands as Record<string, number>).slice(0, 3)) {
      expect(usage, cmd).toContain(cmd);
      expect(usage).toContain(String(n));
    }
    // agent runs: anything that did not complete is shown as a warning, never as a pass
    const warn = await page.locator('#agents td.warncell').count();
    const bad = Object.values(m.agents as Record<string, { failed: number; timeout: number }>).reduce((n, a) => n + (a.failed > 0 ? 1 : 0) + (a.timeout > 0 ? 1 : 0), 0);
    expect(warn).toBe(bad);
    await ctx.close();
  });

  it('lists the real review runs with their verdicts, without finding text', async () => {
    const files = fs.readdirSync(state('reviews')).filter((f) => /^review-.*\.json$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const latest = JSON.parse(fs.readFileSync(state(`reviews/${files.sort().pop()}`), 'utf8'));
    const { ctx, page } = await open();
    const reviews = await text(page, '#reviews');
    expect(reviews.toLowerCase()).toContain(String(latest.verdict).toLowerCase());
    expect(reviews).toContain(latest.branch);
    const allFindingText = latest.runs.flatMap((r: any) => r.findings.map((f: any) => f.title + (f.detail ?? ''))).join(' ');
    for (const f of latest.runs.flatMap((r: any) => r.findings).slice(0, 5)) {
      if (f.title) expect(await text(page, 'body'), f.title).not.toContain(f.title);
    }
    expect(allFindingText.length).toBeGreaterThan(0);
    await ctx.close();
  });

  it('never leaks the repo path, secret-shaped strings or file contents through the page or the API', async () => {
    const { ctx, page, requests } = await open();
    const body = await page.content();
    const abs = REAL as string;
    for (const v of [abs, abs.replace(/\\/g, '/'), abs.replace(/\\/g, '\\\\')]) expect(body.includes(v), v).toBe(false);
    // API payloads, fetched with the session token exactly as the page does
    const repos = await (await fetch(`${srv.url.split('?')[0]}api/repos`, { headers: { 'x-ds-token': srv.token } })).json();
    const sum = await (await fetch(`${srv.url.split('?')[0]}api/repos/${repos.repos[0].id}`, { headers: { 'x-ds-token': srv.token } })).text();
    for (const v of [abs, abs.replace(/\\/g, '/'), abs.replace(/\\/g, '\\\\')]) expect(sum.includes(v), v).toBe(false);
    for (const re of [/AKIA[0-9A-Z]{16}/, /gh[pousr]_[A-Za-z0-9]{36,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /eyJ[A-Za-z0-9_-]{8,}\.eyJ/]) {
      expect(re.test(sum), String(re)).toBe(false);
      expect(re.test(body), String(re)).toBe(false);
    }
    for (const u of requests) expect(u.startsWith(`http://127.0.0.1:${srv.port}/`), u).toBe(true);
    await ctx.close();
  });

  it('is read-only and token-protected', async () => {
    const base = srv.url.split('?')[0];
    expect((await fetch(`${base}api/repos`)).status).toBe(401);
    expect((await fetch(`${base}api/repos`, { method: 'POST', headers: { 'x-ds-token': srv.token } })).status).toBe(405);
    // fetch() cannot override Host, so use raw http for the DNS-rebinding check
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/repos', headers: { 'x-ds-token': srv.token, host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('works in dark mode and at 375px without horizontal scroll, and saves screenshots', async () => {
    const shots = process.env.DS_SHOT_DIR;
    if (shots) fs.mkdirSync(shots, { recursive: true });
    const dark = await open({ scheme: 'dark' });
    expect(await dark.page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(14, 17, 22)');
    if (shots) await dark.page.screenshot({ path: path.join(shots, 'real-dark.png'), fullPage: true });
    await dark.ctx.close();
    const light = await open();
    if (shots) await light.page.screenshot({ path: path.join(shots, 'real-light.png'), fullPage: true });
    await light.ctx.close();
    const small = await open({ width: 375 });
    const w = await small.page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(w[0]).toBeLessThanOrEqual(w[1]);
    if (shots) await small.page.screenshot({ path: path.join(shots, 'real-mobile.png'), fullPage: true });
    await small.ctx.close();
  });
});
