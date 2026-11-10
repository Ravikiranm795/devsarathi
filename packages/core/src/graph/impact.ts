import { Confidence } from '@devsarathi/shared';
import { brain } from './brain';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ImpactItem {
  symbolId: number | null;
  name: string;
  kind?: string;
  path: string | null;
  startLine?: number;
  hops: number;
  relation: string;
  confidence: number;
  why?: string;
}

export interface ImpactResult {
  symbol: { symbolId: number; name: string; kind: string; path: string | null; startLine: number; endLine: number };
  callers: ImpactItem[];
  couplings: ImpactItem[];
  testsCovering: { name: string; path: string | null }[];
  risk: 'covered' | 'weakly-covered' | 'untested';
  /** MASTER 7.5: static graphs miss dynamic references, so every result says how far to trust it, and why. */
  confidence: Confidence;
  reasons: string[];
}

const DYNAMIC_NOTE =
  'Static analysis cannot see reflection, DI by string, runtime lookups or dynamic imports; this list may be incomplete.';

/** Everything the graph knows about "what breaks if I change this symbol", with a confidence grade. */
export function impactOfSymbol(store: any, symbolId: number, opts: { hops?: number } = {}): ImpactResult | undefined {
  const symbol = store.getSymbolById(symbolId);
  if (!symbol) return undefined;
  const file = store.getFileById(symbol.file_id);
  const callersRaw: any[] = store.getCallers(symbolId, opts.hops ?? 3, { limit: 300, minConfidence: 0 });
  const tests: any[] = store.getTestsForSymbol(symbolId, 6, { limit: 20, minConfidence: 0 });

  const callers: ImpactItem[] = callersRaw.map((c) => ({
    symbolId: c.symbolId,
    name: c.name,
    kind: c.kind,
    path: c.path,
    startLine: c.startLine,
    hops: c.hops,
    relation: c.relation,
    confidence: c.confidence
  }));

  const fi = brain.frameworkImpact();
  let couplings: ImpactItem[] = [];
  let dyn: { level: 'none' | 'some' | 'high'; reasons: string[] } = { level: 'none', reasons: [] };
  if (fi) {
    try {
      const sym = { id: symbol.id, name: symbol.name, path: file?.path ?? null };
      couplings = (fi.frameworkCouplings(store, sym) as any[]).map((c) => ({
        symbolId: null,
        name: c.name,
        path: c.path ?? null,
        startLine: c.line,
        hops: 1,
        relation: c.relation,
        confidence: 0.6,
        why: c.why
      }));
      dyn = fi.dynamicRiskFor(store, sym);
    } catch {
      /* framework facts are enrichment; never fail an impact lookup because of them */
    }
  }

  const reasons: string[] = [];
  let level: Confidence = 'high';
  const downgrade = (to: Confidence, ...why: string[]) => {
    const rank = { high: 2, medium: 1, low: 0 } as const;
    if (rank[to] < rank[level]) level = to;
    reasons.push(...why);
  };

  const fanout: number = store._nameFanout ? store._nameFanout(symbol.name) : 1;
  if (fanout > 1) downgrade('medium', `${fanout} symbols share the name "${symbol.name}", so name-based call edges may over-match.`);
  if (callers.some((c) => c.relation === 'caller' && c.confidence < 0.35)) downgrade('medium', 'Some callers were reached through weak (distant or ambiguous) edges.');
  if (callers.length > 0 && callers.every((c) => c.relation === 'caller')) reasons.push('Call edges are resolved by name unless a language server pass ran (build --precise).');
  if (dyn.level === 'some') downgrade('medium', ...dyn.reasons.slice(0, 1));
  if (dyn.level === 'high') downgrade('low', ...dyn.reasons.slice(0, 2));
  if (callers.length === 0 && couplings.length === 0) {
    downgrade('medium', 'No callers found: this may be an entry point, or it is invoked dynamically (framework wiring, routing, reflection).');
  }
  reasons.push(DYNAMIC_NOTE);

  const strongest = tests.reduce((m, t) => Math.max(m, t.confidence || 0), 0);
  const risk = strongest >= 0.2 ? 'covered' : tests.length ? 'weakly-covered' : 'untested';

  return {
    symbol: { symbolId: symbol.id, name: symbol.name, kind: symbol.kind, path: file?.path ?? null, startLine: symbol.start_line, endLine: symbol.end_line },
    callers,
    couplings,
    testsCovering: tests.map((t) => ({ name: t.name, path: t.path ?? t.file_path ?? null })),
    risk,
    confidence: level,
    reasons
  };
}
