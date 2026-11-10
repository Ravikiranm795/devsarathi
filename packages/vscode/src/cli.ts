import { spawn, ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';

/*
 * The only way the extension touches DevSarathi: spawn the `devsarathi` CLI with an argument ARRAY (never a shell
 * string, MASTER 4.1/4.2), read its `--json` result from stdout and its staged progress from stderr. No business
 * logic lives here and there is no time cap (D-14).
 */

// ---------------------------------------------------------------------------------------------------------------------
// Stage lines: the CLI prints `[Stage] message` to stderr for every progress step (packages/cli/src/index.ts).
// ---------------------------------------------------------------------------------------------------------------------

export interface StageEvent {
  stage: string;
  message: string;
}

/** The init stages in order (MASTER 17). Other stages (Gathering context, Testing, Self-test...) are shown as they appear. */
export const INIT_STAGES = ['Scanning', 'Building graph', 'Generating rules', 'Generating agents', 'Installing hooks', 'Auditing'];

const STAGE_RE = /^\[([^\][\r\n]{1,60})\]\s?(.*)$/;
/** `[devsarathi] ...` is the fail-open hook prefix, not a progress stage. */
const NOT_STAGES = new Set(['devsarathi']);

export function parseStageLine(line: string): StageEvent | undefined {
  const m = STAGE_RE.exec(line.replace(/\r$/, ''));
  if (!m || NOT_STAGES.has(m[1].trim().toLowerCase())) return undefined;
  return { stage: m[1].trim(), message: m[2].trim() };
}

/** Turns arbitrary stderr chunks (which can split a line anywhere) into whole-line stage events. */
export class StageLineParser {
  private buf = '';

  feed(chunk: string): StageEvent[] {
    this.buf += chunk;
    const out: StageEvent[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const ev = parseStageLine(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
      if (ev) out.push(ev);
    }
    // A pathological stream without newlines must not grow without bound.
    if (this.buf.length > 64 * 1024) this.buf = this.buf.slice(-4096);
    return out;
  }

  /** At end of stream a final line may lack its newline. */
  flush(): StageEvent[] {
    const ev = parseStageLine(this.buf);
    this.buf = '';
    return ev ? [ev] : [];
  }
}

export interface StageView {
  name: string;
  state: 'done' | 'active' | 'pending';
  message?: string;
}

/** Keeps the trail Scanning -> Building graph -> ... for the progress notification. */
export class StageTracker {
  private stages: string[];
  private active = -1;
  private messages = new Map<string, string>();
  private finished = false;

  constructor(planned: string[] = []) {
    this.stages = [...planned];
  }

  update(ev: StageEvent): void {
    let idx = this.stages.indexOf(ev.stage);
    if (idx < 0) {
      this.stages.push(ev.stage);
      idx = this.stages.length - 1;
    }
    if (ev.message) this.messages.set(ev.stage, ev.message);
    // A stage that was already passed does not move the trail backwards: later stages stay as they were.
    if (idx >= this.active) this.active = idx;
  }

  finish(): void {
    this.finished = true;
  }

  get currentMessage(): string {
    return this.active >= 0 ? this.messages.get(this.stages[this.active]) ?? '' : '';
  }

  trail(): StageView[] {
    return this.stages.map((name, i) => ({
      name,
      message: this.messages.get(name),
      state: this.finished || i < this.active ? 'done' : i === this.active ? 'active' : 'pending'
    }));
  }
}

/** Plain-text stage list for a notification: `Scanning ✓ › ▸ Building graph › Generating rules — message`. */
export function renderTrail(views: StageView[], tail = ''): string {
  if (views.length === 0) return tail;
  const parts = views.map((v) => (v.state === 'done' ? `${v.name} ✓` : v.state === 'active' ? `▸ ${v.name}` : v.name));
  return tail ? `${parts.join(' › ')} — ${tail}` : parts.join(' › ');
}

// ---------------------------------------------------------------------------------------------------------------------
// The JSON result: `{ ok, message, data, exitCode }`.
// ---------------------------------------------------------------------------------------------------------------------

export interface CliResult {
  ok: boolean;
  message: string;
  data?: unknown;
  exitCode?: number;
}

function asResult(v: unknown): CliResult | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.ok !== 'boolean') return undefined;
  return { ok: o.ok, message: typeof o.message === 'string' ? o.message : '', data: o.data, exitCode: typeof o.exitCode === 'number' ? o.exitCode : undefined };
}

