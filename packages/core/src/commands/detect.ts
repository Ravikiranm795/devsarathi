import { OPTIONAL_AGENTS, MIN_NODE_MAJOR, BASELINE_BRANCH_CANDIDATES } from '@devsarathi/shared';
import { registerCommand, CommandDef } from '../registry';
import { loadConfig } from '../lib/config';
import { git, isGitRepo, localBranches, currentBranch } from '../lib/git';
import { detectStacks, personaTitle } from '../detect/detect';
import { STACK_NAMES } from '../generate/service';

/** What the init wizard needs to ask good questions: detection, baseline suggestions, persona defaults. Read-only. */
const detect: CommandDef = {
  name: 'detect',
  description: 'Detect the stack and suggest init answers (baseline branch, persona title). Writes nothing',
  args: [],
  async run(ctx) {
    const root = ctx.repoRoot;
    const isRepo = await isGitRepo(root);
    const det = detectStacks(root);
    const title = personaTitle(det.stacks.map((s) => ({ id: s.id, category: s.category })), STACK_NAMES);
    const branches = isRepo ? await localBranches(root) : [];
    const current = isRepo ? await currentBranch(root) : '';
    const options = BASELINE_BRANCH_CANDIDATES.filter((b) => branches.includes(b));
    const fallback = current && current !== 'HEAD' ? current : 'main';
    const name = isRepo ? (await git(['config', 'user.name'], root)).stdout.trim().split(/\s+/)[0] : '';
    const existing = loadConfig(root);
    const data = {
      node: { version: process.versions.node, ok: Number(process.versions.node.split('.')[0]) >= MIN_NODE_MAJOR, required: MIN_NODE_MAJOR },
      git: { isRepo, currentBranch: current },
      initialized: !!existing,
      existing: existing ? { baselineBranch: existing.baselineBranch, persona: existing.persona, agents: existing.agents, agentNames: existing.agentNames, specsPath: existing.specsPath ?? null } : null,
      stacks: det.stacks.map((s) => ({ id: s.id, name: s.displayName, category: s.category, dir: s.dir, frameworks: s.frameworks, testFramework: s.testFramework ?? null, linter: s.linter ?? null, buildTool: s.buildTool ?? null })),
      notes: det.notes,
      baseline: { suggested: options[0] ?? fallback, options: options.length ? options : [fallback] },
      persona: { defaultName: name || 'Sarathi', proposedTitle: title.title, needsConfirmation: title.needsConfirmation },
      optionalAgents: [...OPTIONAL_AGENTS]
    };
    const msg = det.stacks.length
      ? `Detected: ${det.stacks.map((s) => s.displayName + (s.dir !== '.' ? ` (in ${s.dir}/)` : '')).join(', ')}. Suggested persona title: ${title.title}${title.needsConfirmation ? ' (please confirm)' : ''}.`
      : det.notes.join(' ');
    return { ok: true, message: msg, data };
  }
};

registerCommand(detect);
