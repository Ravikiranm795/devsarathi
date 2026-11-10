import * as fs from 'fs';
import * as path from 'path';
import { repoPaths } from '../lib/paths';
import { ensureDir, exists, writeFileAtomic } from '../lib/fsutil';
import { RUNNER_MARKER } from './runner';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The ONE edit DevSarathi ever makes to a file it did not create (I-5, MASTER 12.3): merging its own hook entries
 * into .claude/settings.json. Always: show the exact entries, back up the original, ask, merge. Uninstall removes
 * only entries whose command contains the runner marker.
 */
export function settingsFile(root: string): string {
  return path.join(root, '.claude', 'settings.json');
}

const command = (event: string) => `node "\${CLAUDE_PROJECT_DIR}/.claude/devsarathi/hooks/ds-hook.js" ${event}`;

/** Hook entries DevSarathi owns. Claude Code hooks (stdin is JSON from Claude, stdout is shown or added as context). */
export function devsarathiEntries(): Record<string, any[]> {
  const handler = (ev: string, statusMessage: string, timeout: number) => ({ type: 'command', command: command(ev), shell: 'bash', timeout, statusMessage });
  return {
    SessionStart: [{ matcher: 'startup|resume', hooks: [handler('session-start', 'DevSarathi status', 20)] }],
    UserPromptSubmit: [{ hooks: [handler('prompt', 'DevSarathi', 10)] }],
    Stop: [{ hooks: [handler('stop', 'DevSarathi', 20)] }]
  };
}

export function isOurs(h: any): boolean {
  return typeof h?.command === 'string' && h.command.includes(RUNNER_MARKER);
}

export interface MergePreview {
  exists: boolean;
  valid: boolean;
  alreadyMerged: boolean;
  entries: Record<string, any[]>;
  /** Plain text shown to the developer before they approve. */
  text: string;
}

export function previewSettingsMerge(root: string): MergePreview {
  const file = settingsFile(root);
  const entries = devsarathiEntries();
  const fileExists = exists(file);
  let valid = true;
  let current: any = {};
  if (fileExists) {
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      valid = false;
    }
  }
  const alreadyMerged = valid && Object.keys(entries).every((ev) => (current.hooks?.[ev] ?? []).some((g: any) => (g.hooks ?? []).some(isOurs)));
  const lines = [
    fileExists ? `.claude/settings.json exists. DevSarathi will add only these hook entries (your other settings stay as they are):` : `.claude/settings.json does not exist. DevSarathi will create it with only these hook entries:`,
    JSON.stringify({ hooks: entries }, null, 2),
    fileExists ? 'The original is backed up first, and uninstall removes only these entries.' : 'Uninstall removes only these entries.'
  ];
  if (!valid) lines.unshift('WARNING: .claude/settings.json is not valid JSON. DevSarathi will not touch it; fix the file and run: devsarathi init');
  return { exists: fileExists, valid, alreadyMerged, entries, text: lines.join('\n') };
}

export interface MergeResult {
  merged: boolean;
  backup?: string;
  reason?: string;
}

/** Merge after approval. `approved` must be true when the file already exists. */
export function mergeSettings(root: string, approved: boolean): MergeResult {
  const prev = previewSettingsMerge(root);
  if (!prev.valid) return { merged: false, reason: 'settings.json is not valid JSON; left untouched' };
  if (prev.alreadyMerged) return { merged: true, reason: 'already present' };
  if (prev.exists && !approved) return { merged: false, reason: 'not approved' };

  const file = settingsFile(root);
  let current: any = {};
  let backup: string | undefined;
  if (prev.exists) {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dir = path.join(repoPaths(root).backups, 'settings');
    ensureDir(dir);
    backup = path.join(dir, `settings.json.${Date.now()}.bak`);
    fs.copyFileSync(file, backup);
  }
  current.hooks = current.hooks ?? {};
  for (const [event, groups] of Object.entries(prev.entries)) {
    const existing: any[] = current.hooks[event] ?? [];
    const without = existing.filter((g) => !(g.hooks ?? []).some(isOurs)); // refresh, never duplicate
    current.hooks[event] = [...without, ...groups];
  }
  writeFileAtomic(file, JSON.stringify(current, null, 2) + '\n');
  return { merged: true, backup };
}

/** Remove only DevSarathi's entries; drop empty containers it created; delete the file only if it held nothing else. */
export function removeSettingsEntries(root: string): { removed: boolean; deletedFile: boolean } {
  const file = settingsFile(root);
  if (!exists(file)) return { removed: false, deletedFile: false };
  let current: any;
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { removed: false, deletedFile: false };
  }
  let changed = false;
  for (const event of Object.keys(current.hooks ?? {})) {
    const groups: any[] = current.hooks[event];
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length !== groups.length || kept.some((g, i) => g.hooks.length !== (groups[i]?.hooks ?? []).length)) changed = true;
    if (kept.length) current.hooks[event] = kept;
    else delete current.hooks[event];
  }
  if (current.hooks && Object.keys(current.hooks).length === 0) delete current.hooks;
  if (!changed) return { removed: false, deletedFile: false };
  if (Object.keys(current).length === 0) {
    fs.rmSync(file, { force: true });
    return { removed: true, deletedFile: true };
  }
  writeFileAtomic(file, JSON.stringify(current, null, 2) + '\n');
  return { removed: true, deletedFile: false };
}
