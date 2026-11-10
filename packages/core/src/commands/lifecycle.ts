import * as fs from 'fs';
import * as path from 'path';
import { DevSarathiConfig } from '@devsarathi/shared';
import { registerCommand, CommandDef, CommandContext } from '../registry';
import { loadConfig } from '../lib/config';
import { repoPaths } from '../lib/paths';
import { sha256, normalizeEol, dirSize, humanSize, exists, writeFileAtomic, ensureDir } from '../lib/fsutil';
import { uninstallGitHooks, removeGitExclude } from '../hooks/gitHooks';
import { removeSettingsEntries } from '../hooks/settings';
import { removeClaudeMd } from '../hooks/claudemd';
import { unregisterRepo } from '../lib/registry';
import { buildPlan } from '../generate/plan';
import { stacksOf } from '../generate/service';

/** Ask for a yes/no, or take `--yes`. Returns undefined when there is no way to ask. */
async function confirm(ctx: CommandContext, yes: boolean, question: string, def = false): Promise<boolean | undefined> {
  if (yes) return true;
  if (!ctx.ask) return undefined;
  return ctx.ask.confirm(question, def);
}

function rmIfEmpty(dir: string): boolean {
  try {
    if (fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      return true;
    }
  } catch {
    /* not there */
  }
  return false;
}

// ---- uninstall ------------------------------------------------------------------------------------------------------

export interface UninstallPlan {
  remove: string[];
  keepEdited: string[];
  keepMissing: string[];
}

export function planUninstall(root: string, cfg: DevSarathiConfig): UninstallPlan {
  const remove: string[] = [];
  const keepEdited: string[] = [];
  const keepMissing: string[] = [];
  for (const m of cfg.managedFiles) {
    const abs = path.join(root, ...m.path.split('/'));
    if (!exists(abs)) {
      keepMissing.push(m.path);
      continue;
    }
    if (sha256(normalizeEol(fs.readFileSync(abs, 'utf8'))) === m.hash) remove.push(m.path);
    else keepEdited.push(m.path); // the developer edited it: it is theirs now
  }
  return { remove, keepEdited, keepMissing };
}

const uninstall: CommandDef = {
  name: 'uninstall',
  description: 'Remove DevSarathi files and hooks, restore previous hooks, keep the graph and metrics (D-29)',
  args: [{ name: 'yes', type: 'boolean', description: 'Do not ask for confirmation' }],
  async run(ctx, args) {
    const root = ctx.repoRoot;
    const cfg = loadConfig(root);
    if (!cfg) return { ok: false, message: 'DevSarathi is not set up in this repo.', exitCode: 1 };
    const plan = planUninstall(root, cfg);
    const preview = [
      'Uninstall will:',
      `  remove ${plan.remove.length} DevSarathi file(s) that you have not edited`,
      plan.keepEdited.length ? `  KEEP ${plan.keepEdited.length} file(s) you edited: ${plan.keepEdited.join(', ')}` : '',
      `  remove the git hooks DevSarathi installed and restore ${cfg.gitHooks.filter((h) => h.backup).length} original hook(s)`,
      cfg.settingsMerged ? '  remove only DevSarathi\'s entries from .claude/settings.json' : '',
      cfg.claudeMd ? `  remove only the DevSarathi block from ${cfg.claudeMd.file}` : '',
      '  keep the graph and the metrics (use remove-graph / remove-metrics to delete them)',
      '  leave every file of yours under .claude untouched'
    ].filter(Boolean).join('\n');
    const ok = await confirm(ctx, !!args.yes, `${preview}\nContinue?`, false);
    if (ok === undefined) return { ok: false, message: `${preview}\nRun with --yes to confirm.`, exitCode: 2 };
    if (!ok) return { ok: true, message: 'Nothing changed.' };

    for (const rel of plan.remove) fs.rmSync(path.join(root, ...rel.split('/')), { force: true });
    // skills installed through the skills step: their files were managed too; drop the folders that are now empty
    const prune = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(dir, e.name));
      } catch {
        return;
      }
      rmIfEmpty(dir);
    };
    for (const s of cfg.skills) prune(path.join(root, '.claude', 'skills', s.name));
    for (const d of ['rules', 'agents', 'commands', 'skills']) rmIfEmpty(path.join(root, '.claude', d));
    const hooks = uninstallGitHooks(cfg);
    const settings = removeSettingsEntries(root);
    const claudeMd = cfg.claudeMd ? removeClaudeMd(root, cfg.claudeMd.file, cfg.claudeMd.created) : { removed: false, deletedFile: false };
    await removeGitExclude(root, cfg.gitExclude);

    // state: everything except the graph and the metrics
    const p = repoPaths(root);
    for (const name of fs.existsSync(p.state) ? fs.readdirSync(p.state) : []) {
      if (name === 'graph' || name === 'metrics') continue;
      fs.rmSync(path.join(p.state, name), { recursive: true, force: true });
    }
    unregisterRepo(root);
    rmIfEmpty(path.join(root, '.claude'));

    const lines = [
      `Removed ${plan.remove.length} file(s).`,
      plan.keepEdited.length ? `Kept (edited by you): ${plan.keepEdited.join(', ')}` : '',
      `Git hooks: ${hooks.restored.length} original(s) restored, ${hooks.removed.length} removed${hooks.left.length ? `, ${hooks.left.length} left (changed by someone else)` : ''}.`,
      settings.removed ? `Settings: DevSarathi entries removed${settings.deletedFile ? ' (the file was created by DevSarathi, so it was deleted)' : ''}.` : '',
      claudeMd.removed ? `CLAUDE.md: the DevSarathi block was removed${claudeMd.deletedFile ? ' (the file was created by DevSarathi, so it was deleted)' : ' (the rest of your file is untouched)'}.` : '',
      'The graph and the metrics were kept. Delete them with: devsarathi remove-graph, devsarathi remove-metrics'
    ].filter(Boolean);
    return { ok: true, message: lines.join('\n') };
  }
};

