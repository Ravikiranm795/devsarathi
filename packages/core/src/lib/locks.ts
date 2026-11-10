import * as fs from 'fs';
import * as path from 'path';
import { ensureDir } from './fsutil';

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export interface LockHandle {
  acquired: boolean;
  /** When not acquired: true if a follow-up run is now queued (or was already queued). */
  queued: boolean;
  /** Release the lock. Returns true when a follow-up was queued while the lock was held. */
  release(): boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): LockInfo | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

/** Stale = holder PID is gone, or the lock is older than the timeout (MASTER 20). */
export function isStale(info: LockInfo | undefined, staleMs: number, now = Date.now()): boolean {
  if (!info) return true;
  if (!pidAlive(info.pid)) return true;
  return now - info.startedAt > staleMs;
}

/**
 * One holder at a time. A second request while the lock is held is queued as exactly ONE
 * follow-up run (a marker file), never stacked (MASTER 20).
 */
export function acquireLock(locksDir: string, name: string, staleMs = 60 * 60 * 1000): LockHandle {
  ensureDir(locksDir);
  const lockFile = path.join(locksDir, `${name}.lock`);
  const queueFile = path.join(locksDir, `${name}.queued`);

  const tryCreate = (): boolean => {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies LockInfo));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  };

  if (!tryCreate()) {
    if (isStale(readLock(lockFile), staleMs)) {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* another process recovered it first */
      }
      if (tryCreate()) return makeHandle(lockFile, queueFile);
    }
    try {
      fs.writeFileSync(queueFile, String(Date.now()), { flag: 'wx' });
    } catch {
      /* marker exists: exactly one follow-up is already queued */
    }
    return { acquired: false, queued: true, release: () => false };
  }
  return makeHandle(lockFile, queueFile);
}

function makeHandle(lockFile: string, queueFile: string): LockHandle {
  let released = false;
  return {
    acquired: true,
    queued: false,
    release() {
      if (released) return false;
      released = true;
      let hadQueued = false;
      try {
        fs.unlinkSync(queueFile);
        hadQueued = true;
      } catch {
        /* nothing queued */
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* already gone */
      }
      return hadQueued;
    }
  };
}

/** Run `fn` under the lock, then re-run once if a request arrived meanwhile. */
export async function runWithQueue<T>(
  locksDir: string,
  name: string,
  fn: () => Promise<T>,
  staleMs?: number
): Promise<{ ran: boolean; queued: boolean; result?: T; reruns: number }> {
  const h = acquireLock(locksDir, name, staleMs);
  if (!h.acquired) return { ran: false, queued: h.queued, reruns: 0 };
  let result: T | undefined;
  let reruns = 0;
  try {
    result = await fn();
  } finally {
    // release() reports whether a follow-up was queued; loop at most once per queued marker.
    let again = h.release();
    while (again) {
      const h2 = acquireLock(locksDir, name, staleMs);
      if (!h2.acquired) break;
      try {
        reruns++;
        result = await fn();
      } finally {
        again = h2.release();
      }
    }
  }
  return { ran: true, queued: false, result, reruns };
}
