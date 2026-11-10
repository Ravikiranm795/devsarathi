import * as fs from 'fs';
import * as path from 'path';
import { repoPaths } from '../lib/paths';
import { sha256, normalizeEol, writeFileAtomic, ensureDir, readJson, writeJson } from '../lib/fsutil';
import { tokens, jaccard, polarity } from '../audit/auditor';

/**
 * Specs are written by PMs and directors; DevSarathi only CONSUMES them and never drafts or edits one (D-21).
 * Pasted or fetched Jira text is cached read-only for review traceability: cache, not authorship.
 */
export interface Criterion {
  id: string;
  text: string;
}

export interface ParsedSpec {
  ref: string; // repo-relative path or Jira key
  title: string;
  hash: string;
  text: string;
  criteria: Criterion[];
  /** Backticked identifiers and file paths the spec mentions. */
  mentions: string[];
}

export interface SpecIssue {
  kind: 'ambiguity' | 'conflict' | 'missing' | 'contradiction';
  message: string;
}

const VAGUE_SPEC = /\b(tbd|todo|to be decided|etc\.?|and so on|as appropriate|as needed|appropriate(ly)?|user[- ]friendly|fast|quickly|robust|intuitive|similar to|like the other|somehow|maybe|probably)\b|\?\s*$/i;

export function parseSpec(ref: string, text: string): ParsedSpec {
  const norm = normalizeEol(text);
  const title = /^#\s+(.+)$/m.exec(norm)?.[1]?.trim() ?? ref;
  const criteria: Criterion[] = [];

  // Acceptance criteria: bullets, numbered items or checkboxes under a heading that says so.
  const lines = norm.split('\n');
  let inSection = false;
  let sectionLevel = 0;
  let auto = 0;
  for (const raw of lines) {
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      if (/acceptance|criteria|definition of done/i.test(h[2])) {
        inSection = true;
        sectionLevel = h[1].length;
      } else if (inSection && h[1].length <= sectionLevel) inSection = false;
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    const idMatch = /^(AC[- ]?\d+)[:.)\s-]+(.*)$/i.exec(m[1]);
    auto++;
    criteria.push(idMatch ? { id: idMatch[1].toUpperCase().replace(/\s+/, '-').replace(/^AC(\d)/, 'AC-$1'), text: idMatch[2].trim() } : { id: `AC-${auto}`, text: m[1].trim() });
  }

  const mentions = new Set<string>();
  for (const m of norm.matchAll(/`([^`\n]{2,80})`/g)) {
    const v = m[1].trim();
    if (/^[A-Za-z_$][\w$]*(\([^)]*\))?$/.test(v) || /[\\/].+\.[a-z0-9]+$/i.test(v)) mentions.add(v.replace(/\(.*\)$/, ''));
  }
  return { ref, title, hash: sha256(norm), text: norm, criteria, mentions: [...mentions] };
}

/** Problems to settle BEFORE work starts (D-22): the enhancer lists them and stops. It never fills the gaps. */
export function specIssues(spec: ParsedSpec, knownSymbolOrPath: (name: string) => boolean): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (spec.criteria.length === 0) issues.push({ kind: 'missing', message: 'The spec has no acceptance criteria section, so "done" cannot be checked.' });
  for (const c of spec.criteria) {
    if (VAGUE_SPEC.test(c.text)) issues.push({ kind: 'ambiguity', message: `${c.id} is vague: "${c.text}". Say what exactly must be true.` });
  }
  for (const line of spec.text.split('\n')) {
    if (/\b(tbd|to be decided)\b/i.test(line) && !spec.criteria.some((c) => c.text === line.trim())) issues.push({ kind: 'ambiguity', message: `Open item in the spec: "${line.trim().slice(0, 120)}"` });
  }
  for (const name of spec.mentions) {
    if (!knownSymbolOrPath(name)) issues.push({ kind: 'conflict', message: `The spec refers to \`${name}\`, which is not in the code (renamed, new, or a mistake).` });
  }
  const prepared = spec.criteria.map((c) => ({ c, tok: tokens(c.text), pol: polarity(c.text) }));
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      if (jaccard(prepared[i].tok, prepared[j].tok) >= 0.6 && prepared[i].pol !== prepared[j].pol) {
        issues.push({ kind: 'contradiction', message: `${prepared[i].c.id} and ${prepared[j].c.id} contradict each other.` });
      }
    }
  }
  return issues;
}

