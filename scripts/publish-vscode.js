'use strict';
// Publishes the DevSarathi extension to the Visual Studio Marketplace. YOU run this in your own terminal:
// the access token is typed into vsce's own prompt (or read from VSCE_PAT), never passed through a chat or a file.
//
//   node scripts/publish-vscode.js --dry-run     check everything and build the .vsix, publish nothing
//   node scripts/publish-vscode.js               check, ask for a final yes, log in, publish
//   node scripts/publish-vscode.js --pre-release publish as a pre-release version
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'packages', 'vscode');
const vsix = path.join(ext, 'devsarathi.vsix');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const pre = args.includes('--pre-release');

const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const problems = [];
const note = (ok, msg) => console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`) || (ok ? 0 : problems.push(msg));

note(!!manifest.publisher && /^[a-z0-9][a-z0-9-]*$/i.test(manifest.publisher), `publisher is "${manifest.publisher}" (it must be a publisher you created at marketplace.visualstudio.com/manage)`);
note(/^\d+\.\d+\.\d+$/.test(manifest.version), `version ${manifest.version}`);
note(manifest.private !== true, 'the extension is not marked private');
note(fs.existsSync(path.join(ext, 'media', 'icon.png')) && manifest.icon === 'media/icon.png', 'icon present');
note(fs.existsSync(path.join(ext, 'LICENSE.txt')), 'LICENSE.txt present');
note(fs.existsSync(path.join(ext, 'README.md')) && fs.existsSync(path.join(ext, 'CHANGELOG.md')), 'README.md and CHANGELOG.md present');
note(manifest.engines && /^\^?\d+\.\d+\.\d+$/.test(manifest.engines.vscode), `engines.vscode ${manifest.engines && manifest.engines.vscode}`);
note(fs.existsSync(path.join(ext, 'dist', 'extension.js')), 'compiled dist/extension.js present (run: npm run build)');

const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts });

if (problems.length) {
  console.error(`\nFix ${problems.length} problem(s) above, then run this again.`);
  process.exit(1);
}

console.log('\nBuilding the .vsix with the official packager ...');
if (run('node', [path.join('scripts', 'build-vsix.js')]).status !== 0) process.exit(1);

if (dry) {
  console.log(`\nDry run complete. Nothing was published. Package: ${path.relative(root, vsix)}`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question(`\nPublish ${manifest.publisher}.${manifest.name} ${manifest.version}${pre ? ' (pre-release)' : ''} to the PUBLIC Marketplace? Type "publish" to continue: `, (answer) => {
  rl.close();
  if (answer.trim() !== 'publish') {
    console.log('Cancelled. Nothing was published.');
    process.exit(0);
  }
  if (!process.env.VSCE_PAT) {
    console.log(`\nLogging in as "${manifest.publisher}". Paste your Azure DevOps personal access token (Marketplace > Manage) when vsce asks.`);
    if (run('npx', ['vsce', 'login', manifest.publisher]).status !== 0) process.exit(1);
  }
  const publish = ['vsce', 'publish', '--packagePath', vsix, ...(pre ? ['--pre-release'] : [])];
  const r = run('npx', publish);
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(`\nPublished. The listing appears at https://marketplace.visualstudio.com/items?itemName=${manifest.publisher}.${manifest.name} within a few minutes (it is scanned first).`);
});
