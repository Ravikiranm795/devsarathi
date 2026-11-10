import * as vscode from 'vscode';
import { Controller } from './controller';
import { DashboardPanel } from './dashboard';
import { PreviewProvider, registerCommands } from './flows';
import { SidebarProvider } from './sidebar';
import { statusBarText, statusRows } from './format';

/*
 * DevSarathi VS Code extension (MASTER 17): a thin adapter over the `devsarathi` CLI. Wiring only.
 */

let controller: Controller | undefined;
let dashboard: DashboardPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const ctrl = new Controller(context);
  const dash = new DashboardPanel(ctrl);
  const previews = new PreviewProvider();
  controller = ctrl;
  dashboard = dash;
  context.subscriptions.push(ctrl, dash);

  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PreviewProvider.scheme, previews));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, new SidebarProvider(ctrl)));
  context.subscriptions.push(...registerCommands(ctrl, dash, previews));

  // Status bar: graph age / kill-switch state. Click opens the DevSarathi sidebar.
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'workbench.view.extension.devsarathi';
  bar.name = 'DevSarathi';
  context.subscriptions.push(bar);
  const paintBar = (): void => {
    const { status, fetchedAt, error } = ctrl.currentStatus;
    bar.text = statusBarText(status, fetchedAt);
    bar.tooltip = error ? `DevSarathi could not run: ${error}` : status ? statusRows(status, fetchedAt).map((r) => `${r.label}: ${r.value}`).join('\n') : 'DevSarathi';
    bar.show();
  };
  context.subscriptions.push(ctrl.onState(paintBar));
  paintBar();

  // Folder changes may change which repo we work on.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ctrl.watchNotices();
      void ctrl.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('devsarathi.cliPath')) void ctrl.refresh();
    })
  );

  ctrl.watchNotices();
  ctrl.startTimers();
  void ctrl.refresh();
}

export function deactivate(): void {
  // The dashboard child must not outlive the extension.
  dashboard?.dispose();
  controller?.dispose();
  dashboard = undefined;
  controller = undefined;
}
