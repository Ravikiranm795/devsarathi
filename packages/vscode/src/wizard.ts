/*
 * The init wizard's pure half (MASTER 5, D-25): read what `devsarathi detect --json` found and turn the developer's
 * answers into flags for `devsarathi init`. The questions themselves are asked in flows.ts.
 */

export interface DetectStack {
  id: string;
  name: string;
  category: string;
  dir: string;
  frameworks: string[];
}

export interface DetectData {
  node: { version: string; ok: boolean; required: number };
  git: { isRepo: boolean; currentBranch: string };
  initialized: boolean;
  existing?: { baselineBranch: string; personaName?: string; personaTitle?: string; agents: Record<string, boolean>; agentNames: Record<string, string>; specsPath?: string };
  stacks: DetectStack[];
  notes: string[];
  baseline: { suggested: string; options: string[] };
  persona: { defaultName: string; proposedTitle: string; needsConfirmation: boolean };
  optionalAgents: string[];
}

const arrStr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export function parseDetect(data: unknown): DetectData | undefined {
  const d = rec(data);
  const baseline = rec(d?.baseline);
  const persona = rec(d?.persona);
  if (!d || !baseline || !persona || !Array.isArray(d.stacks)) return undefined;
  const node = rec(d.node);
  const git = rec(d.git);
  const existing = rec(d.existing);
  const existingPersona = rec(existing?.persona);
  const options = arrStr(baseline.options);
  const suggested = typeof baseline.suggested === 'string' ? baseline.suggested : options[0] ?? 'main';
  return {
    node: { version: String(node?.version ?? ''), ok: node?.ok !== false, required: typeof node?.required === 'number' ? node.required : 20 },
    git: { isRepo: git?.isRepo !== false, currentBranch: typeof git?.currentBranch === 'string' ? git.currentBranch : '' },
    initialized: d.initialized === true,
    existing: existing
      ? {
          baselineBranch: String(existing.baselineBranch ?? ''),
          personaName: typeof existingPersona?.name === 'string' ? existingPersona.name : undefined,
          personaTitle: typeof existingPersona?.title === 'string' ? existingPersona.title : undefined,
          agents: Object.fromEntries(Object.entries(rec(existing.agents) ?? {}).map(([k, v]) => [k, v !== false])),
          agentNames: Object.fromEntries(Object.entries(rec(existing.agentNames) ?? {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v as string])),
          specsPath: typeof existing.specsPath === 'string' ? existing.specsPath : undefined
        }
      : undefined,
    stacks: d.stacks.map(rec).filter((s): s is Record<string, unknown> => !!s).map((s) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? s.id ?? ''),
      category: String(s.category ?? ''),
      dir: String(s.dir ?? '.'),
      frameworks: arrStr(s.frameworks)
    })),
    notes: arrStr(d.notes),
    baseline: { suggested, options: options.length ? options : [suggested] },
    persona: { defaultName: typeof persona.defaultName === 'string' && persona.defaultName ? persona.defaultName : 'Sarathi', proposedTitle: String(persona.proposedTitle ?? ''), needsConfirmation: persona.needsConfirmation === true },
    optionalAgents: arrStr(d.optionalAgents)
  };
}

/** Why the wizard cannot go on, if it cannot (init's own preflight, shown before the developer answers anything). */
export function preflightProblems(d: DetectData): string[] {
  const out: string[] = [];
  if (!d.node.ok) out.push(`DevSarathi needs Node ${d.node.required} or newer (found ${d.node.version}).`);
  if (!d.git.isRepo) out.push('This folder is not a git repository. Run git init (or open the repository folder) and try again.');
  if (d.stacks.length === 0) out.push(`${d.notes.join(' ') || 'No supported stack was detected.'} DevSarathi supports Angular, React, Java, Python and PHP.`);
  return out;
}

export function describeStack(s: DetectStack): string {
  return `${s.name}${s.dir !== '.' ? ` (in ${s.dir}/)` : ''}${s.frameworks.length ? ` [${s.frameworks.join(', ')}]` : ''}`;
}

export interface WizardAnswers {
  baseline: string;
  persona: string;
  /** What the developer typed in the title step. May be empty only when the stack count does not need confirmation. */
  title: string;
  /** The optional agents the developer said yes to. */
  agents: string[];
  specs?: string;
  /** Name for each optional agent that was kept (agent id -> name). The developer agent uses the persona's name. */
  agentNames?: Record<string, string>;
  /** Have Claude draft stack-specific guidance for the agent files (opt-in; sends the stack summary only). */
  enrich?: boolean;
  /** Add the import block to CLAUDE.md so Claude loads the map, persona and core rules every session. */
  claudeMd?: boolean;
}

/** The defaults `devsarathi init` uses when no name is given: shown as the starting value of each name prompt. */
export const DEFAULT_AGENT_NAMES: Record<string, string> = { tester: 'Tara', security: 'Raksha', 'peer-review': 'Mitra', auditor: 'Lekha' };
export const AGENT_LABELS: Record<string, string> = { tester: 'tester', security: 'security reviewer', 'peer-review': 'peer reviewer', auditor: 'auditor' };

export const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateBranch(v: string): string | undefined {
  return SAFE_BRANCH.test(v.trim()) && !v.includes('..') ? undefined : 'Use a branch name such as main or release/1.0.';
}

export function validatePersona(v: string): string | undefined {
  const t = v.trim();
  if (!t) return 'A name is required.';
  if (t.length > 60 || /[\r\n]/.test(t)) return 'Use a short single-line name.';
  return undefined;
}

