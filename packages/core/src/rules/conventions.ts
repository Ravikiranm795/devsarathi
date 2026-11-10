import * as path from 'path';
import { Rule, ruleId, RuleFileKey } from './engine';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface FileRow {
  path: string;
  ext: string | null;
  is_test: number;
}

const confidenceFor = (n: number, total: number): 'high' | 'medium' | 'low' => (n >= 5 && n / total >= 0.5 ? 'high' : n >= 2 ? 'medium' : 'low');

function mk(file: RuleFileKey, topic: string, text: string, commit: string, confidence: Rule['confidence'], evidence: string[]): Rule {
  return { id: ruleId(text), text, layer: 'graph', topic, source: `graph@${commit.slice(0, 7) || 'unknown'}`, confidence, evidence: evidence.slice(0, 3), file };
}

function buildDirTree(paths: string[]): Map<string, Set<string>> {
  const tree = new Map<string, Set<string>>();
  for (const p of paths) {
    const dirs = path.posix.dirname(p).split('/').filter((s) => s && s !== '.');
    let prefix = '';
    for (const d of dirs) {
      if (!tree.has(prefix)) tree.set(prefix, new Set());
      tree.get(prefix)!.add(d);
      prefix = prefix ? `${prefix}/${d}` : d;
    }
  }
  return tree;
}

/**
 * Conventions learned from the repo itself (MASTER 9.1 graph-derived layer). Every rule carries confidence and
 * evidence; the auditor later checks the evidence still exists in the graph.
 */
