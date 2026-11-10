import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_SCHEMA_VERSION, DevSarathiConfig, GRAPH_FORMAT_VERSION } from '@devsarathi/shared';
import { registerCommand, CommandDef } from '../registry';
import { requireConfig, saveConfig, TOOL_VERSION } from '../lib/config';
import { repoPaths } from '../lib/paths';
import { writeFileAtomic, ensureDir, readJson } from '../lib/fsutil';
import { git } from '../lib/git';
import { planWorkspace } from '../generate/service';
import { applyPlan, PlannedFile } from '../generate/plan';
import { stripStamp } from '../generate/templates';
import { installRunner } from '../hooks/runner';
import { installGitHooks } from '../hooks/gitHooks';
import { mergeSettings } from '../hooks/settings';
import { mergeClaudeMd } from '../hooks/claudemd';
import { runAudit } from './workspace';
import { formatAudit } from '../audit/auditor';
import { BuildRecord } from '@devsarathi/shared';

/**
 * Config/graph-format migration steps (MAINTAINER 1.4). Add one when the config shape or the graph format
 * changes. Each step moves `schemaVersion` forward by exactly one and must be safe to run twice.
 */
export interface MigrationStep {
  from: number;
  to: number;
  describe: string;
  run(root: string, cfg: DevSarathiConfig): void;
}

export const MIGRATIONS: MigrationStep[] = [];

export function pendingMigrations(cfg: DevSarathiConfig): MigrationStep[] {
  return MIGRATIONS.filter((m) => m.from >= cfg.schemaVersion).sort((a, b) => a.from - b.from);
}

async function unifiedDiff(a: string, b: string, root: string): Promise<string> {
  const r = await git(['diff', '--no-index', '--no-color', '--', a, b], root);
  return r.stdout.split('\n').slice(4).join('\n').trim(); // drop the diff/index/---/+++ header lines
}

async function mergeProposal(root: string, f: PlannedFile): Promise<{ file: string; conflicts: number } | undefined> {
  const p = repoPaths(root);
  const abs = path.join(root, ...f.path.split('/'));
  const base = path.join(p.state, 'generated', ...f.path.split('/'));
  if (!fs.existsSync(base)) return undefined; // no recorded base: cannot merge, only report
  const tmp = path.join(p.state, 'migrate', 'new', ...f.path.split('/'));
  writeFileAtomic(tmp, f.content);
  const out = path.join(p.state, 'migrate', 'merged', ...f.path.split('/'));
  ensureDir(path.dirname(out));
  fs.copyFileSync(abs, out);
  // ours = the developer's file, base = what DevSarathi generated last time, theirs = what it generates now
  const r = await git(['merge-file', '-L', 'yours', '-L', 'previous template', '-L', 'new template', out, base, tmp], root);
  const conflicts = r.code ?? 0;
  return { file: out, conflicts };
}

