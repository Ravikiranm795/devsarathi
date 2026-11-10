import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  StageLineParser,
  StageTracker,
  parseStageLine,
  renderTrail,
  parseCliResult,
  redactSecrets,
  resolveInvocation,
  buildArgv,
  errorFromStderr,
  parseDashboardLine,
  INIT_STAGES,
  ResolveDeps
} from '../src/cli';

describe('stage lines', () => {
  it('parses `[Stage] message` exactly as the CLI writes it', () => {
    expect(parseStageLine('[Building graph] this runs in the background and has no time cap')).toEqual({ stage: 'Building graph', message: 'this runs in the background and has no time cap' });
    expect(parseStageLine('[Generating rules]')).toEqual({ stage: 'Generating rules', message: '' });
    expect(parseStageLine('[Scanning] detected Angular\r')).toEqual({ stage: 'Scanning', message: 'detected Angular' });
  });

  it('ignores lines that are not stages', () => {
    expect(parseStageLine('Read-only, bound to 127.0.0.1. Press Ctrl+C to stop.')).toBeUndefined();
    expect(parseStageLine('    + .claude/rules/ds-angular.md')).toBeUndefined();
    expect(parseStageLine('[devsarathi] pre-push did not run: boom')).toBeUndefined(); // fail-open hook prefix
    expect(parseStageLine('')).toBeUndefined();
  });

  it('handles realistic stderr chunks that split lines anywhere', () => {
    const p = new StageLineParser();
    const events = [
      ...p.feed('[Scanning] preflight che'),
      ...p.feed('cks\n[Scanning] detected Angular\n\nFiles DevSarathi will create:\n  + a.md\n[Build'),
      ...p.feed('ing graph] this runs in the back'),
      ...p.feed('ground\r\n[Generating rules]\n[Generating agents'),
      ...p.feed(']\n[Installing hooks]'), // last line has no newline yet
      ...p.flush()
    ];
    expect(events.map((e) => e.stage)).toEqual(['Scanning', 'Scanning', 'Building graph', 'Generating rules', 'Generating agents', 'Installing hooks']);
    expect(events[0].message).toBe('preflight checks');
    expect(events[2].message).toBe('this runs in the background');
  });

  it('does not grow without bound on a stream with no newlines', () => {
    const p = new StageLineParser();
    for (let i = 0; i < 40; i++) p.feed('x'.repeat(4096));
    expect(p.feed('\n[Scanning] ok\n')).toEqual([{ stage: 'Scanning', message: 'ok' }]);
  });
});

describe('stage trail', () => {
  it('walks Scanning -> ... -> Auditing for init', () => {
    const t = new StageTracker(INIT_STAGES);
    expect(t.trail().every((s) => s.state === 'pending')).toBe(true);
    t.update({ stage: 'Scanning', message: 'x' });
    t.update({ stage: 'Building graph', message: 'big repo' });
    const v = t.trail();
    expect(v.map((s) => s.state)).toEqual(['done', 'active', 'pending', 'pending', 'pending', 'pending']);
    expect(t.currentMessage).toBe('big repo');
    expect(renderTrail(v, t.currentMessage)).toBe('Scanning ✓ › ▸ Building graph › Generating rules › Generating agents › Installing hooks › Auditing — big repo');
    t.finish();
    expect(t.trail().every((s) => s.state === 'done')).toBe(true);
  });

  it('adds unplanned stages as they appear and never moves backwards', () => {
    const t = new StageTracker();
    t.update({ stage: 'Gathering context', message: 'searching the graph' });
    t.update({ stage: 'Testing', message: '' });
    t.update({ stage: 'Gathering context', message: 'again' });
    expect(t.trail().map((s) => `${s.name}:${s.state}`)).toEqual(['Gathering context:done', 'Testing:active']);
  });
});

describe('JSON result', () => {
  it('parses the CLI --json output', () => {
    const out = JSON.stringify({ ok: true, message: 'hi', data: { a: 1 }, exitCode: 0 }, null, 2);
    expect(parseCliResult(out)).toEqual({ ok: true, message: 'hi', data: { a: 1 }, exitCode: 0 });
  });
  it('tolerates a stray line before the document', () => {
    expect(parseCliResult('(node:1) ExperimentalWarning: x\n{"ok":false,"message":"nope"}')?.ok).toBe(false);
  });
  it('rejects things that are not results', () => {
    expect(parseCliResult('')).toBeUndefined();
    expect(parseCliResult('not json')).toBeUndefined();
    expect(parseCliResult('{"foo":1}')).toBeUndefined();
    expect(parseCliResult('[1,2]')).toBeUndefined();
  });
});

