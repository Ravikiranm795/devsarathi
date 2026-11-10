import { describe, it, expect } from 'vitest';
import { buildPanelHtml, buildDashboardHtml, escapeHtml, parsePanelMessage, PanelState } from '../src/panel';
import { parseStatus, statusBarText, statusRows, formatAge, parsePending } from '../src/format';

const status = parseStatus({
  initialized: true,
  toolVersion: '0.1.0',
  disabled: false,
  baselineBranch: 'main',
  currentBranch: 'feature/x',
  build: { branch: 'main', commit: 'abcdef1234567', baseline: true, builtAt: '2026-11-10T00:00:00Z', ageMs: 3 * 3600_000, belowThreshold: false, coverage: { ratio: 0.9 }, status: 'completed' },
  behindBaseline: 4,
  pendingRules: 1,
  newerVersion: '0.2.0'
})!;

const state = (over: Partial<PanelState> = {}): PanelState => ({
  status,
  statusFetchedAt: Date.now(),
  pending: [{ id: 'ab12cd34', file: '.claude/rules/ds-angular.md', op: 'add', risk: 'high', text: '- Use signals', reason: 'New convention' }],
  running: [],
  ...over
});

describe('sidebar HTML', () => {
  const html = buildPanelHtml(state(), 'NONCE123');

  it('has a strict CSP with the nonce and no remote sources', () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-NONCE123'");
    expect(csp).toContain("style-src 'nonce-NONCE123'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    expect(html).not.toMatch(/(src|href)=["']https?:/);
  });

  it('every <script> and <style> carries the nonce, and there are no inline handlers or style attributes', () => {
    for (const m of html.matchAll(/<(script|style)\b([^>]*)>/g)) expect(m[2]).toContain('nonce="NONCE123"');
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('shows the status block, the action buttons and the pending list with Approve/Reject', () => {
    expect(html).toContain('3h old');
    expect(html).toContain('abcdef1');
    expect(html).toContain('4 commit(s) behind main');
    expect(html).toContain('0.2.0 available');
    for (const label of ['Init', 'Enhance', 'Review', 'Test', 'Refresh', 'Approvals', 'Self-test', 'Skills', 'Dashboard', 'Disable DevSarathi']) expect(html).toContain(`>${label}`);
    expect(html).toContain('data-rule="ab12cd34" data-decision="approve"');
    expect(html).toContain('data-rule="ab12cd34" data-decision="reject"');
    expect(html).toContain('<button type="button"'); // real buttons: keyboard accessible
  });

  it('labels a non-baseline graph and the kill switch', () => {
    const s2 = parseStatus({ initialized: true, toolVersion: '1', disabled: true, build: { branch: 'feature/y', commit: 'c0ffee1', baseline: false, builtAt: '', ageMs: 1000, belowThreshold: true, coverage: { ratio: 0.2 } }, behindBaseline: 0, pendingRules: 0 })!;
    const h = buildPanelHtml(state({ status: s2, pending: [] }), 'N');
    expect(h).toContain('NON-BASELINE build of feature/y');
    expect(h).toContain('20% below threshold');
    expect(h).toContain('Enable DevSarathi');
  });

  it('escapes everything that came from the CLI (HTML injection)', () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const h = buildPanelHtml(
      state({
        error: evil,
        pending: [{ id: 'ab12', file: evil, op: 'change', risk: evil, text: evil, reason: evil }],
        running: [evil],
        workspace: evil
      }),
      'N'
    );
    expect(h).not.toContain('<img');
    expect(h).not.toContain('onerror=alert(1)>');
    expect(h).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const st = parseStatus({ initialized: true, toolVersion: evil, disabled: false, baselineBranch: evil, currentBranch: evil, newerVersion: evil, behindBaseline: 1, pendingRules: 0 })!;
    expect(buildPanelHtml(state({ status: st, error: undefined, pending: [] }), 'N')).not.toContain('<img');
  });

  it('an unavailable CLI shows the error with a Retry, not an empty or healthy panel', () => {
    const h = buildPanelHtml({ pending: [], running: [], error: '"devsarathi" was not found.' }, 'N');
    expect(h).toContain('DevSarathi could not run.');
    expect(h).toContain('was not found');
    expect(h).toContain('data-action="reload"');
  });

  it('not initialized: only Init (primary) and Dashboard are offered', () => {
    const h = buildPanelHtml({ pending: [], running: [], status: parseStatus({ initialized: false, toolVersion: '0.1.0', disabled: false, behindBaseline: 0, pendingRules: 0 }) }, 'N');
    expect(h).toContain('not set up in this repo yet');
    expect(h).toContain('data-action="init"');
    expect(h).not.toContain('data-action="review"');
  });
});

describe('panel messages from the webview are untrusted', () => {
  it('accepts known actions and well-formed rule ids only', () => {
    expect(parsePanelMessage({ type: 'action', id: 'review' })).toEqual({ type: 'action', id: 'review' });
    expect(parsePanelMessage({ type: 'rule', decision: 'approve', id: 'ab12cd34' })).toEqual({ type: 'rule', decision: 'approve', id: 'ab12cd34' });
    expect(parsePanelMessage({ type: 'action', id: 'rm -rf' })).toBeUndefined();
    expect(parsePanelMessage({ type: 'rule', decision: 'delete', id: 'ab' })).toBeUndefined();
    expect(parsePanelMessage({ type: 'rule', decision: 'approve', id: '--all' })).toBeUndefined();
    expect(parsePanelMessage({ type: 'rule', decision: 'approve', id: 'a b' })).toBeUndefined();
    expect(parsePanelMessage(null)).toBeUndefined();
    expect(parsePanelMessage('review')).toBeUndefined();
  });
});

describe('dashboard HTML', () => {
  it('iframes only the given 127.0.0.1 address under the required CSP', () => {
    const h = buildDashboardHtml('http://127.0.0.1:5555/?t="><script>x</script>', 'N1');
    expect(h).toContain("frame-src http://127.0.0.1:*");
    expect(h).toContain("default-src 'none'");
    expect(h).not.toContain('<script');
    expect(h).toMatch(/<iframe src="http:\/\/127\.0\.0\.1:5555\/\?t=&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
  });
});

describe('status text', () => {
  it('formats ages like the CLI', () => {
    expect(formatAge(30_000)).toBe('30s');
    expect(formatAge(10 * 60_000)).toBe('10m');
    expect(formatAge(5 * 3600_000)).toBe('5h');
    expect(formatAge(5 * 86400_000)).toBe('5d');
  });
  it('status bar: age, non-baseline, kill switch, not set up, unavailable', () => {
    expect(statusBarText(status, 1000, 1000)).toBe('$(sparkle) DevSarathi: graph 3h · 1 pending');
    expect(statusBarText({ ...status, build: { ...status.build!, baseline: false } }, 1000, 1000)).toContain('(non-baseline)');
    expect(statusBarText({ ...status, disabled: true })).toBe('$(debug-pause) DevSarathi: OFF');
    expect(statusBarText({ ...status, initialized: false })).toContain('not set up');
    expect(statusBarText(undefined)).toContain('unavailable');
    expect(statusBarText({ ...status, build: undefined })).toContain('no graph');
    expect(statusBarText({ ...status, build: { ...status.build!, status: 'failed' } })).toContain('build failed');
  });
  it('the displayed age keeps growing between polls', () => {
    expect(statusRows(status, 0, 2 * 3600_000).find((r) => r.label === 'Graph age')?.value).toBe('5h old');
  });
  it('parses pending rule changes and strips rule comments', () => {
    const p = parsePending([{ id: 'x1', file: 'f', op: 'remove', risk: 'high', oldLine: '- old <!-- source: graph@1 -->', reason: 'gone', createdAt: 'z' }, { nope: 1 }, null]);
    expect(p).toEqual([{ id: 'x1', file: 'f', op: 'remove', risk: 'high', text: '- old', reason: 'gone' }]);
    expect(parsePending('x')).toEqual([]);
  });
  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
