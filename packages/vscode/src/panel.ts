import { StatusView, PendingChange, statusRows, describeOp } from './format';

/*
 * HTML for the sidebar webview and the dashboard webview. Pure string building so it can be tested without VS Code.
 * Rules: strict CSP with a nonce, no inline event handlers, no external resources, and EVERYTHING that came from the
 * CLI (status text, rule lines, error messages) is escaped, because a rule line is repo-derived text.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const PANEL_ACTIONS = ['init', 'enhance', 'review', 'test', 'refresh', 'approvals', 'selftest', 'skills', 'dashboard', 'toggle', 'reload', 'output'] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

export type PanelMessage = { type: 'action'; id: PanelAction } | { type: 'rule'; decision: 'approve' | 'reject'; id: string };

/** Rule-change ids are short hex; anything else (a leading dash would look like a CLI option) is refused. */
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Messages come from a webview, so treat them as untrusted input. */
export function parsePanelMessage(raw: unknown): PanelMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  if (m.type === 'action' && typeof m.id === 'string' && (PANEL_ACTIONS as readonly string[]).includes(m.id)) return { type: 'action', id: m.id as PanelAction };
  if (m.type === 'rule' && (m.decision === 'approve' || m.decision === 'reject') && typeof m.id === 'string' && RULE_ID.test(m.id)) return { type: 'rule', decision: m.decision, id: m.id };
  return undefined;
}

export interface PanelState {
  /** Set when the CLI could not be run at all: shown instead of the status. */
  error?: string;
  status?: StatusView;
  statusFetchedAt?: number;
  pending: PendingChange[];
  /** Why the pending list could not be read, if so. */
  pendingError?: string;
  /** Commands running right now. */
  running: string[];
  workspace?: string;
}

const BUTTONS: { id: PanelAction; label: string; hint: string }[] = [
  { id: 'init', label: 'Init', hint: 'Set up DevSarathi in this repo' },
  { id: 'enhance', label: 'Enhance', hint: 'Turn a request plus the spec into a precise prompt' },
  { id: 'review', label: 'Review', hint: 'Security, impact and peer review of the current changes' },
  { id: 'test', label: 'Test', hint: 'Run the tester agent' },
  { id: 'refresh', label: 'Refresh', hint: 'Refresh the graph and propose rule updates' },
  { id: 'approvals', label: 'Approvals', hint: 'Review pending rule changes' },
  { id: 'selftest', label: 'Self-test', hint: 'Check that the agents catch planted problems' },
  { id: 'skills', label: 'Skills', hint: 'Optional skills step' },
  { id: 'dashboard', label: 'Dashboard', hint: 'Open the local dashboard' }
];

const CSS = `
:root{color-scheme:light dark}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:transparent;padding:0 10px 16px;margin:0}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin:16px 0 6px;color:var(--vscode-descriptionForeground)}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:3px 10px}
dt{color:var(--vscode-descriptionForeground)}
dd{margin:0;word-break:break-word}
.ok{color:var(--vscode-testing-iconPassed,var(--vscode-foreground))}
.warn{color:var(--vscode-editorWarning-foreground)}
.bad{color:var(--vscode-errorForeground)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
button{font:inherit;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-button-border,transparent);padding:4px 8px;cursor:pointer;border-radius:2px;text-align:center}
button:hover{background:var(--vscode-button-secondaryHoverBackground)}
button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button.primary:hover{background:var(--vscode-button-hoverBackground)}
button.wide{grid-column:1 / -1}
.error{border:1px solid var(--vscode-inputValidation-errorBorder);background:var(--vscode-inputValidation-errorBackground);padding:6px 8px;margin:10px 0;word-break:break-word}
.muted{color:var(--vscode-descriptionForeground)}
ul.changes{list-style:none;margin:0;padding:0}
ul.changes li{border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));padding:6px 8px;margin:0 0 6px}
.line{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre-wrap;word-break:break-word;margin:4px 0}
.row{display:flex;gap:6px;margin-top:4px}
.row button{flex:1}
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-action],[data-rule]') : null;
    if (!el || el.disabled) return;
    if (el.hasAttribute('data-rule')) vscode.postMessage({ type: 'rule', decision: el.getAttribute('data-decision'), id: el.getAttribute('data-rule') });
    else vscode.postMessage({ type: 'action', id: el.getAttribute('data-action') });
  });
})();
`;

function csp(nonce: string): string {
  // No remote anything: styles and the one script are allowed only with this page's nonce.
  return `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`;
}