describe('redaction and error text', () => {
  it('masks secret-looking values', () => {
    const r = redactSecrets('failed: api_key=abcd1234efgh5678 and token: ghp_abcdefghijklmnopqrstuvwxyz0123 and Authorization: Bearer abc.def.ghi-123');
    expect(r).not.toContain('abcd1234efgh5678');
    expect(r).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(r).not.toContain('abc.def.ghi-123');
  });
  it('takes the last meaningful stderr lines and drops stage lines and the command prefix', () => {
    const stderr = '[Gathering context] searching\ndevsarathi enhance: DevSarathi is not initialized in this repo. Run: devsarathi init\n';
    expect(errorFromStderr(stderr, ['enhance'])).toBe('DevSarathi is not initialized in this repo. Run: devsarathi init');
    expect(errorFromStderr("error: unknown command 'skills'\n", ['skills'])).toBe("unknown command 'skills'");
    expect(errorFromStderr('[Scanning] x\n', ['init'])).toBe('');
  });
});

describe('argv', () => {
  it('uses an argument array with --flag=value, --path and a -- before positionals', () => {
    expect(buildArgv({ command: ['enhance'], flags: ['--spec=specs/a b.md'], positionals: ['-rm -rf; "x"'] }, 'C:\\my repo')).toEqual([
      'enhance',
      '--spec=specs/a b.md',
      '--path=C:\\my repo',
      '--json',
      '--',
      '-rm -rf; "x"'
    ]);
    expect(buildArgv({ command: ['rules', 'approve'], positionals: ['ab12cd34'] }, '/r', false)).toEqual(['rules', 'approve', '--path=/r', '--', 'ab12cd34']);
  });
});

describe('finding the CLI', () => {
  const win = (files: Record<string, string>, pathEnv = 'C:\\Users\\me\\AppData\\Roaming\\npm'): ResolveDeps => ({
    platform: 'win32',
    pathEnv,
    exists: (f) => f in files,
    readFile: (f) => files[f],
    execPath: 'C:\\Code\\Code.exe'
  });
  const dir = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const shim = '"%_prog%"  "%dp0%\\node_modules\\@ravikiranm\\dev-sarathi\\bin\\devsarathi.js" %*';

  it('resolves the npm .cmd shim to node + the .js entry (no shell)', () => {
    const cmd = path.join(dir, 'devsarathi.cmd');
    const r = resolveInvocation('devsarathi', win({ [cmd]: shim }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.invocation.command).toBe('node');
    expect(r.invocation.prefixArgs).toEqual([path.join(dir, 'node_modules', '@ravikiranm', 'dev-sarathi', 'bin', 'devsarathi.js')]);
    expect(r.invocation.fallback?.command).toBe('C:\\Code\\Code.exe');
    expect(r.invocation.fallback?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('prefers the node.exe that npm put beside the shim', () => {
    const cmd = path.join(dir, 'devsarathi.cmd');
    const r = resolveInvocation('devsarathi', win({ [cmd]: shim, [path.join(dir, 'node.exe')]: '' }));
    expect(r.ok && r.invocation.command).toBe(path.join(dir, 'node.exe'));
  });

  it('runs a configured .js path with node', () => {
    const r = resolveInvocation('D:\\AI-devSarathi\\bin\\devsarathi.js', win({ 'D:\\AI-devSarathi\\bin\\devsarathi.js': '' }));
    expect(r.ok && r.invocation.prefixArgs).toEqual(['D:\\AI-devSarathi\\bin\\devsarathi.js']);
  });

  it('says clearly when it is not found or the shim cannot be understood', () => {
    const missing = resolveInvocation('devsarathi', win({}));
    expect(!missing.ok && missing.error).toMatch(/was not found.*devsarathi\.cliPath/);
    const cmd = path.join(dir, 'devsarathi.cmd');
    const odd = resolveInvocation('devsarathi', win({ [cmd]: '@echo hi' }));
    expect(!odd.ok && odd.error).toMatch(/devsarathi\.cliPath/);
  });

  it('on other platforms spawns the command directly', () => {
    const r = resolveInvocation('devsarathi', { ...win({}), platform: 'linux' });
    expect(r).toEqual({ ok: true, invocation: { command: 'devsarathi', prefixArgs: [] } });
  });
});

describe('dashboard address', () => {
  it('accepts only http://127.0.0.1:<port>', () => {
    expect(parseDashboardLine('Dashboard: http://127.0.0.1:51234/?t=abc123')).toBe('http://127.0.0.1:51234/?t=abc123');
    expect(parseDashboardLine('Dashboard: http://localhost:51234/')).toBeUndefined();
    expect(parseDashboardLine('Dashboard: https://127.0.0.1:51234/')).toBeUndefined();
    expect(parseDashboardLine('Dashboard: http://127.0.0.1/')).toBeUndefined();
    expect(parseDashboardLine('Dashboard: http://evil.example/')).toBeUndefined();
    expect(parseDashboardLine('Dashboard: http://u:p@127.0.0.1:1/')).toBeUndefined();
    expect(parseDashboardLine('something else')).toBeUndefined();
  });
});