// ---- remove-graph / remove-metrics -----------------------------------------------------------------------------------

function removal(kind: 'graph' | 'metrics'): CommandDef {
  return {
    name: `remove-${kind}`,
    description: kind === 'graph' ? 'Delete the local graph data (shows sizes, asks yes or no)' : 'Delete local metrics (shows sizes, irreversible, asks yes or no)',
    args: [{ name: 'yes', type: 'boolean', description: 'Do not ask for confirmation' }],
    async run(ctx, args) {
      const p = repoPaths(ctx.repoRoot);
      const dirs = kind === 'graph' ? [p.graph, `${p.graph}.next`, `${p.graph}.old`, p.overlay] : [p.metricsDir];
      const present = dirs.filter((d) => exists(d));
      if (present.length === 0) return { ok: true, message: `There is no ${kind} data to remove.` };
      const size = present.reduce((n, d) => n + dirSize(d), 0);
      const warn = kind === 'metrics' ? ' This is irreversible: the history behind your reports and dashboard is deleted for good.' : ' It can be rebuilt with: devsarathi graph build --full';
      const q = `Delete ${kind} data (${humanSize(size)} in ${present.map((d) => path.relative(ctx.repoRoot, d)).join(', ')})?${warn}`;
      const ok = await confirm(ctx, !!args.yes, q, false);
      if (ok === undefined) return { ok: false, message: `${q}\nRun with --yes to confirm.`, exitCode: 2 };
      if (!ok) return { ok: true, message: 'Nothing deleted.' };
      for (const d of present) fs.rmSync(d, { recursive: true, force: true });
      return { ok: true, message: `Deleted ${kind} data (${humanSize(size)}).` };
    }
  };
}

// ---- export-baseline -------------------------------------------------------------------------------------------------

export const BASELINE_DIR = 'devsarathi-baseline';

const exportBaseline: CommandDef = {
  name: 'export-baseline',
  description: 'Write the template-layer rules and agents (no state, no graph) into a folder the team can commit once through a PR (D-06)',
  args: [{ name: 'out', type: 'string', description: `Output folder (default ${BASELINE_DIR}/)` }],
  needsInit: true,
  async run(ctx, args) {
    const root = ctx.repoRoot;
    const cfg = loadConfig(root);
    if (!cfg) return { ok: false, message: 'DevSarathi is not set up in this repo.', exitCode: 1 };
    const out = path.resolve(root, String(args.out ?? BASELINE_DIR));
    // Template layer only: no graph-derived rules, and a neutral persona name instead of one developer's.
    const neutral = { ...cfg, persona: { name: 'DevSarathi', title: cfg.persona.title }, managedFiles: [] };
    const plan = buildPlan({ root: out, cfg: neutral, stacks: stacksOf(cfg), graphRules: [] });
    let n = 0;
    for (const f of plan.files.filter((x) => x.kind === 'rule' || x.kind === 'agent')) {
      writeFileAtomic(path.join(out, ...f.path.split('/')), f.content);
      n++;
    }
    ensureDir(out);
    writeFileAtomic(
      path.join(out, 'README.md'),
      [
        '# DevSarathi team baseline',
        '',
        'Template-layer rules and agents, generated by `devsarathi export-baseline`. No graph, no state, no personal settings.',
        '',
        'Commit this folder through a normal PR **once**, as a shared starting point. Copy `.claude/` into your repo,',
        'or run `devsarathi init` and let it generate the same files locally. After that everything is local:',
        'pulls never update `.claude`, and DevSarathi never changes a file you edited.',
        ''
      ].join('\n')
    );
    return { ok: true, message: `Wrote ${n} file(s) to ${path.relative(root, out) || '.'}. Commit it through a PR once; nothing else is shared.` };
  }
};

registerCommand(uninstall);
registerCommand(removal('graph'));
registerCommand(removal('metrics'));
registerCommand(exportBaseline);
