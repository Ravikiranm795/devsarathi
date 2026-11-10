import * as fs from 'fs';
import * as path from 'path';
import { repoPaths } from './paths';
import { ensureDir } from './fsutil';
import { redact } from '../security/secretPatterns';
import { loadConfig } from './config';

/**
 * Kill switch (D-31): when `disabled` is true every hook and automatic behavior must do
 * nothing. A missing or unreadable config counts as "not disabled but not initialized";
 * hooks treat that as nothing-to-do as well.
 */
export function isDisabled(root: string): boolean {
  const cfg = loadConfig(root);
  return cfg ? cfg.disabled : false;
}

export interface NoticeEntry {
  at: string;
  source: string;
  message: string;
}

/** A visible-but-non-blocking notice the VS Code extension picks up and shows. */
export function writeNotice(root: string, source: string, message: string): void {
  try {
    const p = repoPaths(root);
    ensureDir(p.state);
    const file = path.join(p.state, 'notices.jsonl');
    const entry: NoticeEntry = { at: new Date().toISOString(), source, message: redact(message) };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    /* never throw from the fail-open path */
  }
}

/**
 * I-3: a tool crash produces a visible notification and exit code 0, never a blocked git
 * operation. Wraps a hook body; returns the exit code the hook process must use (always 0).
 */
export async function failOpen(root: string, source: string, body: () => Promise<void>): Promise<0> {
  try {
    if (isDisabled(root)) return 0;
    await body();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeNotice(root, source, `${source} did not run: ${msg}`);
    try {
      process.stderr.write(`[devsarathi] ${source} did not run: ${redact(msg)}\n`);
    } catch {
      /* ignore */
    }
  }
  return 0;
}
