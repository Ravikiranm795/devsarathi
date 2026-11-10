import { spawn } from 'child_process';

/**
 * The one way DevSarathi talks to a model (D-17 and its second, opt-in use D-DEV-22): the Claude Code CLI in headless mode.
 * `tools` is the exact tool allow-list; an empty string disables every tool. The prompt goes in on stdin, so its length
 * and content never touch a command line. Arguments are fixed strings: nothing user-supplied reaches a shell.
 */
export function runClaude(prompt: string, tools: string, opts: { timeoutMs?: number; label?: string } = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  // `--tools=` (with an equals sign) is the form that survives every shell: a bare empty argument is dropped on Windows.
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', `--tools=${tools}`];

  const attempt = (useShell: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn('claude', args, { windowsHide: true, shell: useShell });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${opts.label ?? 'Claude'} did not answer within ${Math.round(timeoutMs / 60000)} minutes`));
      }, timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        const code = (e as NodeJS.ErrnoException).code;
        // claude.exe resolves without a shell; an npm-style claude.cmd shim needs one.
        if (code === 'ENOENT' && !useShell && process.platform === 'win32') return attempt(true).then(resolve, reject);
        reject(new Error(`could not start the Claude CLI (${e.message}). Install Claude Code and sign in, then try again`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`the Claude CLI exited with ${code}: ${(err || out).trim().slice(0, 300)}`));
        try {
          const env = JSON.parse(out) as { result?: string; is_error?: boolean };
          if (env.is_error) throw new Error(String(env.result ?? 'the Claude CLI reported an error'));
          resolve(String(env.result ?? out));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      child.stdin.end(prompt);
    });

  return attempt(false);
}
