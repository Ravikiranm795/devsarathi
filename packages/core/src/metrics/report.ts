import * as path from 'path';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { Metrics } from './compute';
import { writeFileAtomic } from '../lib/fsutil';
import { repoPaths } from '../lib/paths';

export interface Section {
  heading: string;
  paragraphs: string[];
  table?: { head: string[]; rows: string[][] };
}

const pct = (v: number | null) => (v == null ? 'not enough data yet' : `${(v * 100).toFixed(0)}%`);
const num = (v: number | null, unit = '') => (v == null ? 'not enough data yet' : `${v}${unit}`);

/** One list of sections feeds BOTH the markdown and the Word report, so the two can never disagree. */
export function sections(m: Metrics): Section[] {
  const t = m.turnsPerTask;
  return [
    {
      heading: 'Summary',
      paragraphs: [
        `Repo ${m.repo}. Generated ${m.generatedAt.slice(0, 10)} by DevSarathi ${m.toolVersion}. Everything here comes from local counts: no prompt text, code or secret values are stored, and nothing leaves this machine.`,
        `Active days: ${m.usage.activeDays}. Prompts enhanced: ${m.prompts.enhanced}. Reviews run: ${m.review.runs}. Graph builds: ${m.graph.builds}.`
      ]
    },
    {
      heading: 'Efficiency: turns per task',
      paragraphs: [
        t.note,
        `Baseline (first ${m.baselineWindow.days} days, no enhancer): ${num(t.baseline.avgTurns)} turns per task over ${t.baseline.tasks} task(s). With the enhancer: ${num(t.withEnhancer.avgTurns)} over ${t.withEnhancer.tasks} task(s).`,
        t.improvement == null ? 'No before-and-after comparison yet: it needs tasks in both groups.' : `${t.improvement >= 0 ? 'Fewer' : 'More'} turns with the enhancer: ${pct(Math.abs(t.improvement))}.`,
        `Acceptance rate of enhanced prompts: ${pct(m.prompts.acceptanceRate)} (accepted ${m.prompts.accepted}, edited ${m.prompts.edited}, rejected ${m.prompts.rejected}). Read it together with turns per task, because acceptance alone can be inflated.`,
        `Definition: ${t.definition}`
      ]
    },
    {
      heading: 'Review outcomes',
      paragraphs: [
        `${m.review.runs} review(s); ${m.review.pushReviews} ran at push. Findings acted on (gone from the next review): ${m.review.findingsActedOn}. Red flags (secrets and env files) caught at push: ${m.review.redFlagsAtPush}.`
      ],
      table: {
        head: ['Severity', 'Findings'],
        rows: Object.entries(m.review.findingsBySeverity).map(([k, v]) => [k, String(v)])
      }
    },
    {
      heading: 'Findings by agent',
      paragraphs: [],
      table: { head: ['Agent', 'Findings raised', 'Acted on'], rows: Object.entries(m.review.findingsByAgent).map(([k, v]) => [k, String(v), String(m.review.findingsActedOnByAgent[k] ?? 0)]) }
    },
    {
      heading: 'Agent runs',
      paragraphs: ['A run that did not complete is counted as failed or timed out, never as a pass.'],
      table: { head: ['Agent', 'Completed', 'Failed', 'Timed out', 'Skipped'], rows: Object.entries(m.agents).map(([k, v]) => [k, String(v.completed), String(v.failed), String(v.timeout), String(v.skipped)]) }
    },
    {
      heading: 'Graph builds',
      paragraphs: [
        `Builds: ${m.graph.builds} (failed: ${m.graph.failures}). Average duration: ${num(m.graph.avgDurationMs, ' ms')}. Latest coverage: ${pct(m.graph.lastCoverage)}. Builds below the coverage threshold: ${m.graph.belowThreshold}.`
      ]
    },
    {
      heading: 'Rule changes',
      paragraphs: [`Auto-applied (low risk): ${m.rules.autoApplied}. Approved (high risk): ${m.rules.approved}. Rejected: ${m.rules.rejected}.`]
    },
    {
      heading: 'Tool usage',
      paragraphs: [`Active days: ${m.usage.activeDays}${m.usage.days.length ? ` (${m.usage.days.slice(-14).join(', ')})` : ''}.`],
      table: { head: ['Command', 'Runs'], rows: Object.entries(m.usage.commands).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]) }
    },
    {
      heading: 'Self-test',
      paragraphs: [m.selftest.runs.length ? `Last result: ${m.selftest.lastPassed ? 'all planted problems were caught' : 'some planted problems were NOT caught'}.` : 'The self-test has not run yet. Run: devsarathi selftest'],
      table: m.selftest.runs.length ? { head: ['When', 'Passed', 'Total', 'Failed checks'], rows: m.selftest.runs.slice(-10).map((r) => [r.at.slice(0, 16).replace('T', ' '), String(r.passed), String(r.total), r.failed.join(', ') || '-']) } : undefined
    }
  ];
}

export function toMarkdown(m: Metrics): string {
  const out: string[] = [`# DevSarathi metrics: ${m.repo}`, ''];
  for (const s of sections(m)) {
    out.push(`## ${s.heading}`, '');
    for (const p of s.paragraphs) out.push(p, '');
    if (s.table && s.table.rows.length) {
      out.push(`| ${s.table.head.join(' | ')} |`, `| ${s.table.head.map(() => '---').join(' | ')} |`);
      for (const r of s.table.rows) out.push(`| ${r.join(' | ')} |`);
      out.push('');
    }
  }
  return out.join('\n');
}

export async function toDocx(m: Metrics): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [new Paragraph({ text: `DevSarathi metrics: ${m.repo}`, heading: HeadingLevel.TITLE })];
  for (const s of sections(m)) {
    children.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1 }));
    for (const p of s.paragraphs) children.push(new Paragraph({ children: [new TextRun(p)], spacing: { after: 120 } }));
    if (s.table && s.table.rows.length) {
      const cell = (text: string, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold })] })] });
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: s.table.head.map((h) => cell(h, true)) }), ...s.table.rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) }))]
        })
      );
      children.push(new Paragraph({ text: '' }));
    }
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

export async function writeReports(root: string, m: Metrics): Promise<{ md: string; docx: string }> {
  const p = repoPaths(root);
  const md = path.join(p.metricsDir, 'report.md');
  const docx = path.join(p.metricsDir, 'report.docx');
  writeFileAtomic(md, toMarkdown(m));
  writeFileAtomic(docx, await toDocx(m));
  return { md, docx };
}
