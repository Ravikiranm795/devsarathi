import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Browser } from 'playwright-core';
import { startDashboard, type DashboardHandle } from '../src';
import { addFailure, makeRepo, tmpDir, writeRegistry } from './fixture';

/**
 * Real-browser check with the installed Microsoft Edge. If Edge cannot launch (CI box, no browser), every test here is
 * skipped with that reason rather than failed: the server tests still cover the API and security behaviour.
 */
describe('dashboard in a real browser (Edge)', () => {
  const parent = tmpDir();
  const base = makeRepo(parent, { name: 'acme-shop', baseline: true });
  const feature = makeRepo(parent, { name: 'branchy', baseline: false });
  addFailure(feature);
  let srv: DashboardHandle;
  let browser: Browser | undefined;

  beforeAll(async () => {
    writeRegistry(path.join(parent, 'registry.json'), [{ path: base }, { path: feature }]);
    srv = await startDashboard({ registryPath: path.join(parent, 'registry.json'), focusRepo: base });
    try {
      browser = await chromium.launch({ channel: 'msedge' });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`SKIPPING browser tests: Microsoft Edge could not be launched (${(e as Error).message.split('\n')[0]})`);
    }
  });
  afterAll(async () => {
    await browser?.close();
    await srv.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });

  async function open(opts: { width?: number; scheme?: 'light' | 'dark' } = {}) {
    const ctx = await browser!.newContext({ viewport: { width: opts.width ?? 1200, height: 900 }, colorScheme: opts.scheme ?? 'light' });
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
  const bg = (page: import('playwright-core').Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  it('renders the key sections with the fixture numbers, no console errors and no foreign requests', async (t) => {
    if (!browser) return t.skip();
    const { ctx, page, errors, requests } = await open();
    const text = async (sel: string) => (await page.locator(sel).innerText()).replace(/\s+/g, ' ');
    // Top: latest build, branch, commit, baseline label.
    expect(await text('#build')).toMatch(/Latest graph build 3 hours ago/);
    expect(await text('#build-branch')).toBe('main');
    expect(await text('#build-commit')).toBe('9fceb02d4a');
    expect(await text('#build')).toContain('Baseline graph');
    expect(await page.locator('#build-warning').count()).toBe(0);
    expect(await page.locator('#build time').getAttribute('datetime')).toBeTruthy();
    // Graph summary.
    const graph = await text('#graph');
    expect(graph).toContain('412');
    expect(graph).toContain('3,150');
    expect(graph).toContain('94%');
    expect(graph).toContain('.tsx');
    // Efficiency: before vs after with sample sizes, acceptance beside it.
    const eff = await text('#efficiency');
    expect(eff).toContain('6.5 turns per task (n = 12 tasks)');
    expect(eff).toContain('3.8 turns per task (n = 9 tasks)');
    expect(eff).toContain('42% fewer turns per task');
    expect(eff).toContain('60% accepted as-is');
    expect(eff).toContain('acceptance alone can be inflated');
    expect(await page.locator('#efficiency svg[role="img"]').count()).toBeGreaterThan(0);
    // Usage, reviews, agents, rules, self-test, notices.
    expect(await text('#usage')).toContain('13');
    const reviews = await text('#reviews');
    expect(reviews).toContain('INCOMPLETE');
    expect(reviews).toMatch(/Red flags at push 2/);
    expect(await page.locator('#agents td.warncell').count()).toBe(2);
    expect(await text('#rules')).toMatch(/Pending approval 2/);
    expect(await page.locator('#changelog li').count()).toBe(3);
    expect(await text('#selftest')).toContain('✗ 10/12');
    expect(await page.locator('#notices li').count()).toBe(3);
    expect(await page.locator('#failure').count()).toBe(0);
    // Repo selector lists both repos, and the token is stripped from the address bar.
    expect(await page.locator('#repo-select option').allInnerTexts()).toEqual(['acme-shop', 'branchy']);
    expect(page.url()).not.toContain('token');
    expect(errors).toEqual([]);
    expect(requests.length).toBeGreaterThan(3);
    for (const u of requests) expect(u.startsWith(`http://127.0.0.1:${srv.port}/`), u).toBe(true);
    await ctx.close();
  });

  it('labels a non-baseline build clearly and shows the last build failure', async (t) => {
    if (!browser) return t.skip();
    const { ctx, page } = await open();
    await page.selectOption('#repo-select', { label: 'branchy' });
    await page.waitForSelector('#build.nonbaseline');
    const build = (await page.locator('#build').innerText()).replace(/\s+/g, ' ');
    expect(build).toContain('NOT BASELINE');
    expect(build).toContain('not the baseline');
    expect(build).not.toContain('Baseline graph');
    expect(await page.locator('#build-branch').innerText()).toBe('feature/login-flow');
    await page.waitForSelector('#failure');
    expect(await page.locator('#failure').innerText()).toContain('ENOSPC');
    expect(await page.locator('#failure').innerText()).not.toContain(parent);
    await ctx.close();
  });

  it('supports dark mode (OS preference and manual toggle)', async (t) => {
    if (!browser) return t.skip();
    const dark = await open({ scheme: 'dark' });
    expect(await bg(dark.page)).toBe('rgb(14, 17, 22)');
    await dark.page.click('#theme');
    expect(await bg(dark.page)).toBe('rgb(244, 246, 249)');
    await dark.ctx.close();
    const light = await open({ scheme: 'light' });
    expect(await bg(light.page)).toBe('rgb(244, 246, 249)');
    await light.page.click('#theme');
    expect(await light.page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    expect(await bg(light.page)).toBe('rgb(14, 17, 22)');
    expect(await light.page.getAttribute('#theme', 'aria-pressed')).toBe('true');
    await light.ctx.close();
  });

  it('has no horizontal scroll at 375px', async (t) => {
    if (!browser) return t.skip();
    const { ctx, page } = await open({ width: 375 });
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(w[0]).toBeLessThanOrEqual(w[1]);
    const shots = process.env.DS_SHOT_DIR;
    if (shots) await page.screenshot({ path: path.join(shots, 'mobile.png'), fullPage: true });
    await ctx.close();
  });

  it('shows a clear message without a token and honest empty states for a repo with no data', async (t) => {
    if (!browser) return t.skip();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${srv.port}/?token=nope`);
    expect(await page.locator('body').innerText()).toContain('Missing or invalid token');
    await ctx.close();
    const emptyRepo = path.join(parent, 'empty-repo');
    const st = path.join(emptyRepo, '.claude', 'devsarathi');
    fs.mkdirSync(st, { recursive: true });
    fs.writeFileSync(path.join(st, 'config.json'), JSON.stringify({ baselineBranch: 'main', stacks: [], persona: { name: 'X', title: 'Y' } }));
    const s2 = await startDashboard({ registryPath: path.join(parent, 'none.json'), focusRepo: emptyRepo });
    const c2 = await browser.newContext();
    const p2 = await c2.newPage();
    await p2.goto(s2.url);
    await p2.waitForSelector('#efficiency');
    const body = (await p2.locator('main').innerText()).replace(/\s+/g, ' ');
    expect(body).toContain('Graph: not built yet');
    expect(body).toContain('No metrics yet');
    expect(body).toContain('No reviews yet');
    expect(body).toContain('No self-test runs yet');
    expect(body).not.toMatch(/\b0%/);
    await c2.close();
    await s2.close();
  });
});
