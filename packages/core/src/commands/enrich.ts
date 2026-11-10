import { registerCommand, CommandDef, CommandContext } from '../registry';
import { requireConfig, saveConfig } from '../lib/config';
import { recordEvent } from '../lib/events';
import { buildStackSummary } from '../skills/summary';
import { enrichPrompt, draftEnrichment } from '../agents/enrich';
import { planWorkspace } from '../generate/service';
import { applyPlan } from '../generate/plan';
import { DevSarathiConfig } from '@devsarathi/shared';

export function enrichPreview(root: string, cfg: DevSarathiConfig): string {
  const summary = buildStackSummary(root, cfg);
  return [
    'This is EXACTLY what would be sent to Claude (headless, with NO tools at all: no files, no shell, no web):',
    '',
    enrichPrompt(summary, cfg),
    '',
    'Nothing else leaves your machine: no source code, no secrets, no env values, no file names, no repo name.',
    'The reply is checked and clamped (short items, no links, risky text dropped) and added to the agent files as a section marked "drafted by Claude". Your edits to those files always win.'
  ].join('\n');
}

/**
 * Ask (unless yes), call Claude, save enrichment.json and turn it on. Returns a one-line outcome for the summary.
 * The caller regenerates the agent files; init does that anyway, and the `enrich` command does it right after.
 */
export async function runEnrichment(ctx: CommandContext, cfg: DevSarathiConfig, opts: { yes: boolean; showPreview: boolean }): Promise<{ done: boolean; message: string }> {
  const root = ctx.repoRoot;
  const preview = enrichPreview(root, cfg);
  if (opts.showPreview) process.stderr.write(`\n${preview}\n\n`);
  let agreed = opts.yes;
  if (!agreed) {
    if (!ctx.ask) return { done: false, message: 'Agent guidance from Claude was skipped (nothing is sent without your yes). Run: devsarathi enrich' };
    agreed = await ctx.ask.confirm('Send this stack summary to Claude to draft stack-specific guidance for each agent file?', true);
  }
  if (!agreed) return { done: false, message: 'Nothing was sent. The agent files use the built-in stack checklists. You can add Claude\'s guidance later with: devsarathi enrich' };
  ctx.progress('Generating agents', 'asking Claude to draft stack guidance (a minute or so)');
  try {
    const file = await draftEnrichment(root, cfg, buildStackSummary(root, cfg));
    cfg.enrich = { enabled: true, at: file.generatedAt };
    recordEvent(root, { type: 'enrich', data: { agents: Object.keys(file.agents).length } });
    return { done: true, message: `Claude drafted stack guidance for ${Object.keys(file.agents).length} agent(s); it is marked "drafted by Claude" in each file.` };
  } catch (err) {
    return { done: false, message: `Claude's guidance did not run: ${err instanceof Error ? err.message : String(err)}. The agent files use the built-in stack checklists; retry with: devsarathi enrich` };
  }
}

const enrich: CommandDef = {
  name: 'enrich',
  description: 'Optional: have Claude draft stack-specific guidance for each agent file (sends the stack summary only, after you preview it)',
  args: [
    { name: 'preview', type: 'boolean', description: 'Only show the exact payload that would be sent' },
    { name: 'yes', type: 'boolean', description: 'Agree to send the previewed summary (non-interactive)' }
  ],
  needsInit: true,
  async run(ctx, args) {
    const cfg = requireConfig(ctx.repoRoot);
    if (args.preview) return { ok: true, message: enrichPreview(ctx.repoRoot, cfg) };
    const r = await runEnrichment(ctx, cfg, { yes: !!args.yes, showPreview: true });
    if (!r.done) return { ok: !!args.yes ? false : true, message: r.message, exitCode: args.yes ? 1 : 0 };
    saveConfig(ctx.repoRoot, cfg);
    const { plan } = planWorkspace(ctx.repoRoot, cfg);
    const agentsOnly = { ...plan, files: plan.files.filter((f) => f.kind === 'agent') };
    const applied = applyPlan(ctx.repoRoot, cfg, agentsOnly);
    cfg.managedFiles = applied.managedFiles;
    saveConfig(ctx.repoRoot, cfg);
    const kept = applied.skipped.map((s) => `  kept ${s.path}: ${s.reason}`);
    return { ok: true, message: [r.message, `Updated ${applied.written.length} agent file(s).`, ...kept].join('\n') };
  }
};

registerCommand(enrich);