// ---- intake and cache --------------------------------------------------------------------------------------------

export function specCachePath(root: string, key: string): string {
  return path.join(repoPaths(root).specsCache, `${key.replace(/[^A-Za-z0-9_.-]/g, '_')}.md`);
}

export function cachePastedSpec(root: string, key: string, text: string): string {
  const file = specCachePath(root, key);
  ensureDir(path.dirname(file));
  writeFileAtomic(file, text);
  return file;
}

export type SpecLoad = { ok: true; spec: ParsedSpec } | { ok: false; message: string };

/** Load from a markdown path (relative to the repo or the configured specs path) or from the Jira cache. */
export function loadSpec(root: string, opts: { spec?: string; jira?: string; paste?: string; specsPath?: string }): SpecLoad {
  if (opts.jira) {
    const key = opts.jira.trim();
    if (opts.paste && opts.paste.trim()) cachePastedSpec(root, key, opts.paste);
    const file = specCachePath(root, key);
    try {
      return { ok: true, spec: parseSpec(key, fs.readFileSync(file, 'utf8')) };
    } catch {
      // D-23: say so and ask for a paste; never proceed on partial context.
      return {
        ok: false,
        message: `Jira ticket ${key} is not available: it could not be fetched and nothing was pasted. Paste the ticket text (devsarathi enhance "<request>" --jira ${key} --paste "<text>"), or have Claude fetch it through the Atlassian MCP and pass it the same way. DevSarathi will not continue on partial context.`
      };
    }
  }
  if (opts.spec) {
    const candidates = [path.resolve(root, opts.spec), ...(opts.specsPath ? [path.resolve(root, opts.specsPath, opts.spec)] : [])];
    for (const c of candidates) {
      if (!c.startsWith(path.resolve(root))) continue; // never read outside the repo
      try {
        return { ok: true, spec: parseSpec(path.relative(root, c).split(path.sep).join('/'), fs.readFileSync(c, 'utf8')) };
      } catch {
        /* try the next candidate */
      }
    }
    return { ok: false, message: `Spec file not found: ${opts.spec}. Give a path relative to the repo${opts.specsPath ? ` or to ${opts.specsPath}` : ''}.` };
  }
  return { ok: false, message: 'No spec given.' };
}

// ---- spec hash recorded when work starts (D-22) ----------------------------------------------------------------------

export interface ActiveSpec {
  ref: string;
  path?: string;
  hash: string;
  startedAt: string;
}

const activeFile = (root: string) => path.join(repoPaths(root).state, 'active-spec.json');

export function recordActiveSpec(root: string, spec: ParsedSpec): ActiveSpec {
  const isFile = !/^[A-Z][A-Z0-9]+-\d+$/.test(spec.ref);
  const rec: ActiveSpec = { ref: spec.ref, path: isFile ? spec.ref : undefined, hash: spec.hash, startedAt: new Date().toISOString() };
  writeJson(activeFile(root), rec);
  return rec;
}

export function readActiveSpec(root: string): ActiveSpec | undefined {
  return readJson<ActiveSpec>(activeFile(root));
}

/** Re-read the active spec from disk or cache and say whether it changed since work started. */
export function checkSpecChanged(root: string): { active?: ActiveSpec; changed: boolean; current?: ParsedSpec; missing: boolean } {
  const active = readActiveSpec(root);
  if (!active) return { changed: false, missing: false };
  const file = active.path ? path.resolve(root, active.path) : specCachePath(root, active.ref);
  try {
    const current = parseSpec(active.ref, fs.readFileSync(file, 'utf8'));
    return { active, changed: current.hash !== active.hash, current, missing: false };
  } catch {
    return { active, changed: false, missing: true };
  }
}
