import * as fs from 'fs';
import * as path from 'path';
import { git } from './git';
import { isSecretFile } from '../security/secretPatterns';

export interface AddedLine {
  line: number;
  text: string;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** Added lines with their line numbers in the new file. Empty for secret files: their content is never read. */
  added: AddedLine[];
  secret: boolean;
  binary: boolean;
}

const MAX_UNTRACKED_BYTES = 300 * 1024;

/** The .claude folder holds configuration and DevSarathi's own generated files, not the code under review. */
export const OWN_DIR = /^\.claude\/(devsarathi\/|(rules|agents|commands)\/ds-[^/]+$|skills\/)/;

/** Parse `git diff -U0` output into added lines per file. */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let cur: ChangedFile | undefined;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = undefined;
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      if (p === '/dev/null') continue;
      const rel = p.replace(/^b\//, '').replace(/^"|"$/g, '');
      cur = { path: rel, status: 'modified', added: [], secret: isSecretFile(rel), binary: false };
      files.push(cur);
      continue;
    }
    if (raw.startsWith('new file mode') && cur) cur.status = 'added';
    if (raw.startsWith('Binary files ') && cur) cur.binary = true;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (!cur.secret) cur.added.push({ line: newLine, text: raw.slice(1) });
      newLine++;
    }
  }
  return files;
}

/** Paths git reports as deleted in a range or against a base. Content is irrelevant for deletions. */
function deletedPaths(nameStatus: string): string[] {
  const out: string[] = [];
  const tok = nameStatus.split('\0');
  for (let i = 0; i < tok.length; ) {
    const code = tok[i++];
    if (!code) continue;
    if (code[0] === 'R' || code[0] === 'C') {
      i += 2;
    } else {
      const p = tok[i++];
      if (code[0] === 'D' && p) out.push(p);
    }
  }
  return out;
}

export interface ChangeSet {
  files: ChangedFile[];
  deleted: string[];
  /** Human description of what was compared. */
  label: string;
}

/**
 * What a review looks at: either the commits being pushed (`range` = A..B) or, with no range, everything that
 * differs from the baseline right now (committed on this branch, staged, unstaged and untracked).
 */
export async function collectChanges(root: string, opts: { range?: string; baseRef?: string }): Promise<ChangeSet> {
  if (opts.range) {
    const [a, b] = opts.range.split('..');
    const diff = await git(['diff', '-U0', '--no-color', '-M', a, b], root);
    if (!diff.ok) throw new Error(`git diff failed for ${opts.range}: ${diff.stderr.trim()}`);
    const ns = await git(['diff', '--name-status', '-z', a, b], root);
    return { files: parseUnifiedDiff(diff.stdout).filter((f) => !OWN_DIR.test(f.path)), deleted: ns.ok ? deletedPaths(ns.stdout) : [], label: `commits ${a.slice(0, 7)}..${b.slice(0, 7)}` };
  }
  let base = 'HEAD';
  if (opts.baseRef) {
    const mb = await git(['merge-base', opts.baseRef, 'HEAD'], root);
    if (mb.ok && mb.stdout.trim()) base = mb.stdout.trim();
  }
  const diff = await git(['diff', '-U0', '--no-color', '-M', base], root);
  if (!diff.ok) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  const files = parseUnifiedDiff(diff.stdout).filter((f) => !OWN_DIR.test(f.path));
  const ns = await git(['diff', '--name-status', '-z', base], root);
  const untracked = await git(['ls-files', '-z', '--others', '--exclude-standard'], root);
  if (untracked.ok) {
    for (const rel of untracked.stdout.split('\0').filter(Boolean)) {
      if (OWN_DIR.test(rel)) continue;
      const secret = isSecretFile(rel);
      const f: ChangedFile = { path: rel, status: 'added', added: [], secret, binary: false };
      if (!secret) {
        try {
          const abs = path.join(root, rel);
          if (fs.statSync(abs).size <= MAX_UNTRACKED_BYTES) {
            const text = fs.readFileSync(abs, 'utf8');
            if (text.includes('\u0000')) f.binary = true;
            else f.added = text.split(/\r?\n/).map((t, i) => ({ line: i + 1, text: t }));
          }
        } catch {
          /* unreadable: skip content */
        }
      }
      files.push(f);
    }
  }
  return { files, deleted: ns.ok ? deletedPaths(ns.stdout) : [], label: base === 'HEAD' ? 'working tree changes' : `changes since ${opts.baseRef} (${base.slice(0, 7)})` };
}
