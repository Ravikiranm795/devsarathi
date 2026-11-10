import * as fs from 'fs';
import * as path from 'path';
import { repoPaths } from './paths';
import { ensureDir, exists } from './fsutil';

/**
 * Append-only local event log that feeds the metrics (MASTER 16). It carries counts, names and timings only:
 * never prompt text, code or secret values (I-8).
 */
export interface DsEvent {
  type: string;
  /** Small, non-sensitive facts (counts, durations, ids, hashes). */
  data?: Record<string, string | number | boolean | null>;
}

export function eventsFile(root: string): string {
  return path.join(repoPaths(root).metricsDir, 'events.jsonl');
}

export function recordEvent(root: string, ev: DsEvent): void {
  try {
    // Never create state in a repo that has not been set up with `init`.
    if (!exists(repoPaths(root).config)) return;
    ensureDir(repoPaths(root).metricsDir);
    fs.appendFileSync(eventsFile(root), JSON.stringify({ t: new Date().toISOString(), ...ev }) + '\n');
  } catch {
    /* metrics must never break a command or a hook */
  }
}

export function readEvents(root: string): { t: string; type: string; data?: Record<string, string | number | boolean | null> }[] {
  try {
    return fs
      .readFileSync(eventsFile(root), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
