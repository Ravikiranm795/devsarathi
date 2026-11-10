import { registerCommand, CommandDef } from '../registry';
import { requireConfig } from '../lib/config';
import { repoPaths } from '../lib/paths';
import { runWithQueue } from '../lib/locks';
import { DrishtiClient, BuildOutcome } from '../graph/drishti';

/** Shared by `graph build`, `refresh`, `init` and the post-merge hook, so there is one build path (D-03). */
export async function buildGraphLocked(
  root: string,
  opts: { full?: boolean; current?: boolean; progress?: (stage: string, message?: string) => void }
): Promise<{ ran: boolean; queued: boolean; outcome?: BuildOutcome }> {
  const client = new DrishtiClient(root);
  const res = await runWithQueue(repoPaths(root).locks, 'graph', () =>
    client.build({ full: opts.full, mode: opts.current ? 'current' : 'baseline', onProgress: opts.progress })
  );
  return { ran: res.ran, queued: res.queued, outcome: res.result };
}

export function describeOutcome(o: BuildOutcome): string {
  const r = o.record;
  const lines = [
    `Graph ${r.full ? 'built' : 'refreshed'} from ${r.baseline ? 'baseline' : 'NON-BASELINE'} branch "${r.branch}" @ ${r.commit.slice(0, 7)} in ${(r.durationMs / 1000).toFixed(1)}s.`,
    `Coverage: ${r.coverage.parsedFiles}/${r.coverage.eligibleFiles} code files (${(r.coverage.ratio * 100).toFixed(0)}%), ${r.coverage.symbols} symbols.`
  ];
  lines.push(...o.notes);
  return lines.join('\n');
}

const graphBuild: CommandDef = {
  name: 'graph build',
  description: 'Build or incrementally refresh the Drishti graph (baseline branch by default; any branch with --current, labeled)',
  args: [
    { name: 'full', type: 'boolean', description: 'Rebuild from scratch instead of incrementally' },
    { name: 'current', type: 'boolean', description: 'Build the checked-out branch and label it non-baseline' }
  ],
  needsInit: true,
  async run(ctx, args) {
    requireConfig(ctx.repoRoot);
    const res = await buildGraphLocked(ctx.repoRoot, {
      full: !!args.full,
      current: !!args.current,
      progress: ctx.progress
    });
    if (!res.ran) {
      return { ok: true, message: 'A graph build is already running. One follow-up run is queued and will start when it finishes.' };
    }
    const outcome = res.outcome as BuildOutcome;
    return { ok: true, message: describeOutcome(outcome), data: outcome.record };
  }
};

registerCommand(graphBuild);
