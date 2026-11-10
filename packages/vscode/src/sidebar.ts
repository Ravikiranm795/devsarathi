import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Controller } from './controller';
import { buildPanelHtml, makeNonce, parsePanelMessage } from './panel';
import { handlePanelMessage } from './flows';

/** The Activity Bar view. It only renders `ctrl.state` and forwards clicks; it holds no state of its own. */
export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'devsarathi.sidebar';
  private view: vscode.WebviewView | undefined;
  private lastKey = '';

  constructor(private readonly ctrl: Controller) {
    ctrl.onState(() => this.render());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((raw: unknown) => {
      void handlePanelMessage(this.ctrl, parsePanelMessage(raw));
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.lastKey = '';
        void this.ctrl.refresh();
        this.render();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
    this.lastKey = '';
    this.render();
  }

  private render(): void {
    const view = this.view;
    if (!view) return;
    const state = { ...this.ctrl.state, workspace: this.ctrl.quietRoot() };
    // Redraw only when something visible changed, so a 60s refresh does not steal keyboard focus from a button.
    const key = buildPanelHtml(state, '');
    if (key === this.lastKey) return;
    this.lastKey = key;
    view.webview.html = buildPanelHtml(state, makeNonce((n) => crypto.randomBytes(n)));
  }
}
