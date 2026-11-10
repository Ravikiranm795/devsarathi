import * as fs from 'fs';
import * as path from 'path';
import { Stack, StackId, StackCategory, DEFAULT_IGNORE } from '@devsarathi/shared';
import { templatesRoot } from '../lib/paths';
import { readJson } from '../lib/fsutil';

/** A single check against a manifest file. Data-driven so a new stack is a new profile folder, not new code. */
export interface Matcher {
  name?: string;
  file?: string;
  dep?: string; // key in package.json dependencies/devDependencies/peerDependencies
  contains?: string; // case-insensitive text match inside `file`
  extension?: string;
  minCount?: number;
  /** Count the extension in the folder AND its direct subfolders (src/, lib/, bin/), not just the folder itself. */
  deep?: boolean;
  /** All of these must match (an AND of matchers). */
  all?: Matcher[];
}

export interface ProfileDetect {
  id: StackId;
  displayName: string;
  category: StackCategory;
  signals: Matcher[];
  excludeWhen?: Matcher[];
  frameworks: Matcher[];
  tests: Matcher[];
  linters: Matcher[];
  buildTools: Matcher[];
  packageManagers: Matcher[];
  stateManagement: Matcher[];
}

export interface DetectedStack extends Stack {
  displayName: string;
  /** Directory (repo-relative, posix) where the manifest was found; '.' for the repo root. */
  dir: string;
  signals: string[];
}

export interface DetectionResult {
  stacks: DetectedStack[];
  /** Plain-language notes for the developer (subfolder stacks, ambiguity). */
  notes: string[];
}

export function loadProfiles(root = templatesRoot()): ProfileDetect[] {
  const dir = path.join(root, 'profiles');
  const out: ProfileDetect[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names.sort()) {
    const p = readJson<ProfileDetect>(path.join(dir, n, 'detect.json'));
    if (p && p.id) out.push(p);
  }
  return out;
}

interface DirFacts {
  abs: string;
  rel: string;
  files: Set<string>;
  pkg?: { deps: Set<string> };
  textCache: Map<string, string>;
  extCounts: Map<string, number>;
  deepExtCounts: Map<string, number>;
}

function readText(f: DirFacts, file: string): string {
  const hit = f.textCache.get(file);
  if (hit !== undefined) return hit;
  let t = '';
  try {
    t = fs.readFileSync(path.join(f.abs, file), 'utf8').toLowerCase();
  } catch {
    /* missing or unreadable */
  }
  f.textCache.set(file, t);
  return t;
}

function matches(f: DirFacts, m: Matcher): boolean {
  if (m.all) return m.all.every((x) => matches(f, x));
  if (m.extension) return ((m.deep ? f.deepExtCounts : f.extCounts).get(m.extension) ?? 0) >= (m.minCount ?? 1);
  if (!m.file || !f.files.has(m.file)) return false;
  if (m.dep) return !!f.pkg && f.pkg.deps.has(m.dep);
  if (m.contains) return readText(f, m.file).includes(m.contains.toLowerCase());
  return true;
}

function first(f: DirFacts, list: Matcher[] | undefined): string | undefined {
  for (const m of list ?? []) if (matches(f, m)) return m.name;
  return undefined;
}

function all(f: DirFacts, list: Matcher[] | undefined): string[] {
  const names: string[] = [];
  for (const m of list ?? []) if (matches(f, m) && m.name && !names.includes(m.name)) names.push(m.name);
  return names;
}

