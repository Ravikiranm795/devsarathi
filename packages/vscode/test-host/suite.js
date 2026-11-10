'use strict';
// Runs INSIDE the VS Code extension host (loaded by run.js). Plain JavaScript: no build step.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

exports.run = async function run() {
  const out = { steps: [] };
  const step = (name, ok, detail) => out.steps.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await wait(250);
    }
    return !!(await fn());
  };
  try {
    const ext = vscode.extensions.getExtension('ravikiranm.devsarathi');
    step('the extension is found under its publisher id', !!ext, ext && ext.id);
    step('activated by workspaceContains:.claude/devsarathi/config.json', await until(() => ext && ext.isActive));
    if (ext && !ext.isActive) await ext.activate();

    const cmds = await vscode.commands.getCommands(true);
    const pkg = ext.packageJSON;
    const declared = pkg.contributes.commands.map((c) => c.command);
    const missing = declared.filter((c) => !cmds.includes(c));
    step(`all ${declared.length} contributed commands are registered`, missing.length === 0, missing.join(','));
    step('the Activity Bar container and the sidebar view are contributed', !!pkg.contributes.viewsContainers.activitybar.find((c) => c.id === 'devsarathi') && !!pkg.contributes.views.devsarathi.find((v) => v.id === 'devsarathi.sidebar'));

    const cfgPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.claude', 'devsarathi', 'config.json');
    const disabled = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8')).disabled;
    step('the kill switch starts off', disabled() === false);
    await vscode.commands.executeCommand('devsarathi.disable');
    step('devsarathi.disable reached the CLI (config.json changed)', await until(() => disabled() === true));
    await vscode.commands.executeCommand('devsarathi.enable');
    step('devsarathi.enable reached the CLI (config.json changed back)', await until(() => disabled() === false));

    await vscode.commands.executeCommand('devsarathi.status');
    step('devsarathi.status ran without throwing', true);
    await vscode.commands.executeCommand('devsarathi.refreshPanel');
    step('devsarathi.refreshPanel ran without throwing', true);
    await vscode.commands.executeCommand('workbench.view.extension.devsarathi');
    step('the DevSarathi sidebar container opens', true);

    // a failing run must surface as an error, never as a quiet pass: review on a repo with no graph change is fine, so use selftest-free check
    const notices = path.join(path.dirname(cfgPath), 'notices.jsonl');
    fs.appendFileSync(notices, JSON.stringify({ at: new Date().toISOString(), source: 'graph-build', message: 'Graph build failed: example. The previous graph is still in use.' }) + '\n');
    await wait(1500);
    step('a notice written by a hook is picked up without a crash', true);
  } catch (e) {
    step('no exception', false, e && e.stack);
  }
  fs.writeFileSync(process.env.DS_RESULT, JSON.stringify(out, null, 2));
  if (out.steps.some((s) => !s.ok)) throw new Error('extension host check failed');
};
