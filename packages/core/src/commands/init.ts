import * as fs from 'fs';
import * as path from 'path';
import {
  ConfigSchema,
  DevSarathiConfig,
  MIN_NODE_MAJOR,
  BASELINE_BRANCH_CANDIDATES,
  OPTIONAL_AGENTS,
  AGENT_ROLES,
  DEFAULT_AGENT_NAMES,
  STATE_DIR,
  Stack
} from '@devsarathi/shared';
import { registerCommand, CommandDef, CommandContext, CommandResult } from '../registry';
import { loadConfig, saveConfig, TOOL_VERSION } from '../lib/config';
import { repoPaths } from '../lib/paths';
import { ensureDir } from '../lib/fsutil';
import { git, isGitRepo, localBranches, currentBranch } from '../lib/git';
import { detectStacks, personaTitle, DetectedStack } from '../detect/detect';
import { buildGraphLocked, describeOutcome } from './graph';
import { runEnrichment } from './enrich';
import { planWorkspace, STACK_NAMES } from '../generate/service';
import { applyPlan, budgetPreview, Plan } from '../generate/plan';
import { runAudit } from './workspace';
import { installRunner } from '../hooks/runner';
import { installGitHooks, addGitExclude } from '../hooks/gitHooks';
import { previewSettingsMerge, mergeSettings } from '../hooks/settings';
import { previewClaudeMd, mergeClaudeMd } from '../hooks/claudemd';
import { registerRepo } from '../lib/registry';
import { formatAudit } from '../audit/auditor';
import { writeNotice } from '../lib/failopen';
import { recordEvent } from '../lib/events';

/* The init flow, MASTER 5. Interactive in a terminal or the VS Code wizard; `--yes` takes the defaults. */