const migrate: CommandDef = {
  name: 'migrate',
  description: 'Bring generated files up to the installed version: shows a diff, never overwrites your edits, offers a 3-way merge instead',
  args: [
    { name: 'yes', type: 'boolean', description: 'Apply without asking' },
    { name: 'check', type: 'boolean', description: 'Only report what would change' }
  ],
  needsInit: true,
  async run(ctx, args) {
    const root = ctx.repoRoot;
    const cfg = requireConfig(root);
    const p = repoPaths(root);
    const lines: string[] = [];

    // 1. config migration steps
    const steps = pendingMigrations(cfg);
    lines.push(steps.length ? `Config steps: ${steps.map((s) => s.describe).join('; ')}` : `Config is current (schema ${cfg.schemaVersion}, tool ${TOOL_VERSION}).`);

    // 2. what the installed templates would generate now, compared with what is on disk
    const { plan } = planWorkspace(root, cfg);
    const created = plan.files.filter((f) => f.status === 'new');
    const updated = plan.files.filter((f) => f.status === 'update');
    const edited = plan.files.filter((f) => f.status === 'dev-edited');
    const clash = plan.files.filter((f) => f.status === 'skipped-clash');

    const diffs: string[] = [];
    for (const f of updated) {
      const tmp = path.join(p.state, 'migrate', 'new', ...f.path.split('/'));
      writeFileAtomic(tmp, stripStamp(f.content));
      const cur = path.join(p.state, 'migrate', 'cur', ...f.path.split('/'));
      writeFileAtomic(cur, stripStamp(fs.readFileSync(path.join(root, ...f.path.split('/')), 'utf8')));
      diffs.push(`--- ${f.path}\n${await unifiedDiff(cur, tmp, root)}`);
    }

    // 3. files you edited: never overwritten; a 3-way merge is written aside instead
    const merges: string[] = [];
    for (const f of edited) {
      const base = path.join(p.state, 'generated', ...f.path.split('/'));
      const changedUpstream = fs.existsSync(base) && stripStamp(fs.readFileSync(base, 'utf8')) !== stripStamp(f.content);
      if (!changedUpstream) continue;
      const m = await mergeProposal(root, f);
      merges.push(m ? `${f.path}: merged copy at ${path.relative(root, m.file)}${m.conflicts ? ` (${m.conflicts} conflict(s) to resolve by hand)` : ' (merges cleanly)'}` : `${f.path}: template changed, but there is no base copy to merge with`);
    }

    // 4. graph format
    const rec = readJson<BuildRecord>(p.buildRecord);
    const graphStale = !!rec && rec.graphFormat !== GRAPH_FORMAT_VERSION;

    lines.push(
      `New files: ${created.length}. Updates to unedited files: ${updated.length}. Kept (you edited them): ${edited.length}. Skipped (name clash): ${clash.length}.`
    );
    if (created.length) lines.push(...created.map((f) => `  + ${f.path}`));
    if (diffs.length) lines.push('', 'Changes to files you have not edited:', ...diffs);
    if (merges.length) lines.push('', 'Template changes to files you edited (yours are untouched):', ...merges.map((m) => `  ${m}`));
    if (graphStale) lines.push('', `The graph format changed (${rec!.graphFormat} -> ${GRAPH_FORMAT_VERSION}). Rebuild it: devsarathi graph build --full`);
    for (const w of plan.warnings.filter((x) => !/already exists|edited by you/.test(x))) lines.push(`Note: ${w}`);

    const nothing = !steps.length && !created.length && !updated.length;
    if (args.check) return { ok: true, message: lines.join('\n'), data: { created: created.length, updated: updated.length, edited: edited.length } };
    if (nothing) {
      // still refresh DevSarathi's own runner and hooks: they are always ours
      const runner = installRunner(root);
      cfg.gitHooks = (await installGitHooks(root, cfg, runner.path)).installed;
      cfg.toolVersion = TOOL_VERSION;
      saveConfig(root, cfg);
      return { ok: true, message: `${lines.join('\n')}\nNothing to change.` };
    }

    let go = !!args.yes;
    if (!go && ctx.ask) go = await ctx.ask.confirm('Apply these changes? (your edits are never overwritten)', true);
    if (!go) return { ok: true, message: `${lines.join('\n')}\n\nNothing was changed. Run again with --yes to apply.` };

    for (const s of steps) {
      s.run(root, cfg);
      cfg.schemaVersion = s.to;
    }
    cfg.schemaVersion = Math.max(cfg.schemaVersion, CONFIG_SCHEMA_VERSION);
    const applied = applyPlan(root, cfg, plan);
    cfg.managedFiles = applied.managedFiles;
    const runner = installRunner(root);
    cfg.gitHooks = (await installGitHooks(root, cfg, runner.path)).installed;
    if (cfg.settingsMerged) mergeSettings(root, true); // approval was given at init; the entries are refreshed, never duplicated
    if (cfg.claudeMd) mergeClaudeMd(root, true); // likewise: the block is refreshed in place
    cfg.toolVersion = TOOL_VERSION;
    saveConfig(root, cfg);

    const audit = runAudit(root);
    lines.push('', `Applied: ${applied.written.length} file(s) written.`, formatAudit(audit));
    return { ok: true, message: lines.join('\n'), data: { written: applied.written, audit: audit.status } };
  }
};

registerCommand(migrate);
