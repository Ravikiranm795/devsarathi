import { registerCommand, CommandDef } from '../registry';
import { computeMetrics } from '../metrics/compute';
import { writeReports } from '../metrics/report';

const metrics: CommandDef = {
  name: 'metrics',
  description: 'Show local metrics; with --report also write report.md and report.docx from the same JSON',
  args: [{ name: 'report', type: 'boolean', description: 'Regenerate the markdown and Word reports' }],
  needsInit: true,
  async run(ctx, args) {
    const m = computeMetrics(ctx.repoRoot);
    const t = m.turnsPerTask;
    const lines = [
      `Prompts enhanced: ${m.prompts.enhanced} (accepted ${m.prompts.accepted}, edited ${m.prompts.edited}, rejected ${m.prompts.rejected}).`,
      `Turns per task: baseline ${t.baseline.avgTurns ?? 'n/a'} (${t.baseline.tasks} tasks) vs with enhancer ${t.withEnhancer.avgTurns ?? 'n/a'} (${t.withEnhancer.tasks} tasks).`,
      `Reviews: ${m.review.runs}, red flags at push: ${m.review.redFlagsAtPush}, findings acted on: ${m.review.findingsActedOn}.`,
      `Graph builds: ${m.graph.builds} (failed ${m.graph.failures}). Active days: ${m.usage.activeDays}.`
    ];
    if (args.report) {
      const r = await writeReports(ctx.repoRoot, m);
      lines.push(`Reports written: ${r.md} and ${r.docx}`);
    }
    return { ok: true, message: lines.join('\n'), data: m };
  }
};

registerCommand(metrics);