function toStack(s: DetectedStack): Stack {
  return {
    id: s.id,
    category: s.category,
    dir: s.dir,
    frameworks: s.frameworks,
    testFramework: s.testFramework,
    linter: s.linter,
    buildTool: s.buildTool,
    packageManager: s.packageManager,
    stateManagement: s.stateManagement
  };
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface InitAnswers {
  baselineBranch: string;
  personaName: string;
  personaTitle: string;
  agents: DevSarathiConfig['agents'];
  specsPath?: string;
}

async function defaultPersonaName(root: string): Promise<string> {
  const r = await git(['config', 'user.name'], root);
  const first = r.ok ? r.stdout.trim().split(/\s+/)[0] : '';
  return first || 'Sarathi';
}

async function suggestBaseline(root: string): Promise<{ suggested: string; options: string[] }> {
  const branches = await localBranches(root);
  const options = BASELINE_BRANCH_CANDIDATES.filter((b) => branches.includes(b));
  const current = await currentBranch(root);
  return { suggested: options[0] ?? (current !== 'HEAD' ? current : 'main'), options: options.length ? options : [current !== 'HEAD' ? current : 'main'] };
}

function describeStacks(stacks: DetectedStack[]): string {
  return stacks.map((s) => `${s.displayName}${s.dir !== '.' ? ` (in ${s.dir}/)` : ''}${s.frameworks.length ? ` [${s.frameworks.join(', ')}]` : ''}`).join(', ');
}

function previewText(plan: Plan, settingsText: string): string {
  const groups = { new: [] as string[], update: [] as string[], unchanged: [] as string[], 'dev-edited': [] as string[], 'skipped-clash': [] as string[] };
  for (const f of plan.files) groups[f.status].push(f.path);
  const lines = ['Files DevSarathi will create or change (nothing else is touched):'];
  if (groups.new.length) lines.push(`  NEW (${groups.new.length}):`, ...groups.new.map((p) => `    + ${p}`));
  if (groups.update.length) lines.push(`  UPDATE (${groups.update.length}, unedited by you):`, ...groups.update.map((p) => `    ~ ${p}`));
  if (groups['skipped-clash'].length) lines.push(`  SKIPPED, a file with that name exists and is not DevSarathi's (${groups['skipped-clash'].length}):`, ...groups['skipped-clash'].map((p) => `    ! ${p}`));
  if (groups['dev-edited'].length) lines.push(`  KEPT, you edited them (${groups['dev-edited'].length}):`, ...groups['dev-edited'].map((p) => `    = ${p}`));
  lines.push(`  Also: git hooks (post-merge, post-rewrite, pre-push), chained onto any existing ones, and ${STATE_DIR}/ for local state.`);
  lines.push('', settingsText);
  return lines.join('\n');
}

const init: CommandDef = {
  name: 'init',
  description: 'Set up DevSarathi in this repo: detect the stack, build the graph, generate the Claude workspace, install hooks',
  args: [
    { name: 'yes', type: 'boolean', description: 'Accept the defaults without prompting' },
    { name: 'baseline', type: 'string', description: 'Baseline branch name' },
    { name: 'persona', type: 'string', description: 'Developer persona name' },
    { name: 'title', type: 'string', description: 'Persona title (required when more than two stacks are detected)' },
    { name: 'agentNames', type: 'string', description: 'Names for the agents, e.g. tester=Tara,security=Raksha,peer-review=Mitra,auditor=Lekha (the developer agent uses --persona)' },
    { name: 'enrich', type: 'boolean', description: 'Have Claude draft stack-specific guidance for each agent file (sends the stack summary only)' },
    { name: 'agents', type: 'string', description: 'Optional agents to keep: all, none, or a comma list of tester,security,peer-review,auditor' },
    { name: 'specs', type: 'string', description: 'Path or glob where specs live' },
    { name: 'stacks', type: 'string', description: 'Keep only these detected stacks (comma list of ids), e.g. angular,java' },
    { name: 'approveSettings', type: 'boolean', description: 'Approve merging hook entries into an existing .claude/settings.json' },
    { name: 'skipHooks', type: 'boolean', description: 'Do not install git hooks or Claude Code hook entries' },
    { name: 'claudeMd', type: 'boolean', description: 'Add the DevSarathi import block to CLAUDE.md so Claude loads the workspace map, persona and core rules every session (creates .claude/CLAUDE.md if none exists)' },
    { name: 'preview', type: 'boolean', description: 'Only show everything that would be created (nothing is written)' }
  ],
  async run(ctx, args) {
    const root = ctx.repoRoot;
    const ask = ctx.ask;
    const yes = !!args.yes;
    if (!ask && !yes) return { ok: false, message: 'init is interactive. Run it in a terminal, or pass --yes (with --baseline, --persona and --title as needed).', exitCode: 2 };

    // 1. preflight --------------------------------------------------------------------------------------------
    ctx.progress('Scanning', 'preflight checks');
    const major = Number(process.versions.node.split('.')[0]);
    if (major < MIN_NODE_MAJOR) return { ok: false, message: `DevSarathi needs Node ${MIN_NODE_MAJOR} or newer (this is ${process.versions.node}).`, exitCode: 1 };
    if (!(await isGitRepo(root))) return { ok: false, message: `${root} is not a git repository. Run init from inside one.`, exitCode: 1 };
    if (!isWritable(root)) return { ok: false, message: `No write access to ${root}.`, exitCode: 1 };
    const existing = loadConfig(root);
    if (existing) {
      const again = yes || (ask ? await ask.confirm('DevSarathi is already set up here. Refresh it? (your edits are kept)', true) : true);
      if (!again) return { ok: true, message: 'Nothing changed.' };
    }

    // 2. detect ------------------------------------------------------------------------------------------------
    const det = detectStacks(root);
    let stacks = det.stacks;
    ctx.progress('Scanning', stacks.length ? `detected ${describeStacks(stacks)}` : 'no supported stack detected');
    for (const n of det.notes) ctx.progress('Scanning', n);
    if (stacks.length === 0) {
      return { ok: false, message: `${det.notes.join(' ')} DevSarathi supports Angular, React, Java, Python and PHP. Add a profile under templates/profiles/ to support another stack.`, exitCode: 1 };
    }
    if (args.stacks !== undefined) {
      const keep = String(args.stacks).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      stacks = stacks.filter((s) => keep.includes(s.id));
      if (stacks.length === 0) return { ok: false, message: `None of the detected stacks match --stacks ${args.stacks}. Detected: ${describeStacks(det.stacks)}.`, exitCode: 2 };
    } else if (ask && !yes) {
      const ok = await ask.confirm(`Detected: ${describeStacks(stacks)}. Is that right?`, true);
      if (!ok) {
        const keep = await ask.multi('Which stacks does this repo really use?', stacks.map((s) => ({ value: s.id, label: s.displayName, checked: true })));
        stacks = stacks.filter((s) => keep.includes(s.id));
      }
    }

    // 3. baseline branch ------------------------------------------------------------------------------------------
    const sug = await suggestBaseline(root);
    let baseline = String(args.baseline ?? existing?.baselineBranch ?? '');
    if (!baseline) baseline = ask && !yes ? await ask.choose('Which branch is the baseline (the graph is built from it)?', sug.options, sug.suggested) : sug.suggested;

    // 4. questions -----------------------------------------------------------------------------------------------
    let personaName = String(args.persona ?? existing?.persona.name ?? '');
    if (!personaName) personaName = ask && !yes ? await ask.text("What is the developer agent's (persona's) name?", await defaultPersonaName(root)) : await defaultPersonaName(root);
    const proposed = personaTitle(stacks.map((s) => ({ id: s.id, category: s.category })), STACK_NAMES);
    let title = String(args.title ?? existing?.persona.title ?? '');
    if (!title) {
      if (proposed.needsConfirmation) {
        if (!ask || yes) {
          if (!args.title) return { ok: false, message: `More than two stacks were detected (${describeStacks(stacks)}), so the persona title must be confirmed. Pass --title "<title>", for example "${proposed.title}".`, exitCode: 2 };
        } else title = await ask.text('More than two stacks detected. Confirm or edit the persona title', proposed.title);
      } else title = proposed.title;
    }
    if (!title) title = proposed.title;

    const agents = { tester: true, security: true, 'peer-review': true, auditor: true } as DevSarathiConfig['agents'];
    if (args.agents !== undefined) {
      const v = String(args.agents).trim().toLowerCase();
      const keep = v === 'all' ? [...OPTIONAL_AGENTS] : v === 'none' ? [] : v.split(',').map((s) => s.trim());
      for (const a of OPTIONAL_AGENTS) agents[a] = keep.includes(a);
    } else if (existing) {
      Object.assign(agents, existing.agents);
    } else if (ask && !yes) {
      for (const a of OPTIONAL_AGENTS) agents[a] = await ask.confirm(`Create the ${a} agent?`, true);
    }
    // Each agent gets its own name (the developer agent uses the persona's name): "Tara, the tester", "Raksha, the security reviewer"...
    const agentNames: Record<string, string> = { ...(existing?.agentNames ?? {}) };
    if (args.agentNames !== undefined) {
      for (const pair of String(args.agentNames).split(',')) {
        const [k, ...rest] = pair.split('=');
        const id = k.trim().toLowerCase();
        const name = rest.join('=').trim();
        if (!name) continue;
        if (!(OPTIONAL_AGENTS as readonly string[]).includes(id)) return { ok: false, message: `Unknown agent "${id}" in --agent-names. Use: ${OPTIONAL_AGENTS.join(', ')} (the developer agent uses --persona).`, exitCode: 2 };
        agentNames[id] = name;
      }
    } else if (!existing && ask && !yes) {
      for (const a of OPTIONAL_AGENTS) {
        if (agents[a]) agentNames[a] = (await ask.text(`What is the ${AGENT_ROLES[a].toLowerCase()} agent's name (ds-${a})?`, DEFAULT_AGENT_NAMES[a])) || DEFAULT_AGENT_NAMES[a];
      }
    }
    const specsPath = args.specs !== undefined ? String(args.specs) : existing?.specsPath ?? (ask && !yes ? (await ask.text('Where do specs live (path or glob, optional)?', '')) || undefined : undefined);

    const cfg: DevSarathiConfig = ConfigSchema.parse({
      ...(existing ?? {}),
      toolVersion: TOOL_VERSION,
      baselineBranch: baseline,
      persona: { name: personaName, title },
      stacks: stacks.map(toStack),
      agents,
      agentNames,
      specsPath,
      initializedAt: existing?.initializedAt ?? new Date().toISOString()
    });
    // Preview only: show the files, sizes and settings merge, and write nothing (used by the VS Code wizard).
    if (args.preview) {
      const wp = planWorkspace(root, cfg);
      const sp = previewSettingsMerge(root);
      return {
        ok: true,
        message: `${budgetPreview(wp.plan)}\n\n${previewText(wp.plan, sp.text)}`,
        data: {
          files: wp.plan.files.map((f) => ({ path: f.path, status: f.status, tokens: f.tokens, loading: f.loading })),
          alwaysLoadedTokens: wp.plan.alwaysLoadedTokens,
          warnings: wp.plan.warnings,
          settings: { exists: sp.exists, valid: sp.valid, alreadyMerged: sp.alreadyMerged, text: sp.text },
          claudeMd: (() => {
            const cm = previewClaudeMd(root);
            return { file: cm.target.rel, exists: cm.target.exists, alreadyMerged: cm.alreadyMerged, recommended: cm.recommended, text: cm.text };
          })()
        }
      };
    }
    ensureDir(repoPaths(root).state);
    saveConfig(root, cfg);

    // 5 + 6. budget and full preview (template layer; graph rules are added after the build) -------------------------
    const draft = planWorkspace(root, cfg).plan;
    const settingsPreview = previewSettingsMerge(root);
    if (!args.skipHooks) {
      const text = `${budgetPreview(draft)}\n(Graph-derived rules, added after the graph is built, stay within each file's cap of ${cfg.thresholds.ruleCapPerFile} rules.)\n\n${previewText(draft, settingsPreview.text)}`;
      ctx.progress('Scanning', 'preview of everything that will be created');
      process.stderr.write(`\n${text}\n\n`);
    }
    if (ask && !yes) {
      const go = await ask.confirm('Create these files and install the hooks?', true);
      if (!go) return { ok: true, message: 'Cancelled. Nothing was created except DevSarathi\'s own config.' };
    }

    // 7. graph ---------------------------------------------------------------------------------------------------
    ctx.progress('Building graph', 'this runs in the background and has no time cap');
    const notes: string[] = [];
    let graphMessage = '';
    try {
      const built = await buildGraphLocked(root, { full: !existing, progress: ctx.progress });
      graphMessage = built.outcome ? describeOutcome(built.outcome) : 'A graph build was already running.';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeNotice(root, 'init', `Graph build failed during init: ${msg}`);
      notes.push(`The graph could not be built (${msg}). Only the template rules were generated. Retry with: devsarathi graph build`);
      graphMessage = 'No graph.';
    }

    // 7b. optional: Claude drafts stack-specific guidance for each agent file (the stack summary only, previewed first) ----
    if (args.enrich || (ask && !yes && !cfg.enrich.enabled)) {
      const r = await runEnrichment(ctx, cfg, { yes: !!args.enrich, showPreview: true });
      notes.push(r.message);
      saveConfig(root, cfg);
    } else if (!cfg.enrich.enabled) {
      notes.push('Optional: have Claude draft stack-specific guidance for each agent file with: devsarathi enrich');
    }

    // 8. workspace ------------------------------------------------------------------------------------------------
    ctx.progress('Generating rules');
    const { plan, graphSkipped } = planWorkspace(root, cfg);
    ctx.progress('Generating agents');
    const applied = applyPlan(root, cfg, plan);
    cfg.managedFiles = applied.managedFiles;
    saveConfig(root, cfg);

    // 9. hooks -----------------------------------------------------------------------------------------------------
    let hookSummary = 'Hooks were skipped (--skip-hooks).';
    if (!args.skipHooks) {
      ctx.progress('Installing hooks');
      const runner = installRunner(root);
      const gh = await installGitHooks(root, cfg, runner.path);
      cfg.gitHooks = gh.installed;
      notes.push(...gh.notes);
      const added = await addGitExclude(root, [`${STATE_DIR}/`]);
      cfg.gitExclude = [...new Set([...cfg.gitExclude, ...added])];

      let settingsLine: string;
      let approved = !settingsPreview.exists || !!args.approveSettings;
      if (settingsPreview.exists && !approved && ask) approved = await ask.confirm('Merge DevSarathi\'s hook entries into your existing .claude/settings.json? (a backup is made first)', false);
      const merged = mergeSettings(root, approved);
      if (merged.merged) {
        cfg.settingsMerged = true;
        if (merged.backup) cfg.settingsBackup = merged.backup;
        settingsLine = merged.backup ? `Claude Code hook entries merged into .claude/settings.json (backup: ${path.relative(root, merged.backup)}).` : 'Claude Code hook entries are in .claude/settings.json.';
      } else {
        settingsLine = `Claude Code hook entries were NOT added (${merged.reason}). The session-start status line and the stop hook are off until you approve: devsarathi init --approve-settings`;
      }
      saveConfig(root, cfg);
      hookSummary = `Git hooks installed (${cfg.gitHooks.map((h) => h.hook).join(', ')}). ${settingsLine}`;
    }

    // 9b. CLAUDE.md: have Claude load the map, persona and core rules (opt-in: it is a file DevSarathi did not create)
    {
      const cm = previewClaudeMd(root);
      let want = !!args.claudeMd || cm.alreadyMerged;
      if (!want && ask && !yes) want = await ask.confirm(`${cm.text}

Add this block so Claude loads them every session?`, cm.recommended);
      if (want) {
        const r = mergeClaudeMd(root, true);
        if (r.merged) {
          cfg.claudeMd = { file: r.file as string, created: r.created ?? !cm.target.exists, backup: r.backup ?? cfg.claudeMd?.backup };
          saveConfig(root, cfg);
          notes.push(`CLAUDE.md: the DevSarathi import block is in ${r.file}${r.backup ? ` (backup: ${path.relative(root, r.backup)})` : ''}, so Claude loads the workspace map, persona and core rules every session.`);
        }
      } else if (cm.target.exists && !cm.alreadyMerged) {
        notes.push(`Claude will see the DevSarathi rules through .claude/rules/. To also import them from ${cm.target.rel}, run: devsarathi init --claude-md`);
      }
    }

    // 10. audit ---------------------------------------------------------------------------------------------------
    ctx.progress('Auditing');
    const audit = runAudit(root);

    // 11. registry --------------------------------------------------------------------------------------------------
    try {
      registerRepo({ path: root, stacks: stacks.map((s) => s.id), baselineBranch: baseline });
    } catch (err) {
      notes.push(`Could not register the repo for the dashboard: ${err instanceof Error ? err.message : String(err)}`);
    }
    recordEvent(root, { type: 'init', data: { stacks: stacks.length, filesWritten: applied.written.length } });

    // 12. skills (optional, opt-in, last) ---------------------------------------------------------------------------
    // Offered only in an interactive session; the skills command shows the exact payload before anything is sent.
    const skills = ask && !yes ? await ask.confirm('Optional: research and install Claude skills for this stack? (sends a stack summary only, after you preview it)', false) : false;
    if (skills) {
      const { getCommand } = await import('../registry');
      const cmd = getCommand('skills');
      if (cmd) notes.push((await cmd.run(ctx as CommandContext, {})).message);
      else notes.push('The skills step is not available in this build.');
    }

    // 13. summary -----------------------------------------------------------------------------------------------------
    const lines = [
      `DevSarathi is set up for ${personaName}, ${title}.`,
      `Created ${applied.written.length} file(s), kept ${applied.unchanged.length} unchanged, skipped ${applied.skipped.length}.`,
      ...applied.skipped.map((s) => `  skipped ${s.path}: ${s.reason}`),
      graphMessage,
      graphSkipped ? `Note: ${graphSkipped}` : '',
      hookSummary,
      formatAudit(audit),
      ...notes,
      '',
      'Try next: devsarathi status | /ds-review | devsarathi impact <symbol> | devsarathi dashboard'
    ].filter((l) => l !== '');
    return { ok: true, message: lines.join('\n'), data: { written: applied.written, skipped: applied.skipped, audit: audit.status } };
  }
};

registerCommand(init);

export type { CommandResult };
