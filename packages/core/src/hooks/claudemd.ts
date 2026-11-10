import * as fs from 'fs';
import * as path from 'path';
import { repoPaths } from '../lib/paths';
import { ensureDir, exists, writeFileAtomic } from '../lib/fsutil';

/**
 * Makes Claude load the DevSarathi workspace map, persona and core rules at every session by importing them from the
 * project's CLAUDE.md. CLAUDE.md is not a file DevSarathi creates, so this is the second (and last) edit to a non-owned
 * file: a clearly marked block, shown first, backed up, applied only after approval, and removed again on uninstall.
 */
export const BEGIN = '<!-- devsarathi:begin (managed by DevSarathi; remove with `devsarathi uninstall`) -->';
export const END = '<!-- devsarathi:end -->';

/** Only the always-loaded files are imported. On-demand rules keep loading by their `paths`, so nothing is pre-loaded needlessly. */
export const IMPORTS = ['.claude/rules/ds-index.md', '.claude/rules/ds-persona.md', '.claude/rules/ds-core.md'];

export function blockText(): string {
  return [
    BEGIN,
    '## DevSarathi',
    'Load these first: the workspace map (persona, rules, agents, commands and when each loads), the persona, and the core rules.',
    ...IMPORTS.map((i) => `@${i}`),
    END
  ].join('\n');
}

export interface Target {
  file: string; // absolute
  rel: string;
  exists: boolean;
}

/** The project CLAUDE.md Claude Code reads: ./CLAUDE.md, else ./.claude/CLAUDE.md, else a new .claude/CLAUDE.md. */
export function claudeMdTarget(root: string): Target {
  const top = path.join(root, 'CLAUDE.md');
  if (exists(top)) return { file: top, rel: 'CLAUDE.md', exists: true };
  const inner = path.join(root, '.claude', 'CLAUDE.md');
  if (exists(inner)) return { file: inner, rel: '.claude/CLAUDE.md', exists: true };
  return { file: inner, rel: '.claude/CLAUDE.md', exists: false };
}

const BLOCK_RE = new RegExp(`\\n?${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`);
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ClaudeMdPreview {
  target: Target;
  alreadyMerged: boolean;
  /** The repo's own CLAUDE.md already imports rule files by `@.claude/rules/...`: adding ours follows its convention. */
  recommended: boolean;
  text: string;
}

export function previewClaudeMd(root: string): ClaudeMdPreview {
  const target = claudeMdTarget(root);
  const current = target.exists ? fs.readFileSync(target.file, 'utf8') : '';
  const alreadyMerged = BLOCK_RE.test(current);
  const recommended = /^@\.claude\/rules\//m.test(current);
  const lines = [
    target.exists
      ? `${target.rel} exists. DevSarathi will add only this marked block at the end, so Claude loads the workspace map, persona and core rules at every session (your content stays as it is; a backup is made first):`
      : `There is no CLAUDE.md. DevSarathi will create ${target.rel} containing only this block:`,
    blockText(),
    'Uninstall removes only this block.'
  ];
  if (!recommended) lines.push('Note: unpathed files in .claude/rules/ already load automatically, so importing them here can load them twice. Add the block when you want Claude to be told explicitly.');
  return { target, alreadyMerged, recommended, text: lines.join('\n') };
}

export interface ClaudeMdResult {
  merged: boolean;
  file?: string;
  created?: boolean;
  backup?: string;
  reason?: string;
}

export function mergeClaudeMd(root: string, approved: boolean): ClaudeMdResult {
  const prev = previewClaudeMd(root);
  const { target } = prev;
  if (target.exists && !approved) return { merged: false, reason: 'not approved' };
  let backup: string | undefined;
  let body = '';
  if (target.exists) {
    body = fs.readFileSync(target.file, 'utf8');
    const dir = path.join(repoPaths(root).backups, 'claude-md');
    ensureDir(dir);
    backup = path.join(dir, `CLAUDE.md.${Date.now()}.bak`);
    fs.copyFileSync(target.file, backup);
  }
  const block = blockText();
  const next = BLOCK_RE.test(body) ? body.replace(BLOCK_RE, `\n${block}\n`) : `${body}${body && !body.endsWith('\n') ? '\n' : ''}${body ? '\n' : ''}${block}\n`;
  writeFileAtomic(target.file, next);
  return { merged: true, file: target.rel, created: !target.exists, backup };
}

/** Remove only our block; delete the file only when DevSarathi created it and nothing else is in it. */
export function removeClaudeMd(root: string, rel: string, created: boolean): { removed: boolean; deletedFile: boolean } {
  const file = path.join(root, ...rel.split('/'));
  if (!exists(file)) return { removed: false, deletedFile: false };
  const body = fs.readFileSync(file, 'utf8');
  if (!BLOCK_RE.test(body)) return { removed: false, deletedFile: false };
  // At the end of the file the block (and the blank line we added before it) simply goes; in the middle keep one line break.
  const next = body.replace(BLOCK_RE, (m, offset: number, whole: string) => (offset + m.length >= whole.length ? '' : '\n')).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  if (created && next.trim() === '') {
    fs.rmSync(file, { force: true });
    return { removed: true, deletedFile: true };
  }
  writeFileAtomic(file, next.endsWith('\n') ? next : `${next}\n`);
  return { removed: true, deletedFile: false };
}

/** @-imports inside our block, for the auditor. */
export function importedByBlock(root: string, rel: string): string[] {
  const file = path.join(root, ...rel.split('/'));
  if (!exists(file)) return [];
  const m = BLOCK_RE.exec(fs.readFileSync(file, 'utf8'));
  return m ? [...m[0].matchAll(/^@(\S+)$/gm)].map((x) => x[1]) : [];
}
