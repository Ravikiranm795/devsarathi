import * as fs from 'fs';
import * as path from 'path';
import { RunSpec } from './cli';

/*
 * Core appends `{at, source, message}` lines to <repo>/.claude/devsarathi/notices.jsonl whenever something fails
 * outside a command the extension started (git hooks, background graph builds). We tail that file by byte offset so
 * each notice is surfaced exactly once.
 */

export interface Notice {
  at: string;
  source: string;
  message: string;
}

export function noticesFile(repoRoot: string): string {
  return path.join(repoRoot, '.claude', 'devsarathi', 'notices.jsonl');
}

export interface TailState {
  /** Bytes already consumed (always ends just after a newline). */
  offset: number;
  /** File identity, to notice a replaced file that happens to be as large as the old one. */
  ino?: number;
}

export function parseNoticeLine(line: string): Notice | undefined {
  const t = line.trim();
  if (!t) return undefined;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (typeof o.message !== 'string' || !o.message.trim()) return undefined;
    return { at: typeof o.at === 'string' ? o.at : '', source: typeof o.source === 'string' ? o.source : '', message: o.message };
  } catch {
    return undefined; // a corrupt line must not stop the lines after it
  }
}

export interface TailResult {
  notices: Notice[];
  state: TailState;
}

/** The state to start from when we do not want old history: the current end of the file. */
export function endOfFile(file: string): TailState {
  try {
    const st = fs.statSync(file);
    return { offset: st.size, ino: st.ino || undefined };
  } catch {
    return { offset: 0 };
  }
}

/**
 * Reads what was appended since `state`. A partial last line (the writer is mid-append) is left unconsumed and picked up
 * next time; a file that shrank or was replaced is read again from the start.
 */
export function readNewNotices(file: string, state: TailState): TailResult {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { notices: [], state: { offset: 0 } }; // removed: whatever appears next is new
  }
  let offset = state.offset;
  const replaced = state.ino !== undefined && st.ino !== 0 && state.ino !== st.ino;
  if (st.size < offset || replaced) offset = 0;
  const ino = st.ino || undefined;
  if (st.size === offset) return { notices: [], state: { offset, ino } };

  const fd = fs.openSync(file, 'r');
  let chunk: Buffer;
  try {
    chunk = Buffer.alloc(st.size - offset);
    const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
    chunk = chunk.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
  const lastNl = chunk.lastIndexOf(0x0a);
  if (lastNl < 0) return { notices: [], state: { offset, ino } };
  const complete = chunk.subarray(0, lastNl + 1);
  const notices = complete
    .toString('utf8')
    .split('\n')
    .map(parseNoticeLine)
    .filter((n): n is Notice => !!n);
  return { notices, state: { offset: offset + complete.length, ino } };
}

/** Remembers what was shown so a re-read (after a truncate) never shows the same notice twice. */
export class NoticeDeduper {
  private seen = new Set<string>();

  fresh(notices: Notice[]): Notice[] {
    const out: Notice[] = [];
    for (const n of notices) {
      const key = `${n.at}|${n.source}|${n.message}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      out.push(n);
    }
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    return out;
  }
}

export type NoticeSeverity = 'error' | 'warning';

/** Wording decides: a notice that says something did not run or failed is an error; anything else is a warning. */
export function noticeSeverity(n: Notice): NoticeSeverity {
  return /did not run|failed|failure|crash|error|could not|cannot|timed? ?out/i.test(n.message) ? 'error' : 'warning';
}

/** The command that retries what a notice is about, when there is one (git-hook sources have none). */
export function noticeToRerun(source: string): RunSpec | undefined {
  const s = source.trim().toLowerCase();
  if (s === 'graph-build') return { command: ['graph', 'build'] };
  if (s === 'ds-tester') return { command: ['test'] };
  if (s === 'review' || s === 'pre-push' || /^ds-(security|peer-review|auditor|impact|spec|review)$/.test(s)) return { command: ['review'] };
  return undefined;
}

/**
 * When the extension itself ran a command it already reports that command's failure; core also writes a notice for it.
 * This keeps the two from both popping up.
 */
interface SuppressWindow {
  key: string;
  from: number;
  to: number;
}

export class NoticeSuppressor {
  private windows: SuppressWindow[] = [];

  /** The window stays open (to = Infinity) while the command runs. */
  start(command: string[], at: number): SuppressWindow {
    const w = { key: command.join(' '), from: at - 1500, to: Infinity };
    this.windows.push(w);
    return w;
  }

  end(w: SuppressWindow, at: number): void {
    w.to = at + 4000;
    if (this.windows.length > 50) this.windows = this.windows.filter((x) => x.to === Infinity || x.to > at - 60_000);
  }

  suppresses(n: Notice): boolean {
    const rerun = noticeToRerun(n.source);
    const t = Date.parse(n.at);
    if (!rerun || Number.isNaN(t)) return false;
    const key = rerun.command.join(' ');
    return this.windows.some((w) => w.key === key && t >= w.from && t <= w.to);
  }
}
