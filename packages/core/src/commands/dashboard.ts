import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { registerCommand, CommandDef } from '../registry';

const DIST = path.resolve(__dirname, '..', '..', '..', 'dashboard', 'dist', 'index.js');

function openBrowser(url: string): void {
  // `url` is built by the dashboard from 127.0.0.1, a port and a hex token: nothing user-supplied reaches the shell.
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Starts the local dashboard (MASTER 18): 127.0.0.1 only, random port, per-session token, read-only. Commands are never
 * run from the website; they run from the terminal, Claude chat or the VS Code extension.
 */
const dashboard: CommandDef = {
  name: 'dashboard',
  description: 'Open the local dashboard website (127.0.0.1 only, read-only). Runs until you press Ctrl+C',
  args: [
    { name: 'noOpen', type: 'boolean', description: 'Print the address but do not open a browser' },
    { name: 'port', type: 'number', description: 'Fixed port (default: a random free port)' }
  ],
  async run(ctx, args) {
    if (!fs.existsSync(DIST)) return { ok: false, message: 'The dashboard is not built in this install. Rebuild with: npm run build', exitCode: 1 };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(DIST) as { startDashboard(o: Record<string, unknown>): Promise<{ url: string; close(): Promise<void> }> };
    const srv = await mod.startDashboard({ port: args.port, focusRepo: ctx.repoRoot });
    process.stdout.write(`Dashboard: ${srv.url}\n`);
    process.stderr.write('Read-only, bound to 127.0.0.1. Press Ctrl+C to stop.\n');
    if (!args.noOpen) openBrowser(srv.url);
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await srv.close();
    return { ok: true, message: 'Dashboard stopped.' };
  }
};

registerCommand(dashboard);