/** With more than two stacks the developer must confirm or edit the title (D-24): an empty title is not allowed then. */
export function validateTitle(v: string, needsConfirmation: boolean): string | undefined {
  const t = v.trim();
  if (needsConfirmation && !t) return 'More than two stacks were detected: please confirm or edit the persona title.';
  if (t.length > 80 || /[\r\n]/.test(t)) return 'Use a short single-line title.';
  return undefined;
}

export function agentsFlag(selected: string[], all: string[]): 'all' | 'none' | string {
  const chosen = all.filter((a) => selected.includes(a));
  if (chosen.length === all.length) return 'all';
  if (chosen.length === 0) return 'none';
  return chosen.join(',');
}

/**
 * Flags for `init`, in `--name=value` form so a value can never be read as another option. `--yes` is always present:
 * the extension has already asked every question, and init without a TTY refuses to prompt.
 */
export function buildInitFlags(d: DetectData, a: WizardAnswers): string[] {
  const titleError = validateTitle(a.title, d.persona.needsConfirmation);
  if (titleError) throw new Error(titleError);
  const personaError = validatePersona(a.persona);
  if (personaError) throw new Error(personaError);
  const branchError = validateBranch(a.baseline);
  if (branchError) throw new Error(branchError);
  const flags = [
    '--yes',
    `--baseline=${a.baseline.trim()}`,
    `--persona=${a.persona.trim()}`,
    `--title=${a.title.trim() || d.persona.proposedTitle}`,
    `--agents=${agentsFlag(a.agents, d.optionalAgents)}`
  ];
  if (a.specs?.trim()) flags.push(`--specs=${a.specs.trim()}`);
  const names = Object.entries(a.agentNames ?? {}).filter(([id]) => a.agents.includes(id));
  for (const [id, name] of names) {
    const err = validatePersona(name) ?? (/[,=]/.test(name) ? 'Agent names cannot contain commas or equals signs.' : undefined);
    if (err) throw new Error(`${id}: ${err}`);
  }
  if (names.length) flags.push(`--agent-names=${names.map(([id, name]) => `${id}=${name.trim()}`).join(',')}`);
  if (a.enrich) flags.push('--enrich');
  if (a.claudeMd) flags.push('--claude-md');
  return flags;
}

// --- the preview (`init --preview --json`) ----------------------------------------------------------------------------

export interface PreviewFile {
  path: string;
  status: string;
  tokens: number;
  loading: string;
}

export interface InitPreview {
  files: PreviewFile[];
  alwaysLoadedTokens: number;
  warnings: string[];
  settings: { exists: boolean; valid: boolean; alreadyMerged: boolean; text: string };
}

export function parseInitPreview(data: unknown): InitPreview | undefined {
  const d = rec(data);
  const s = rec(d?.settings);
  if (!d || !Array.isArray(d.files) || !s) return undefined;
  return {
    files: d.files.map(rec).filter((f): f is Record<string, unknown> => !!f).map((f) => ({ path: String(f.path ?? ''), status: String(f.status ?? ''), tokens: typeof f.tokens === 'number' ? f.tokens : 0, loading: String(f.loading ?? '') })),
    alwaysLoadedTokens: typeof d.alwaysLoadedTokens === 'number' ? d.alwaysLoadedTokens : 0,
    warnings: arrStr(d.warnings),
    settings: { exists: s.exists === true, valid: s.valid !== false, alreadyMerged: s.alreadyMerged === true, text: String(s.text ?? '') }
  };
}

const STATUS_LABEL: Record<string, string> = {
  new: 'NEW',
  update: 'UPDATE (you have not edited it)',
  unchanged: 'unchanged',
  'dev-edited': 'KEPT (you edited it)',
  'skipped-clash': 'SKIPPED (a file with that name exists and is not DevSarathi\'s)'
};

/** Markdown for the read-only preview document: token budget first, then every file grouped by what will happen to it. */
export function buildPreviewDoc(p: InitPreview): string {
  const lines: string[] = ['# DevSarathi init: preview', '', 'Nothing has been written yet. Close this tab to cancel, or go back to the dialog to continue.', ''];
  lines.push('## Token budget', '', `Always loaded in every Claude session: **${p.alwaysLoadedTokens} tokens**. The rest loads on demand.`, '');
  lines.push('| File | Status | Tokens | Loaded |', '| --- | --- | ---: | --- |');
  for (const f of p.files) lines.push(`| \`${f.path}\` | ${STATUS_LABEL[f.status] ?? f.status} | ${f.tokens} | ${f.loading} |`);
  lines.push('');
  const groups = new Map<string, PreviewFile[]>();
  for (const f of p.files) groups.set(f.status, [...(groups.get(f.status) ?? []), f]);
  lines.push('## Files', '');
  for (const key of ['new', 'update', 'skipped-clash', 'dev-edited', 'unchanged']) {
    const g = groups.get(key);
    if (g?.length) lines.push(`### ${STATUS_LABEL[key]} (${g.length})`, '', ...g.map((f) => `- ${f.path}`), '');
  }
  if (p.warnings.length) lines.push('## Warnings', '', ...p.warnings.map((w) => `- ${w}`), '');
  lines.push('## Settings merge', '', p.settings.text || (p.settings.exists ? '.claude/settings.json exists.' : 'No .claude/settings.json yet: DevSarathi creates it.'), '');
  lines.push('Also: git hooks (post-merge, post-rewrite, pre-push) chained onto any existing ones, and `.claude/devsarathi/` for local state.', '');
  return lines.join('\n');
}

/** Whether to ask the settings-merge question at all (it is asked only when a file exists and the entries are not there yet). */
export function settingsNeedApproval(p: InitPreview): 'ask' | 'invalid' | 'no' {
  if (!p.settings.exists || p.settings.alreadyMerged) return 'no';
  return p.settings.valid ? 'ask' : 'invalid';
}
