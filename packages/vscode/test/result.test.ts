import { describe, it, expect } from 'vitest';
import { evaluate, cleanError, commandLabel, didNotRun } from '../src/result';
import { CliOutcome } from '../src/cli';

const result = (ok: boolean, message: string, data?: unknown): CliOutcome => ({ status: 'result', result: { ok, message, data }, exitCode: ok ? 0 : 1, stderrTail: '' });

describe('failure messages (I-4, D-13)', () => {
  it('names the agent for review/test and the command for the rest', () => {
    expect(commandLabel(['test'])).toBe('ds-tester');
    expect(commandLabel(['review'])).toBe('Review');
    expect(commandLabel(['graph', 'build'])).toBe('devsarathi graph build');
  });

  it('cleans a redundant prefix from core messages', () => {
    expect(cleanError('Review did not run: git exploded\nmore')).toBe('git exploded');
    expect(cleanError('ds-tester did not run: no test command')).toBe('no test command');
    expect(cleanError('')).toBe('unknown error');
  });

  it('a crashed command (no JSON) is "did not run", never a pass', () => {
    const v = evaluate({ command: ['review'] }, { status: 'failed', error: 'DevSarathi is not initialized', exitCode: 1, stderrTail: '' });
    expect(v).toMatchObject({ kind: 'not-run', text: 'Review did not run: DevSarathi is not initialized' });
  });

  it('a missing CLI is "did not run" with the reason', () => {
    const v = evaluate({ command: ['graph', 'build'] }, { status: 'unavailable', error: '"devsarathi" was not found.' });
    expect(v.kind).toBe('not-run');
    expect(v.kind === 'not-run' && v.text).toBe('devsarathi graph build did not run: "devsarathi" was not found.');
  });

  it('review: a failed or timed-out agent run is not a pass even though the command returned ok', () => {
    const data = {
      verdict: 'incomplete',
      runs: [
        { agent: 'security', status: 'completed', findings: [] },
        { agent: 'peer-review', status: 'failed', error: 'diff too large', findings: [] },
        { agent: 'tester', status: 'timeout', findings: [] }
      ]
    };
    const v = evaluate({ command: ['review'] }, result(true, 'x', data));
    expect(v.kind).toBe('not-run');
    expect(v.kind === 'not-run' && v.text.split('\n')).toEqual(['ds-peer-review did not run: diff too large', 'ds-tester did not run: timeout']);
  });

  it('review: incomplete without an error is still not a pass', () => {
    const v = evaluate({ command: ['review'] }, result(true, 'x', { verdict: 'incomplete', runs: [{ agent: 'security', status: 'skipped', error: 'agent off', findings: [] }] }));
    expect(v.kind).toBe('not-run');
  });

  it('review: findings are problems, clean is ok', () => {
    const f = evaluate({ command: ['review'] }, result(true, 'x', { verdict: 'findings', runs: [{ agent: 'security', status: 'completed', findings: [{}, {}] }] }));
    expect(f).toEqual({ kind: 'problems', text: 'Review found 2 findings.' });
    expect(evaluate({ command: ['review'] }, result(true, 'all good', { verdict: 'clean', runs: [] })).kind).toBe('ok');
  });

  it('test: run not completed or incomplete is not-run; failing tests are problems', () => {
    expect(evaluate({ command: ['test'] }, result(false, 'ds-tester: INCOMPLETE', { status: 'incomplete', run: { status: 'failed', error: 'no test command' } }))).toMatchObject({ kind: 'not-run', text: 'ds-tester did not run: no test command' });
    expect(evaluate({ command: ['test'] }, result(false, 'ds-tester: FAIL\n  failed: a', { status: 'fail', run: { status: 'completed' } })).kind).toBe('problems');
    expect(evaluate({ command: ['test'] }, result(true, 'ds-tester: PASS', { status: 'pass', run: { status: 'completed' } })).kind).toBe('ok');
  });

  it('generic: ok false is not-run; a failed run record is not-run even when ok', () => {
    expect(evaluate({ command: ['rules', 'approve'] }, result(false, 'No pending change "x".')).kind).toBe('not-run');
    expect(evaluate({ command: ['graph', 'build'] }, result(true, 'Graph build', { status: 'failed', error: 'parser crashed' }))).toMatchObject({ kind: 'not-run', text: 'devsarathi graph build did not run: parser crashed' });
    expect(evaluate({ command: ['selftest'] }, result(false, 'missed 2 planted problems')).kind).toBe('problems');
    expect(evaluate({ command: ['status'] }, result(true, 'DevSarathi v0.1.0')).kind).toBe('ok');
  });

  it('cancelled is neither ok nor a failure', () => {
    expect(evaluate({ command: ['review'] }, { status: 'cancelled' }).kind).toBe('cancelled');
  });

  it('didNotRun has the exact required shape', () => {
    expect(didNotRun({ label: 'ds-security', error: 'e' })).toBe('ds-security did not run: e');
  });
});
