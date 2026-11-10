import * as fs from 'fs';
import * as path from 'path';
import { DevSarathiConfig, TEMPLATE_VERSION } from '@devsarathi/shared';
import { Verified, GithubClient } from './verify';
import { sha256, normalizeEol, writeFileAtomic, exists } from '../lib/fsutil';

export interface InstallOutcome {
  installed: { name: string; source: string; commit: string; files: string[] }[];
  skipped: { name: string; reason: string }[];
}

/** The exact source and pinned version, shown before anything is written (MASTER 19.7). */
export function installPreview(picks: Verified[]): string {
  return picks
    .map((v) => `  ${v.suggestion.name}\n    source: ${v.suggestion.source}\n    pinned: ${v.commit ?? '(unresolved)'}\n    files: ${v.files.map((f) => f.path).join(', ')}\n    writes to: .claude/skills/${v.suggestion.name}/`)
    .join('\n');
}

/** Install only what the developer ticked, at the pinned commit. A name clash with something that is not ours is skipped. */
export async function installSkills(root: string, cfg: DevSarathiConfig, picks: Verified[], gh: GithubClient): Promise<InstallOutcome> {
  const out: InstallOutcome = { installed: [], skipped: [] };
  const managed = new Map(cfg.managedFiles.map((m) => [m.path, m] as const));
  for (const v of picks) {
    const name = v.suggestion.name;
    if (!v.verified && !v.commit) {
      out.skipped.push({ name, reason: 'it could not be pinned to a version' });
      continue;
    }
    const rel = `.claude/skills/${name}`;
    const ours = cfg.skills.some((s) => s.name === name);
    if (exists(path.join(root, ...rel.split('/'))) && !ours) {
      out.skipped.push({ name, reason: `.claude/skills/${name} already exists and was not installed by DevSarathi` });
      continue;
    }
    const written: string[] = [];
    try {
      for (const f of v.files) {
        const text = await gh.fetchText(f.url);
        const target = `${rel}/${f.path}`;
        if (f.path.includes('..') || path.isAbsolute(f.path)) throw new Error(`unsafe path ${f.path}`);
        writeFileAtomic(path.join(root, ...target.split('/')), text);
        managed.set(target, { path: target, hash: sha256(normalizeEol(text)), templateVersion: TEMPLATE_VERSION, source: `skill:${v.suggestion.source}@${v.commit}` });
        written.push(target);
      }
    } catch (e) {
      for (const w of written) fs.rmSync(path.join(root, ...w.split('/')), { force: true });
      out.skipped.push({ name, reason: `download failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    cfg.skills = [...cfg.skills.filter((s) => s.name !== name), { name, source: v.suggestion.source, commit: v.commit as string, installedAt: new Date().toISOString(), files: written }];
    out.installed.push({ name, source: v.suggestion.source, commit: v.commit as string, files: written });
  }
  cfg.managedFiles = [...managed.values()];
  return out;
}
