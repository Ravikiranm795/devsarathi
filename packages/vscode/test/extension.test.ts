import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { state, reset, makeContext } from './fakeVscode';

vi.mock('vscode', () => import('./fakeVscode').then((m) => m.api));

import { activate, deactivate } from '../src/extension';
import { COMMAND_IDS } from '../src/flows';

const BIN = path.resolve(__dirname, '..', '..', '..', 'bin', 'devsarathi.js');
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

let repo: string;
const flush = async (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await flush(25);
}

beforeEach(() => {
  reset();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ext-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  state.folders = [{ uri: { fsPath: repo }, name: 'repo' }];
});
afterEach(() => {
  deactivate();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('manifest', () => {
  it('declares every registered command, the activity bar view and the cliPath setting', () => {
    const declared = manifest.contributes.commands.map((c: { command: string }) => c.command).sort();
    expect(declared).toEqual([...COMMAND_IDS].sort());
    expect(manifest.contributes.viewsContainers.activitybar[0].id).toBe('devsarathi');
    expect(manifest.contributes.views.devsarathi[0]).toMatchObject({ id: 'devsarathi.sidebar', type: 'webview' });
    expect(manifest.contributes.configuration.properties['devsarathi.cliPath'].default).toBe('devsarathi');
    expect(manifest.activationEvents).toContain('workspaceContains:.claude/devsarathi/config.json');
    expect(manifest).toMatchObject({ publisher: 'ravikiranm', name: 'devsarathi', displayName: 'DevSarathi', main: './dist/extension.js', engines: { vscode: '^1.85.0' } });
    // VS Code 1.74+ activates on contributed commands and views by itself, so only the workspace trigger is declared
    expect(manifest.activationEvents).toEqual(['workspaceContains:.claude/devsarathi/config.json']);
    expect(manifest.private).toBeUndefined(); // the Marketplace refuses private extensions
    expect(manifest.icon).toBe('media/icon.png');
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(false);
  });
});

describe('activate() against the fake vscode API', () => {
  it('registers every command, the sidebar and the status bar without throwing', async () => {
    state.config.cliPath = 'definitely-not-installed-devsarathi-xyz';
    const ctx = makeContext();
    expect(() => activate(ctx as never)).not.toThrow();
    for (const id of COMMAND_IDS) expect(state.commands.has(id), id).toBe(true);
    expect(state.providers.has('devsarathi.sidebar')).toBe(true);
    expect(state.statusItems).toHaveLength(1);
    expect(state.statusItems[0].shown).toBe(true);
    expect(state.statusItems[0].command).toBe('workbench.view.extension.devsarathi');
    expect(state.watchers).toBe(1);
    expect(ctx.subscriptions.length).toBeGreaterThan(5);
  });

  it('a missing CLI gives a clear error, in the sidebar and on commands, and never crashes', async () => {
    state.config.cliPath = 'definitely-not-installed-devsarathi-xyz';
    activate(makeContext() as never);
    await until(() => state.messages.some((m) => /CLI not available/.test(m.text)));
    expect(state.messages.find((m) => /CLI not available/.test(m.text))).toMatchObject({ kind: 'error', items: ['Open Settings'] });
    expect(state.statusItems[0].text).toContain('unavailable');

    // the sidebar shows the problem rather than a healthy-looking panel
    const provider = state.providers.get('devsarathi.sidebar') as { resolveWebviewView(v: unknown): void };
    let html = '';
    const view = {
      webview: { options: {}, onDidReceiveMessage: () => ({ dispose() {} }), set html(v: string) { html = v; }, get html() { return html; } },
      visible: true,
      onDidChangeVisibility: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} })
    };
    provider.resolveWebviewView(view);
    expect(html).toContain('DevSarathi could not run.');
    expect(html).toMatch(/Content-Security-Policy/);

    // a command: "<command> did not run: <error>" with Rerun, and Rerun re-invokes it
    state.messages = [];
    state.choices.error = ['Rerun', undefined];
    await state.commands.get('devsarathi.review')!();
    await until(() => state.messages.filter((m) => /^Review did not run:/.test(m.text)).length >= 2);
    const fails = state.messages.filter((m) => /^Review did not run:/.test(m.text));
    expect(fails.length).toBeGreaterThanOrEqual(2); // original + the rerun
    expect(fails[0].items).toEqual(expect.arrayContaining(['Rerun', 'Open Settings']));
    expect(fails[0].text).toMatch(/devsarathi\.cliPath/);
    expect(state.progressTitles.filter((t) => t === 'DevSarathi: review').length).toBeGreaterThanOrEqual(2);
  });

  it('runs the real CLI through a command: not initialized is reported, never a pass', async () => {
    state.config.cliPath = BIN;
    activate(makeContext() as never);
    await until(() => /not set up/.test(state.statusItems[0].text));
    expect(state.statusItems[0].text).toContain('not set up');

    state.messages = [];
    await state.commands.get('devsarathi.status')!();
    await until(() => state.messages.some((m) => /not initialized/.test(m.text)));
    expect(state.messages.some((m) => m.kind === 'info' && /not initialized in this repo/.test(m.text))).toBe(true);

    // review on a repo that is not initialized: the extension offers Init instead of failing quietly
    state.messages = [];
    await state.commands.get('devsarathi.review')!();
    expect(state.messages.some((m) => /not set up in this repo yet/.test(m.text) && m.items.includes('Run Init'))).toBe(true);
  });

  it('surfaces new notices once, with Rerun for a mapped source, and not old history', async () => {
    state.config.cliPath = 'definitely-not-installed-devsarathi-xyz';
    const dir = path.join(repo, '.claude', 'devsarathi');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'notices.jsonl');
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), source: 'review', message: 'Review did not run: OLD' }) + '\n');
    activate(makeContext() as never);
    await flush(100);
    expect(state.messages.some((m) => /OLD/.test(m.text))).toBe(false); // first activation starts at the end

    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), source: 'graph-build', message: 'Graph build failed: boom. Re-run: devsarathi graph build' }) + '\n');
    for (const h of state.watcherHandlers) h(); // the file watcher fires
    for (const h of state.watcherHandlers) h(); // a second event for the same content must not show it again
    await flush(100);
    const shown = state.messages.filter((m) => /Graph build failed/.test(m.text));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ kind: 'error', items: ['Rerun'] });
  });
});