function page(title: string, nonce: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
${body}
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

function statusBlock(s: PanelState): string {
  if (s.error) {
    return `<div class="error" role="alert"><strong>DevSarathi could not run.</strong><div class="line">${escapeHtml(s.error)}</div><div class="row"><button type="button" data-action="reload">Retry</button><button type="button" data-action="output">Show output</button></div></div>`;
  }
  if (!s.status) return `<p class="muted" role="status">Reading status...</p>`;
  const rows = statusRows(s.status, s.statusFetchedAt);
  const dl = rows.map((r) => `<dt>${escapeHtml(r.label)}</dt><dd${r.tone ? ` class="${r.tone}"` : ''}>${escapeHtml(r.value)}</dd>`).join('');
  const note = s.status.initialized ? '' : `<p class="warn">DevSarathi is not set up in this repo yet. Press Init.</p>`;
  return `${note}<dl aria-label="DevSarathi status">${dl}</dl>`;
}

function pendingBlock(s: PanelState): string {
  const head = `<h2 id="pending-h">Pending approvals${s.pending.length ? ` (${s.pending.length})` : ''}</h2>`;
  if (s.pendingError) return `${head}<div class="error" role="alert"><div class="line">Could not read pending rule changes: ${escapeHtml(s.pendingError)}</div></div>`;
  if (!s.pending.length) return `${head}<p class="muted">No rule changes are waiting.</p>`;
  const items = s.pending
    .map(
      (c) => `<li><div><strong>${escapeHtml(describeOp(c))}</strong> <span class="${c.risk === 'high' ? 'warn' : 'muted'}">(${escapeHtml(c.risk)} risk)</span></div>` +
        (c.text ? `<div class="line">${escapeHtml(c.text)}</div>` : '') +
        (c.reason ? `<div class="muted">${escapeHtml(c.reason)}</div>` : '') +
        `<div class="row"><button type="button" class="primary" data-rule="${escapeHtml(c.id)}" data-decision="approve" aria-label="Approve change ${escapeHtml(c.id)}">Approve</button>` +
        `<button type="button" data-rule="${escapeHtml(c.id)}" data-decision="reject" aria-label="Reject change ${escapeHtml(c.id)}">Reject</button></div></li>`
    )
    .join('');
  return `${head}<ul class="changes" aria-labelledby="pending-h">${items}</ul>`;
}

export function buildPanelHtml(state: PanelState, nonce: string): string {
  const initialized = state.status?.initialized !== false;
  const disabled = state.status?.disabled === true;
  const buttons = BUTTONS.filter((b) => initialized || b.id === 'init' || b.id === 'dashboard')
    .map((b) => `<button type="button"${b.id === 'init' && !state.status?.initialized ? ' class="primary"' : ''} data-action="${b.id}" title="${escapeHtml(b.hint)}">${escapeHtml(b.label)}</button>`)
    .join('');
  const toggle = state.status?.initialized
    ? `<button type="button" class="wide" data-action="toggle" title="Kill switch: turn all hooks and automatic behavior ${disabled ? 'on' : 'off'}">${disabled ? 'Enable DevSarathi' : 'Disable DevSarathi (kill switch)'}</button>`
    : '';
  const running = state.running.length ? `<p class="muted" role="status" aria-live="polite">Running: ${state.running.map(escapeHtml).join(', ')}</p>` : '';
  const body = [
    state.workspace ? `<p class="muted">${escapeHtml(state.workspace)}</p>` : '',
    `<h2>Status</h2>`,
    statusBlock(state),
    running,
    `<h2>Actions</h2>`,
    `<div class="grid">${buttons}${toggle}</div>`,
    state.status?.initialized || state.pendingError ? pendingBlock(state) : ''
  ].join('\n');
  return page('DevSarathi', nonce, body);
}

/** The dashboard panel: an iframe on the 127.0.0.1 address the dashboard process printed. Nothing else loads. */
export function buildDashboardHtml(url: string, nonce: string): string {
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; frame-src http://127.0.0.1:*`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DevSarathi dashboard</title>
<style nonce="${nonce}">html,body{height:100%;margin:0;padding:0;background:var(--vscode-editor-background)}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head>
<body>
<iframe src="${escapeHtml(url)}" title="DevSarathi dashboard (local, read-only)"></iframe>
</body>
</html>`;
}

export function makeNonce(random: (n: number) => Uint8Array): string {
  return Buffer.from(random(18)).toString('base64').replace(/[^A-Za-z0-9]/g, 'x');
}
