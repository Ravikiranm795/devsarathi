import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readNewNotices, endOfFile, parseNoticeLine, NoticeDeduper, noticeSeverity, noticeToRerun, NoticeSuppressor, TailState } from '../src/notices';

let dir: string;
let file: string;
const line = (source: string, message: string, at = '2026-11-10T10:00:00.000Z') => JSON.stringify({ at, source, message }) + '\n';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-notices-'));
  file = path.join(dir, 'notices.jsonl');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('tailing notices.jsonl', () => {
  it('a missing file is empty, not an error', () => {
    expect(readNewNotices(file, { offset: 0 })).toEqual({ notices: [], state: { offset: 0 } });
  });

  it('returns each notice once, advancing the byte offset', () => {
    fs.writeFileSync(file, line('graph-build', 'Graph build failed: x') + line('review', 'Review did not run: y'));
    const a = readNewNotices(file, { offset: 0 });
    expect(a.notices.map((n) => n.source)).toEqual(['graph-build', 'review']);
    const b = readNewNotices(file, a.state);
    expect(b.notices).toEqual([]);
    fs.appendFileSync(file, line('ds-tester', 'ds-tester did not run: z'));
    const c = readNewNotices(file, b.state);
    expect(c.notices.map((n) => n.source)).toEqual(['ds-tester']);
    expect(c.state.offset).toBe(fs.statSync(file).size);
  });

  it('leaves a partial last line for the next read', () => {
    const full = line('review', 'Review did not run: y');
    fs.writeFileSync(file, line('graph-build', 'one') + full.slice(0, 20));
    const a = readNewNotices(file, { offset: 0 });
    expect(a.notices.map((n) => n.message)).toEqual(['one']);
    fs.appendFileSync(file, full.slice(20));
    const b = readNewNotices(file, a.state);
    expect(b.notices.map((n) => n.message)).toEqual(['Review did not run: y']);
  });

  it('handles multi-byte characters across the offset', () => {
    fs.writeFileSync(file, line('review', 'Review did not run: é中文'));
    const a = readNewNotices(file, { offset: 0 });
    expect(a.notices[0].message).toBe('Review did not run: é中文');
    expect(a.state.offset).toBe(fs.statSync(file).size);
  });

  it('skips corrupt lines without losing the ones after them', () => {
    fs.writeFileSync(file, 'not json\n' + line('review', 'ok one') + '{"message":""}\n' + line('review', 'ok two'));
    expect(readNewNotices(file, { offset: 0 }).notices.map((n) => n.message)).toEqual(['ok one', 'ok two']);
  });

  it('re-reads from the start after the file is truncated or rotated', () => {
    fs.writeFileSync(file, line('review', 'old notice number one') + line('review', 'old notice number two'));
    const a = readNewNotices(file, { offset: 0 });
    fs.writeFileSync(file, line('graph-build', 'new')); // shorter than before: rotated
    const b = readNewNotices(file, a.state);
    expect(b.notices.map((n) => n.message)).toEqual(['new']);
    // removed and recreated
    fs.rmSync(file);
    expect(readNewNotices(file, b.state).state.offset).toBe(0);
    fs.writeFileSync(file, line('review', 'again'));
    expect(readNewNotices(file, { offset: 0 }).notices.map((n) => n.message)).toEqual(['again']);
  });

  it('endOfFile skips history', () => {
    fs.writeFileSync(file, line('review', 'history'));
    const st: TailState = endOfFile(file);
    expect(readNewNotices(file, st).notices).toEqual([]);
    fs.appendFileSync(file, line('review', 'fresh'));
    expect(readNewNotices(file, st).notices.map((n) => n.message)).toEqual(['fresh']);
    expect(endOfFile(path.join(dir, 'nope'))).toEqual({ offset: 0 });
  });

  it('parseNoticeLine tolerates missing optional fields', () => {
    expect(parseNoticeLine('{"message":"m"}')).toEqual({ at: '', source: '', message: 'm' });
    expect(parseNoticeLine('')).toBeUndefined();
  });
});

describe('dedupe, severity, rerun mapping', () => {
  it('shows an identical notice only once even if re-read', () => {
    const d = new NoticeDeduper();
    const n = { at: 'a', source: 'review', message: 'm' };
    expect(d.fresh([n, n])).toHaveLength(1);
    expect(d.fresh([n])).toHaveLength(0);
    expect(d.fresh([{ ...n, at: 'b' }])).toHaveLength(1);
  });

  it('error vs warning by wording', () => {
    expect(noticeSeverity({ at: '', source: '', message: 'Review did not run: boom' })).toBe('error');
    expect(noticeSeverity({ at: '', source: '', message: 'Graph build failed: x' })).toBe('error');
    expect(noticeSeverity({ at: '', source: '', message: 'Your branch is 3 commits behind main' })).toBe('warning');
  });

  it('maps sources to the command that reruns them', () => {
    expect(noticeToRerun('graph-build')).toEqual({ command: ['graph', 'build'] });
    expect(noticeToRerun('ds-tester')).toEqual({ command: ['test'] });
    expect(noticeToRerun('review')).toEqual({ command: ['review'] });
    expect(noticeToRerun('pre-push')).toEqual({ command: ['review'] });
    expect(noticeToRerun('ds-security')).toEqual({ command: ['review'] });
    expect(noticeToRerun('ds-peer-review')).toEqual({ command: ['review'] });
    expect(noticeToRerun('ds-auditor')).toEqual({ command: ['review'] });
    expect(noticeToRerun('post-merge')).toBeUndefined();
    expect(noticeToRerun('init')).toBeUndefined();
    expect(noticeToRerun('')).toBeUndefined();
  });

  it('suppresses the notice for a command the extension itself ran, and only that one', () => {
    const s = new NoticeSuppressor();
    const t0 = Date.parse('2026-11-10T10:00:00.000Z');
    const w = s.start(['review'], t0);
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    expect(s.suppresses({ at: at(5000), source: 'ds-security', message: 'm' })).toBe(true); // while running
    expect(s.suppresses({ at: at(5000), source: 'graph-build', message: 'm' })).toBe(false);
    s.end(w, t0 + 10_000);
    expect(s.suppresses({ at: at(12_000), source: 'review', message: 'm' })).toBe(true); // just after
    expect(s.suppresses({ at: at(60_000), source: 'review', message: 'm' })).toBe(false); // a later, separate failure
    expect(s.suppresses({ at: 'garbage', source: 'review', message: 'm' })).toBe(false);
  });
});