export function deriveConventions(store: any, opts: { commit: string; sourceExts: string[] }): Rule[] {
  const rules: Rule[] = [];
  const rows = store.db.prepare('SELECT path, ext, is_test FROM files').all() as FileRow[];
  const exts = new Set(opts.sourceExts);
  const code = rows.filter((r) => r.ext && exts.has(r.ext));
  const source = code.filter((r) => !r.is_test);
  const tests = code.filter((r) => r.is_test);
  const commit = opts.commit;

  // --- structure ---------------------------------------------------------------------------------------------
  if (source.length >= 3) {
    const tree = buildDirTree(source.map((r) => r.path));
    const top = new Map<string, number>();
    for (const r of source) {
      const seg = r.path.split('/')[0];
      top.set(seg, (top.get(seg) ?? 0) + 1);
    }
    const [root, rootCount] = [...top.entries()].sort((a, b) => b[1] - a[1])[0];
    const rootIsDir = source.some((r) => r.path.startsWith(`${root}/`));
    if (rootIsDir) {
      // Descend through folders that only hold one subfolder (src -> app, src/main/java -> com -> acme) so the rule
      // names the level where the real feature folders are.
      let base = root;
      for (;;) {
        const kids = [...(tree.get(base) ?? [])];
        const filesHere = source.some((r) => path.posix.dirname(r.path) === base);
        if (kids.length === 1 && !filesHere) base = `${base}/${kids[0]}`;
        else break;
      }
      const features = [...(tree.get(base) ?? [])]
        .map((d) => [d, source.filter((r) => r.path.startsWith(`${base}/${d}/`)).length] as const)
        .filter(([, n]) => n >= 1)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8);
      const sample = source.filter((r) => r.path.startsWith(`${base}/`)).map((r) => r.path);
      const list = features.length ? ` Main folders under \`${base}/\`: ${features.map(([d, n]) => `${d} (${n})`).join(', ')}.` : '';
      rules.push(mk('architecture', 'structure', `Source code lives under \`${base}/\` (${sample.length} of ${source.length} source files).${list} Put new code in the matching folder.`, commit, confidenceFor(rootCount, source.length), sample));
    }
  }

  // --- naming ------------------------------------------------------------------------------------------------
  const dotted = new Map<string, string[]>();
  const camel = new Map<string, string[]>();
  const snake = new Map<string, string[]>();
  for (const r of source) {
    const base = path.posix.basename(r.path);
    let m = /^[^.]+\.([a-z][a-z-]*)\.([a-z]+)$/.exec(base);
    if (m) dotted.set(`*.${m[1]}.${m[2]}`, [...(dotted.get(`*.${m[1]}.${m[2]}`) ?? []), r.path]);
    m = /^[A-Za-z0-9]*?([A-Z][a-z0-9]+)\.(java|cs|php|kt)$/.exec(base);
    if (m && base.length > m[1].length + m[2].length + 1) camel.set(`*${m[1]}.${m[2]}`, [...(camel.get(`*${m[1]}.${m[2]}`) ?? []), r.path]);
    m = /^[a-z0-9]+_([a-z]+)\.py$/.exec(base);
    if (m) snake.set(`*_${m[1]}.py`, [...(snake.get(`*_${m[1]}.py`) ?? []), r.path]);
  }
  const named = [...dotted, ...camel, ...snake].filter(([, p]) => p.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  if (named.length) {
    const total = source.length;
    const best = named[0][1].length;
    rules.push(
      mk('naming-style', 'naming-observed', `Files are named by role: ${named.map(([k, p]) => `\`${k}\` (${p.length})`).join(', ')}. Name new files the same way.`, commit, confidenceFor(best, total), named.flatMap(([, p]) => p.slice(0, 1)))
    );
  }

  // --- tests -------------------------------------------------------------------------------------------------
  if (tests.length >= 1) {
    const inDedicated = tests.filter((t) => /(^|\/)(tests?|__tests__|spec)\//.test(t.path));
    const colocated = tests.length - inDedicated.length;
    const patterns = new Map<string, number>();
    for (const t of tests) {
      const base = path.posix.basename(t.path);
      const p = /\.(spec|test)\.[a-z]+$/.exec(base)?.[0] ? `*${/\.(spec|test)\.[a-z]+$/.exec(base)![0]}` : /^test_.*\.py$/.test(base) ? 'test_*.py' : /_test\.py$/.test(base) ? '*_test.py' : /Tests?\.(java|cs)$/.test(base) ? `*${/Tests?\.(java|cs)$/.exec(base)![0]}` : /Test\.php$/.test(base) ? '*Test.php' : base;
      patterns.set(p, (patterns.get(p) ?? 0) + 1);
    }
    const topPattern = [...patterns.entries()].sort((a, b) => b[1] - a[1])[0];
    const where = colocated >= inDedicated.length ? 'next to the source file they cover' : 'in a dedicated test folder';
    const share = Math.max(colocated, inDedicated.length);
    rules.push(
      mk('testing', 'test-location', `Tests live ${where} (${share} of ${tests.length} test files) and are named \`${topPattern[0]}\`. Follow that placement for new tests.`, commit, confidenceFor(share, tests.length), tests.map((t) => t.path))
    );
  } else if (source.length >= 3) {
    rules.push(mk('testing', 'test-coverage-gap', 'No test files were found in the graph. Ask before adding the first test, and match the stack\'s standard test location.', commit, 'low', source.slice(0, 1).map((r) => r.path)));
  }

  // --- dependency injection and routes (framework facts) -------------------------------------------------------
  try {
    const counts = store.countFactsByRole?.() as Record<string, number> | undefined;
    if (counts?.injects && counts.injects >= 2) {
      const ev = (store.findFacts({ role: 'injects', limit: 3 }) as { path: string }[]).map((f) => f.path);
      rules.push(mk('architecture', 'di-observed', `Dependencies are injected (${counts.injects} injection sites found). Receive collaborators through the constructor, as the existing code does.`, commit, confidenceFor(counts.injects, counts.injects + 1), ev));
    }
    if (counts?.route && counts.route >= 1) {
      const ev = (store.findFacts({ role: 'route', limit: 3 }) as { path: string }[]).map((f) => f.path);
      rules.push(mk('architecture', 'routes-observed', `HTTP routes are declared in code (${counts.route} found, for example in ${[...new Set(ev)].slice(0, 2).join(', ')}). Declare new endpoints the same way.`, commit, confidenceFor(counts.route, counts.route + 1), ev));
    }
  } catch {
    /* facts are optional */
  }

  // --- module boundaries -----------------------------------------------------------------------------------------
  try {
    const tree = buildDirTree(source.map((r) => r.path));
    const featureCache = new Map<string, string | undefined>();
    const feat = (p: string) => {
      if (!featureCache.has(p)) featureCache.set(p, featureOfBranch(p, tree));
      return featureCache.get(p);
    };
    const edges = store.db
      .prepare(
        `SELECT fs.path AS src, fd.path AS dst, COUNT(*) AS n
         FROM edges e JOIN symbols ss ON ss.id = e.src_symbol_id JOIN files fs ON fs.id = ss.file_id
         JOIN symbols sd ON sd.id = e.dst_symbol_id JOIN files fd ON fd.id = sd.file_id
         WHERE e.dst_symbol_id IS NOT NULL AND fs.is_test = 0 AND fd.is_test = 0 GROUP BY fs.path, fd.path`
      )
      .all() as { src: string; dst: string; n: number }[];
    const dep = new Map<string, { n: number; ev: string }>();
    for (const e of edges) {
      const a = feat(e.src);
      const b = feat(e.dst);
      if (!a || !b || a === b) continue;
      const k = `${a}->${b}`;
      const prev = dep.get(k);
      dep.set(k, { n: (prev?.n ?? 0) + e.n, ev: prev?.ev ?? e.src });
    }
    const pairs = [...dep.entries()].filter(([, v]) => v.n >= 1);
    const reverse = pairs.some(([k]) => {
      const [a, b] = k.split('->');
      return dep.has(`${b}->${a}`);
    });
    if (pairs.length >= 1 && !reverse) {
      const top = pairs.sort((a, b) => b[1].n - a[1].n).slice(0, 5);
      rules.push(
        mk('architecture', 'module-boundaries-observed', `Dependencies between feature areas currently flow one way: ${top.map(([k, v]) => `${k.replace('->', ' -> ')} (${v.n})`).join(', ')}. Do not add the reverse direction.`, commit, pairs.length >= 3 ? 'medium' : 'low', top.map(([, v]) => v.ev))
      );
    }
  } catch {
    /* boundaries are optional */
  }

  return rules;
}

/** First segment where source folders branch into 2+ siblings (feature level). */
function featureOfBranch(filePath: string, tree: Map<string, Set<string>>): string | undefined {
  const dirs = path.posix.dirname(filePath).split('/').filter((s) => s && s !== '.');
  let prefix = '';
  for (const d of dirs) {
    const kids = tree.get(prefix);
    if (kids && kids.size >= 2) return d;
    prefix = prefix ? `${prefix}/${d}` : d;
  }
  return undefined;
}
