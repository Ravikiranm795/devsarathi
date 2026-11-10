import * as path from 'path';
import { registerCommand, CommandDef } from '../registry';
import { DrishtiClient } from '../graph/drishti';
import { impactOfSymbol, ImpactResult } from '../graph/impact';
import { toPosix } from '../lib/fsutil';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function formatImpact(r: ImpactResult): string {
  const s = r.symbol;
  const lines = [`Impact of ${s.name} (${s.kind}) in ${s.path}:${s.startLine}. Confidence: ${r.confidence.toUpperCase()}. Tests: ${r.risk}.`];
  const callers = r.callers.filter((c) => c.relation === 'caller');
  const other = [...r.callers.filter((c) => c.relation !== 'caller'), ...r.couplings];
  lines.push(`Callers (${callers.length}):`);
  for (const c of callers.slice(0, 25)) lines.push(`  - ${c.name} (${c.path}:${c.startLine}) hops ${c.hops}, confidence ${c.confidence}`);
  if (callers.length > 25) lines.push(`  ... and ${callers.length - 25} more`);
  if (other.length) {
    lines.push(`Other couplings (${other.length}):`);
    for (const c of other.slice(0, 15)) lines.push(`  - ${c.relation}: ${c.name} (${c.path ?? '?'}${c.startLine ? `:${c.startLine}` : ''})${c.why ? ` - ${c.why}` : ''}`);
  }
  if (r.testsCovering.length) lines.push(`Tests reaching it: ${r.testsCovering.slice(0, 5).map((t) => `${t.name} (${t.path})`).join(', ')}`);
  lines.push('Why this confidence:');
  for (const why of r.reasons) lines.push(`  * ${why}`);
  return lines.join('\n');
}

const impact: CommandDef = {
  name: 'impact',
  description: 'Drishti impact lookup: callers, couplings, tests and a confidence grade for a symbol or file. Run before editing',
  args: [
    { name: 'symbol', type: 'string', description: 'Symbol name (or numeric id)', positional: true },
    { name: 'file', type: 'string', description: 'Repo-relative file path: impact for every symbol in it' }
  ],
  needsInit: true,
  async run(ctx, args) {
    const client = new DrishtiClient(ctx.repoRoot);
    if (!client.hasGraph()) return { ok: false, message: 'No graph yet. Run: devsarathi graph build', exitCode: 1 };
    if (!args.symbol && !args.file) return { ok: false, message: 'Give a symbol name, or --file <path>.', exitCode: 2 };
    const h = client.open();
    try {
      let ids: number[] = [];
      if (args.file) {
        const rel = toPosix(path.relative(ctx.repoRoot, path.resolve(ctx.repoRoot, String(args.file))));
        ids = client.symbolsInFile(h.store, rel).filter((s) => ['function', 'method', 'class'].includes(s.kind)).map((s) => s.id).slice(0, 30);
        if (ids.length === 0) return { ok: true, message: `No symbols for ${rel} in the graph (new, ignored or unparsed file). Nothing depends on it yet.` };
      } else {
        const sym = String(args.symbol);
        if (/^\d+$/.test(sym)) ids = [Number(sym)];
        else {
          const name = sym.split(/[.#:]/).filter(Boolean).pop() as string;
          ids = (h.store.db.prepare('SELECT id FROM symbols WHERE name = ? LIMIT 10').all(name) as { id: number }[]).map((r) => r.id);
        }
        if (ids.length === 0) return { ok: false, message: `No symbol named "${sym}" in the graph. It may be new, or the graph is stale: devsarathi graph build`, exitCode: 1 };
      }
      const results = ids.map((id) => impactOfSymbol(h.store, id)).filter(Boolean) as ImpactResult[];
      return { ok: true, message: results.map(formatImpact).join('\n\n'), data: results };
    } finally {
      h.close();
    }
  }
};

const search: CommandDef = {
  name: 'search',
  description: 'Semantic + lexical search over the graph',
  args: [
    { name: 'query', type: 'string', description: 'What you are looking for', positional: true, required: true },
    { name: 'k', type: 'number', description: 'Number of results (default 10)' }
  ],
  needsInit: true,
  async run(ctx, args) {
    const client = new DrishtiClient(ctx.repoRoot);
    if (!client.hasGraph()) return { ok: false, message: 'No graph yet. Run: devsarathi graph build', exitCode: 1 };
    const results = await client.search(String(args.query), Number(args.k ?? 10));
    const msg = results.map((r: any, i: number) => `${i + 1}. ${r.name} (${r.kind}) ${r.path}:${r.startLine}  [${r.confidence ?? ''}]`).join('\n');
    return { ok: true, message: msg || 'No results.', data: results };
  }
};

registerCommand(impact);
registerCommand(search);
