'use strict';
// Runs the extension inside a REAL, isolated VS Code (downloaded to .vscode-test/, separate from your own install and profile).
//   node packages/vscode/test-host/run.js
// It initializes a throw-away git repo with DevSarathi, opens it, activates the extension and checks it end to end.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..', '..', '..');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-exthost-'));
  const repo = path.join(tmp, 'repo');
  const copy = (s, t) => {
    fs.mkdirSync(t, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) (e.isDirectory() ? copy : fs.copyFileSync)(path.join(s, e.name), path.join(t, e.name));
  };
  copy(path.join(root, 'test-fixtures', 'python-fastapi'), repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'a@b.c');
  g('config', 'user.name', 't');
  g('config', 'core.autocrlf', 'false');
  g('add', '-A');
  g('commit', '-qm', 'x');

  const env = { ...process.env, DEVSARATHI_EMBEDDER: 'fake', DEVSARATHI_HOME: path.join(tmp, 'home'), DS_RESULT: path.join(tmp, 'result.json') };
  for (const k of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|VSCODE_)/.test(k)) delete env[k];
  const init = spawnSync(process.execPath, [path.join(root, 'bin', 'devsarathi.js'), 'init', '--yes', '--persona', 'Asha', '--skip-hooks', '-C', repo], { env, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);

  const userData = path.join(tmp, 'data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({ 'devsarathi.cliPath': path.join(root, 'bin', 'devsarathi.js'), 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none' })
  );
  for (const k of Object.keys(process.env)) if (/^(ELECTRON_RUN_AS_NODE|VSCODE_)/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  await runTests({
    extensionDevelopmentPath: path.join(root, 'packages', 'vscode'),
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [repo, '--user-data-dir', userData, '--extensions-dir', path.join(tmp, 'ext'), '--disable-gpu', '--disable-workspace-trust'],
    extensionTestsEnv: env
  });
  const result = JSON.parse(fs.readFileSync(env.DS_RESULT, 'utf8'));
  for (const s of result.steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}${s.ok || !s.detail ? '' : `\n      ${s.detail}`}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
