import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { startDashboardProcess, LongLived, redactSecrets } from './cli';
import { buildDashboardHtml, makeNonce } from './panel';
import { didNotRun } from './result';
import { Controller } from './controller';

/*
 * `devsarathi dashboard --no-open` runs as a long-lived child. Its first stdout line is `Dashboard: <url>` (127.0.0.1,
 * per-session token); we show that URL in an iframe and stop the child as soon as the panel closes (or we deactivate).
 */
export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private proc: LongLived | undefined;
  private starting = false;

  constructor(private readonly ctrl: Controller) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    if (this.starting) return;
    const root = await this.ctrl.root();
    if (!root) return;
    this.starting = true;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'DevSarathi: starting the dashboard' }, async () => {
        const proc = startDashboardProcess({ cliPath: this.ctrl.cliPath(), root });
        this.proc = proc;
        let url: string;
        try {
          url = await proc.ready;
        } catch (err) {
          proc.kill();
          this.proc = undefined;
          const text = didNotRun({ label: 'devsarathi dashboard', error: redactSecrets(err instanceof Error ? err.message : String(err)) });
          this.ctrl.log(text);
          void vscode.window.showErrorMessage(text, 'Rerun').then((c) => {
            if (c === 'Rerun') void this.open();
          });
          return;
        }
        // The address carries a session token: it goes into the iframe and nowhere else (not the log, not a message).
        const panel = vscode.window.createWebviewPanel('devsarathi.dashboard', 'DevSarathi dashboard', vscode.ViewColumn.Active, { enableScripts: false, retainContextWhenHidden: false });
        this.panel = panel;
        panel.webview.html = buildDashboardHtml(url, makeNonce((n) => crypto.randomBytes(n)));
        panel.onDidDispose(() => this.stop());
      });
    } finally {
      this.starting = false;
    }
  }

  private stop(): void {
    this.proc?.kill();
    this.proc = undefined;
    this.panel = undefined;
  }

  dispose(): void {
    const p = this.panel;
    this.stop();
    p?.dispose();
  }
}