function gatherFacts(abs: string, rel: string, ignore: Set<string>): DirFacts {
  const files = new Set<string>();
  const extCounts = new Map<string, number>();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    /* unreadable */
  }
  for (const e of entries) {
    if (e.isFile()) {
      files.add(e.name);
      const ext = path.extname(e.name);
      if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
  }
  const deepExtCounts = new Map<string, number>(extCounts);
  const facts: DirFacts = { abs, rel, files, textCache: new Map(), extCounts, deepExtCounts };
  if (files.has('package.json')) {
    const pkg = readJson<Record<string, Record<string, string> | undefined>>(path.join(abs, 'package.json'));
    const deps = new Set<string>();
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) Object.keys(pkg?.[k] ?? {}).forEach((d) => deps.add(d));
    facts.pkg = { deps };
  }
  // Some stacks live a level below the manifest (src/, lib/, bin/): count one level of subfolders into deepExtCounts.
  // PHP has always counted them for plain extCounts, so it keeps working without the `deep` flag.
  for (const e of entries) {
    if (e.isDirectory() && !ignore.has(e.name) && !e.name.startsWith('.')) {
      try {
        for (const c of fs.readdirSync(path.join(abs, e.name), { withFileTypes: true })) {
          if (c.isFile()) {
            const ext = path.extname(c.name);
            if (ext) deepExtCounts.set(ext, (deepExtCounts.get(ext) ?? 0) + 1);
            if (ext === '.php' && rel === '.') extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return facts;
}

/**
 * Deterministic detection (MASTER 6.1): manifest files plus dependency names, with extension counts as a
 * fallback. The repo root and its immediate subfolders are inspected, so a full-stack repo with `frontend/`
 * and `backend/` is recognised; anything deeper is out of scope (the company uses a repo per stack).
 */
export function detectStacks(root: string, opts: { ignore?: string[]; profiles?: ProfileDetect[] } = {}): DetectionResult {
  const profiles = opts.profiles ?? loadProfiles();
  const ignore = new Set(opts.ignore ?? DEFAULT_IGNORE);
  const notes: string[] = [];

  const dirs: DirFacts[] = [gatherFacts(root, '.', ignore)];
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !ignore.has(e.name) && !e.name.startsWith('.')) {
        dirs.push(gatherFacts(path.join(root, e.name), e.name, ignore));
      }
    }
  } catch {
    /* unreadable root */
  }

  const found = new Map<StackId, DetectedStack>();
  for (const f of dirs) {
    for (const p of profiles) {
      if (found.has(p.id)) continue;
      // The `.php` extension signal is meaningful only at the root; manifest signals work in any scanned folder.
      const hits = p.signals.filter((m) => matches(f, m));
      if (hits.length === 0) continue;
      if (p.signals.every((m) => m.extension) && f.rel !== '.') continue;
      if ((p.excludeWhen ?? []).some((m) => matches(f, m))) continue;
      found.set(p.id, {
        id: p.id,
        displayName: p.displayName,
        category: p.category,
        dir: f.rel,
        signals: hits.map((m) => m.dep ?? m.file ?? m.extension ?? ''),
        frameworks: all(f, p.frameworks),
        testFramework: first(f, p.tests),
        linter: first(f, p.linters),
        buildTool: first(f, p.buildTools),
        packageManager: first(f, p.packageManagers),
        stateManagement: first(f, p.stateManagement)
      });
    }
  }

  // Frontend before backend, then alphabetically: stable order for persona titles.
  const stacks = [...found.values()].sort((a, b) =>
    a.category === b.category ? a.displayName.localeCompare(b.displayName) : a.category === 'frontend' ? -1 : 1
  );

  for (const s of stacks) {
    if (s.dir !== '.') notes.push(`${s.displayName} was detected in the "${s.dir}" subfolder, not the repo root.`);
  }
  if (stacks.length === 0) notes.push('No supported stack was detected. Supported: Angular, React, Java, Python, PHP.');
  return { stacks, notes };
}

/** Persona title rules (MASTER 6.2). `needsConfirmation` is true when the developer must confirm or edit. */
export function personaTitle(stacks: Pick<Stack, 'id' | 'category'>[], names: Record<string, string> = {}): { title: string; needsConfirmation: boolean } {
  const known: Record<string, string> = { angular: 'Angular', react: 'React', java: 'Java', python: 'Python', php: 'PHP', node: 'Node.js' };
  const label = (s: Pick<Stack, 'id'>) => names[s.id] ?? known[s.id] ?? s.id.charAt(0).toUpperCase() + s.id.slice(1);
  if (stacks.length === 0) return { title: 'Developer', needsConfirmation: true };
  if (stacks.length === 1) return { title: `${label(stacks[0])} Developer`, needsConfirmation: false };
  if (stacks.length === 2) {
    const [a, b] = stacks;
    const joined = `${label(a)} + ${label(b)}`;
    if (a.category !== b.category) return { title: `Full Stack Developer (${joined})`, needsConfirmation: false };
    if (a.category === 'frontend') return { title: `Front-end Developer (${joined})`, needsConfirmation: false };
    return { title: `Back-end Developer (${joined})`, needsConfirmation: false };
  }
  // More than two stacks: never guess (D-24). Offer a suggestion the developer can edit.
  return { title: `Full Stack Developer (${stacks.map(label).join(' + ')})`, needsConfirmation: true };
}
