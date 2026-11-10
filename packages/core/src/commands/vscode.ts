import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { registerCommand, CommandDef } from '../registry';

const VSIX = path.resolve(__dirname, '..', '..', '..', 'vscode', 'devsarathi.vsix');

/**
 * `devsarathi vscode install`: install the extension that ships inside this package, using the editor's own CLI.
 * The extension is mandatory for the team (D-25) and teammates only have npm, so it travels with the package.
 */
const install: CommandDef = {
  name: 'vscode install',
  description: 'Install the DevSarathi VS Code extension that ships with this package',
  args: [
    { name: 'editor', type: 'string', description: 'Editor CLI to use: code (default), code-insiders or cursor' },
    { name: 'print', type: 'boolean', description: 'Only print the path of the .vsix' }
  ],
  async run(_ctx, args) {
    if (!fs.existsSync(VSIX)) return { ok: false, message: `The extension package was not found at ${VSIX}. Reinstall DevSarathi, or build it with: npm run build:vsix`, exitCode: 1 };
    if (args.print) return { ok: true, message: VSIX };
    const editor = String(args.editor ?? 'code');
    if (!['code', 'code-insiders', 'cursor'].includes(editor)) return { ok: false, message: 'editor must be code, code-insiders or cursor', exitCode: 2 };
    // `editor` is one of three fixed names and VSIX is our own install path: nothing user-supplied reaches the shell.
    const r =
      process.platform === 'win32'
        ? spawnSync('cmd', ['/d', '/s', '/c', `${editor} --install-extension "${VSIX}" --force`], { encoding: 'utf8', windowsVerbatimArguments: true })
        : spawnSync(editor, ['--install-extension', VSIX, '--force'], { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (r.error || r.status !== 0) {
      return { ok: false, message: `Could not install with "${editor}": ${r.error ? r.error.message : out || `exit ${r.status}`}\nInstall by hand: ${editor} --install-extension "${VSIX}"`, exitCode: 1 };
    }
    return { ok: true, message: `${out || 'Installed.'}\nReload VS Code to activate the DevSarathi extension.` };
  }
};

registerCommand(install);
