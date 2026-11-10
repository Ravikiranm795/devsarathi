import { DevSarathiConfig } from '@devsarathi/shared';
import { DrishtiClient } from '../graph/drishti';
import { impactOfSymbol, ImpactResult } from '../graph/impact';
import { Criterion, ParsedSpec } from './spec';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The prompt enhancer (MASTER 13). Fixed section order; references instead of prose; the spec reference and the
 * core-rules constraint are NEVER trimmed away (I-9). The size cap is adaptive: simple tasks target ~400
 * characters, cross-module ones may grow up to the configured ceiling.
 */
export interface EnhanceContext {
  files: { path: string; symbol: string; kind: string }[];
  impact: { callers: number; files: string[]; confidence: 'high' | 'medium' | 'low' | 'unknown'; top: string };
  modules: number;
}

export interface Composed {
  prompt: string;
  chars: number;
  cap: number;
  trimmed: boolean;
  overCap: boolean;
}

const CORE = '.claude/rules/ds-core.md';

/** Pull the files and symbols a request touches from the graph, with the impact of the top few. */
export async function gatherContext(client: DrishtiClient, query: string): Promise<EnhanceContext> {
  const empty: EnhanceContext = { files: [], impact: { callers: 0, files: [], confidence: 'unknown', top: '' }, modules: 0 };
  if (!client.hasGraph()) return empty;
  let hits: any[] = [];
  try {
    hits = await client.search(query, 8);
  } catch {
    return empty; // search needs the embedding model; without it the prompt still has the spec and constraints
  }
  const seen = new Set<string>();
  const files: EnhanceContext['files'] = [];
  for (const h of hits) {
    const key = `${h.path}:${h.name}`;
    if (seen.has(key) || !h.path) continue;
    seen.add(key);
    files.push({ path: h.path, symbol: h.name, kind: h.kind });
    if (files.length >= 8) break;
  }
  const impactFiles = new Set<string>();
  let callers = 0;
  let worst: 'high' | 'medium' | 'low' = 'high';
  const rank = { high: 2, medium: 1, low: 0 } as const;
  const h = client.open();
  try {
    for (const hit of hits.filter((x: any) => ['function', 'method', 'class'].includes(x.kind)).slice(0, 3)) {
      const id = hit.symbolId ?? hit.id;
      if (id == null) continue;
      const imp: ImpactResult | undefined = impactOfSymbol(h.store, id, { hops: 2 });
      if (!imp) continue;
      for (const c of imp.callers) {
        if (c.path) impactFiles.add(c.path);
      }
      callers += imp.callers.length;
      if (rank[imp.confidence] < rank[worst]) worst = imp.confidence;
    }
  } finally {
    h.close();
  }
  const modules = new Set(files.map((f) => f.path.split('/').slice(0, 3).join('/'))).size;
  const top = [...impactFiles].slice(0, 3).join(', ');
  return { files, impact: { callers, files: [...impactFiles], confidence: callers || files.length ? worst : 'unknown', top }, modules };
}

export function capFor(cfg: DevSarathiConfig, ctx: EnhanceContext, criteria: Criterion[]): number {
  const score = (ctx.files.length > 3 ? 1 : 0) + (ctx.modules > 1 ? 1 : 0) + (criteria.length > 4 ? 1 : 0) + (ctx.impact.files.length > 5 ? 1 : 0);
  return Math.min(cfg.thresholds.enhanceCeilingChars, cfg.thresholds.enhanceTargetChars + score * 300);
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function compose(opts: { request: string; spec?: ParsedSpec; ctx: EnhanceContext; questions: string[]; cap: number }): Composed {
  const { request, spec, ctx, questions, cap } = opts;
  const criteria = spec?.criteria ?? [];

  const build = (level: number): string => {
    const lines: string[] = [];
    lines.push(`Task: ${oneLine(request, level >= 2 ? 160 : 240)}`);
    lines.push(spec ? `Spec: ${spec.ref}${criteria.length ? ` (${criteria[0].id}..${criteria[criteria.length - 1].id})` : ''}` : 'Spec: none given');
    const nFiles = [8, 6, 4, 2][Math.min(level, 3)];
    const fl = ctx.files.slice(0, nFiles).map((f) => `${f.path}:${f.symbol}`);
    if (fl.length) lines.push(`Files: ${fl.join(', ')}`);
    if (ctx.impact.callers > 0) {
      lines.push(`Impact: ${ctx.impact.callers} caller(s) in ${ctx.impact.files.length} file(s), confidence ${ctx.impact.confidence}${level <= 1 && ctx.impact.top ? `: ${ctx.impact.top}` : ''}`);
    } else if (ctx.files.length) {
      lines.push('Impact: run `devsarathi impact <symbol>` before editing');
    }
    lines.push(`Constraints: follow ${CORE}; impact lookup before every edit; scope = spec only; tests required`);
    if (criteria.length) {
      const text = criteria.map((c) => (level === 0 ? `${c.id} ${oneLine(c.text, 90)}` : level === 1 ? `${c.id} ${oneLine(c.text, 40)}` : c.id));
      lines.push(`Acceptance: ${text.join('; ')}`);
    }
    if (questions.length) lines.push(`Open questions: ${questions.map((q) => oneLine(q, level >= 2 ? 60 : 110)).join('; ')}`);
    return lines.join('\n');
  };

  let level = 0;
  let prompt = build(0);
  while (prompt.length > cap && level < 3) prompt = build(++level);
  return { prompt, chars: prompt.length, cap, trimmed: level > 0, overCap: prompt.length > cap };
}