/** stdout should be exactly one JSON document; tolerate stray lines around it (a warning printed by a dependency). */
export function parseCliResult(stdout: string): CliResult | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    const r = asResult(JSON.parse(text));
    if (r) return r;
  } catch {
    /* fall through to the tolerant scan */
  }
  const first = text.indexOf('\n{');
  const start = text.startsWith('{') ? 0 : first >= 0 ? first + 1 : -1;
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return asResult(JSON.parse(text.slice(start, end + 1)));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Best-effort masking for text that may reach a notification. Core already redacts; this is a second belt. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(api[_-]?key|token|secret|password|passwd|authorization)(\s*[:=]\s*|\s+)(bearer\s+)?[^\s"',;]{6,}/gi, (_m, k: string, sep: string) => `${k}${sep}[redacted]`)
    .replace(/\b(sk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]');
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding the CLI. On Windows npm installs `devsarathi.cmd`, which Node cannot spawn without a shell (CVE-2024-27980
// made that an error). Instead of `shell: true` we read the shim, take the .js entry it points at and run it with node.
// ---------------------------------------------------------------------------------------------------------------------

export interface Invocation {
  command: string;
  prefixArgs: string[];
  env?: Record<string, string>;
  /** Used when `command` cannot be started (e.g. no `node` on PATH). */
  fallback?: Invocation;
}

export interface ResolveDeps {
  platform: NodeJS.Platform;
  pathEnv: string;
  exists(file: string): boolean;
  readFile(file: string): string;
  execPath: string;
}

export const realResolveDeps = (): ResolveDeps => ({
  platform: process.platform,
  pathEnv: process.env.PATH ?? process.env.Path ?? '',
  exists: (f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  },
  readFile: (f) => fs.readFileSync(f, 'utf8'),
  execPath: process.execPath
});

function scriptInvocation(script: string, deps: ResolveDeps, nodeBesideShim?: string): Invocation {
  // VS Code 1.85 ships Node 18 but DevSarathi needs Node 20+, so prefer a real `node` and keep the host binary
  // (ELECTRON_RUN_AS_NODE) only as a last resort.
  return {
    command: nodeBesideShim ?? 'node',
    prefixArgs: [script],
    fallback: { command: deps.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: '1' } }
  };
}

export type Resolved = { ok: true; invocation: Invocation } | { ok: false; error: string };

export function resolveInvocation(cliPath: string, deps: ResolveDeps = realResolveDeps()): Resolved {
  const configured = (cliPath || '').trim() || 'devsarathi';
  const win = deps.platform === 'win32';
  const sep = win ? /[\\/]/ : /\//;
  let file = configured;

  if (!sep.test(configured)) {
    if (!win) return { ok: true, invocation: { command: configured, prefixArgs: [] } }; // ENOENT is mapped to a clear message
    const found = findOnPath(configured, deps);
    if (!found) return { ok: false, error: notFound(configured) };
    file = found;
  } else if (win && !deps.exists(file)) {
    const withExt = ['.cmd', '.exe'].map((e) => file + e).find((f) => deps.exists(f));
    if (!withExt) return { ok: false, error: notFound(configured) };
    file = withExt;
  }

  const ext = path.extname(file).toLowerCase();
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return { ok: true, invocation: scriptInvocation(file, deps) };
  if (win && (ext === '.cmd' || ext === '.bat')) {
    let body = '';
    try {
      body = deps.readFile(file);
    } catch {
      return { ok: false, error: `Could not read ${file}. Set devsarathi.cliPath to the path of bin/devsarathi.js.` };
    }
    const m = /"%dp0%[\\/]*([^"]+?\.(?:c|m)?js)"/i.exec(body) ?? /"%~dp0[\\/]*([^"]+?\.(?:c|m)?js)"/i.exec(body);
    if (!m) return { ok: false, error: `Could not find the script behind ${file}. Set devsarathi.cliPath to the path of bin/devsarathi.js.` };
    const dir = path.dirname(file);
    const script = path.join(dir, ...m[1].split(/[\\/]/));
    const bundledNode = path.join(dir, 'node.exe');
    return { ok: true, invocation: scriptInvocation(script, deps, deps.exists(bundledNode) ? bundledNode : undefined) };
  }
  if (win && ext === '.ps1') return { ok: false, error: 'devsarathi.cliPath cannot be a .ps1 script. Point it at devsarathi.cmd or bin/devsarathi.js.' };
  return { ok: true, invocation: { command: file, prefixArgs: [] } };
}

function notFound(name: string): string {
  return `"${name}" was not found. Install it with: npm i -g @ravikiranm795/dev-sarathi, or set the setting devsarathi.cliPath to the devsarathi executable or bin/devsarathi.js.`;
}

function findOnPath(name: string, deps: ResolveDeps): string | undefined {
  const names = [`${name}.cmd`, `${name}.exe`, name];
  for (const dir of deps.pathEnv.split(';').filter(Boolean)) {
    for (const n of names) {
      const f = path.join(dir.replace(/^"|"$/g, ''), n);
      if (deps.exists(f)) return f;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Running a command.
// ---------------------------------------------------------------------------------------------------------------------

/** One invocation, kept as data so Rerun can run exactly the same thing again. */
export interface RunSpec {
  /** Command words, e.g. ['rules', 'approve'] or ['graph', 'build']. */
  command: string[];
  /** Flags in `--name=value` form (a value starting with `-` can never be read as another option). */
  flags?: string[];
  /** Bare words, passed after `--`. */
  positionals?: string[];
}

export function buildArgv(spec: RunSpec, root: string, json = true): string[] {
  const argv = [...spec.command, ...(spec.flags ?? []), `--path=${root}`];
  if (json) argv.push('--json');
  if (spec.positionals?.length) argv.push('--', ...spec.positionals);
  return argv;
}

export type CliOutcome =
  | { status: 'result'; result: CliResult; exitCode: number | null; stderrTail: string }
  | { status: 'failed'; error: string; exitCode: number | null; stderrTail: string }
  | { status: 'unavailable'; error: string }
  | { status: 'cancelled' };

export interface StartOptions {
  cliPath: string;
  root: string;
  spec: RunSpec;
  onStage?: (ev: StageEvent) => void;
  /** Overrides, for tests. */
  deps?: ResolveDeps;
  env?: NodeJS.ProcessEnv;
}

export interface CliRun {
  promise: Promise<CliOutcome>;
  cancel(): void;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // The CLI may have started test runners or git; a plain kill would leave them running.
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    k.on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
  }
}

const TAIL_BYTES = 8 * 1024;
const keepTail = (s: string): string => (s.length > TAIL_BYTES ? s.slice(-TAIL_BYTES) : s);

/** Last meaningful non-stage stderr lines: what the CLI said when it crashed or rejected the arguments. */
export function errorFromStderr(stderr: string, command: string[]): string {
  const prefix = new RegExp(`^devsarathi\\s+${command.join(' ')}:\\s*`, 'i');
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !parseStageLine(l));
  if (!lines.length) return '';
  return redactSecrets(lines.slice(-3).join(' ').replace(prefix, '').replace(/^error:\s*/i, ''));
}

export function startCli(opts: StartOptions): CliRun {
  const resolved = resolveInvocation(opts.cliPath, opts.deps);
  if (!resolved.ok) return { promise: Promise.resolve({ status: 'unavailable', error: resolved.error }), cancel: () => undefined };

  let cancelled = false;
  let current: ChildProcess | undefined;
  const argv = buildArgv(opts.spec, opts.root);

  const attempt = (inv: Invocation): Promise<CliOutcome> =>
    new Promise<CliOutcome>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(inv.command, [...inv.prefixArgs, ...argv], {
          cwd: opts.root,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...opts.env, ...inv.env, NO_COLOR: '1' }
        });
      } catch (err) {
        resolve({ status: 'unavailable', error: `Could not start "${opts.cliPath}": ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      current = child;
      const parser = new StageLineParser();
      const outDec = new StringDecoder('utf8');
      const errDec = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let settled = false;
      let handedOff = false;
      const done = (o: CliOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(o);
      };
      child.stdout?.on('data', (b: Buffer) => {
        stdout += outDec.write(b);
      });
      child.stderr?.on('data', (b: Buffer) => {
        const text = errDec.write(b);
        stderr = keepTail(stderr + text);
        for (const ev of parser.feed(text)) opts.onStage?.(ev);
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' && inv.fallback && !cancelled) {
          handedOff = true; // the failed spawn may still emit 'close'; the fallback's outcome is the one that counts
          void attempt(inv.fallback).then(done);
          return;
        }
        const why = err.code === 'ENOENT' ? notFound(opts.cliPath) : `Could not start "${opts.cliPath}": ${err.message}`;
        done({ status: 'unavailable', error: why });
      });
      child.on('close', (code) => {
        if (handedOff) return;
        stdout += outDec.end();
        stderr += errDec.end();
        for (const ev of parser.flush()) opts.onStage?.(ev);
        if (cancelled) return done({ status: 'cancelled' });
        const tail = redactSecrets(stderr);
        const result = parseCliResult(stdout);
        if (result) {
          // I-4: a non-zero exit with an "ok" body is a failure, never a pass.
          if (code !== 0 && result.ok) return done({ status: 'failed', error: `the command exited with code ${code}`, exitCode: code, stderrTail: tail });
          return done({ status: 'result', result, exitCode: code, stderrTail: tail });
        }
        const said = errorFromStderr(stderr, opts.spec.command);
        done({ status: 'failed', error: said || (code === 0 ? 'the command printed no result' : `the command exited with code ${code} and no message`), exitCode: code, stderrTail: tail });
      });
    });

  return {
    promise: attempt(resolved.invocation),
    cancel: () => {
      cancelled = true;
      if (current) killTree(current);
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Long-lived child: `devsarathi dashboard --no-open` (MASTER 18).
// ---------------------------------------------------------------------------------------------------------------------

/** Accepts only `Dashboard: http://127.0.0.1:<port>/...`: the iframe must never point anywhere else. */
export function parseDashboardLine(line: string): string | undefined {
  const m = /^Dashboard:\s*(\S+)\s*$/.exec(line.trim());
  if (!m) return undefined;
  try {
    const u = new URL(m[1]);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export interface LongLived {
  /** Resolves with the URL, or rejects with why the process ended first. */
  ready: Promise<string>;
  kill(): void;
}

export function startDashboardProcess(opts: Pick<StartOptions, 'cliPath' | 'root' | 'deps' | 'env'>): LongLived {
  const resolved = resolveInvocation(opts.cliPath, opts.deps);
  if (!resolved.ok) return { ready: Promise.reject(new Error(resolved.error)), kill: () => undefined };
  const argv = buildArgv({ command: ['dashboard'], flags: ['--no-open'] }, opts.root, false);
  let child: ChildProcess | undefined;
  let killed = false;
  const ready = new Promise<string>((resolve, reject) => {
    const launch = (inv: Invocation): void => {
      const c = spawn(inv.command, [...inv.prefixArgs, ...argv], { cwd: opts.root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...opts.env, ...inv.env, NO_COLOR: '1' } });
      child = c;
      let buf = '';
      let err = '';
      let got = false;
      c.stdout?.setEncoding('utf8');
      c.stdout?.on('data', (s: string) => {
        if (got) return;
        buf += s;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const url = parseDashboardLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (url) {
            got = true;
            resolve(url);
            return;
          }
        }
      });
      c.stderr?.setEncoding('utf8');
      c.stderr?.on('data', (s: string) => {
        err = keepTail(err + s);
      });
      c.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT' && inv.fallback && !killed) return launch(inv.fallback);
        reject(new Error(e.code === 'ENOENT' ? notFound(opts.cliPath) : e.message));
      });
      c.on('close', (code) => {
        if (!got) reject(new Error(errorFromStderr(err, ['dashboard']) || `the dashboard process exited with code ${code} before it printed its address`));
      });
    };
    launch(resolved.invocation);
  });
  return {
    ready,
    kill: () => {
      killed = true;
      if (child) killTree(child);
    }
  };
}
