import * as fs from 'fs';
import * as path from 'path';
import { DevSarathiConfig, ManagedFile, TEMPLATE_VERSION, AGENT_IDS } from '@devsarathi/shared';
import { DetectedStack } from '../detect/detect';
import { repoPaths } from '../lib/paths';
import { sha256, toPosix, normalizeEol, writeFileAtomic, exists, ensureDir } from '../lib/fsutil';
import { readJson } from '../lib/fsutil';
import { templatesRoot } from '../lib/paths';
import {
  Rule,
  RuleFileKey,
  parseTemplateRules,
  resolveRules,
  orderRules,
  renderRuleLine,
  Dropped
} from '../rules/engine';
import { ruleTable, agentTable, commandTable, stackInline } from './indexdoc';
import { testHandoff, testHandoffSentence, handoffTable } from './handoffs';
import { agentNameFor, teamTable, stackChecklist, loadEnrichment, enrichmentSection } from './agentdocs';
import {
  StackProfileFiles,
  loadStackProfile,
  readBaseTemplate,
  substitute,
  splitFrontMatter,
  stamp,
  stripStamp,
  buildVars
} from './templates';

export type FileStatus = 'new' | 'unchanged' | 'update' | 'dev-edited' | 'skipped-clash';
export type FileKind = 'rule' | 'agent' | 'command';

export interface PlannedFile {
  path: string; // repo-relative, posix
  kind: FileKind;
  content: string;
  status: FileStatus;
  tokens: number;
  loading: 'always' | 'on-demand' | 'on-invoke';
  source: string;
  note?: string;
}

export interface Plan {
  files: PlannedFile[];
  dropped: Dropped[];
  warnings: string[];
  alwaysLoadedTokens: number;
  graphRules: number;
}

export interface PlanInput {
  root: string;
  cfg: DevSarathiConfig;
  stacks: DetectedStack[];
  /** Graph-derived rules; omitted when the graph is missing or below the coverage threshold (D-10). */
  graphRules?: Rule[];
  now?: Date;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const RULE_FILES: { key: RuleFileKey; file: string; template: string }[] = [
  { key: 'core', file: 'ds-core.md', template: 'rules/ds-core.md' },
  { key: 'architecture', file: 'ds-architecture.md', template: 'rules/ds-architecture.md' },
  { key: 'naming-style', file: 'ds-naming-style.md', template: 'rules/ds-naming-style.md' },
  { key: 'testing', file: 'ds-testing.md', template: 'rules/ds-testing.md' }
];

function titleOf(body: string): string {
  const m = /^#\s+(.*)$/m.exec(body);
  return m ? m[1] : '';
}

function renderRuleFile(opts: {
  front?: string;
  title: string;
  rules: Rule[];
  source: string;
  now?: Date;
}): string {
  const lines = orderRules(opts.rules).map(renderRuleLine);
  const head = opts.front !== undefined ? `---\n${opts.front}\n---\n` : '';
  const body = `# ${opts.title}\n\n${lines.join('\n')}\n`;
  return stamp(head + body, opts.source, opts.now);
}

/** What is on disk versus what we would write: drives preview and apply. */
export function statusOf(root: string, cfg: DevSarathiConfig, relPath: string, content: string): FileStatus {
  const abs = path.join(root, ...relPath.split('/'));
  if (!exists(abs)) return 'new';
  const managed = cfg.managedFiles.find((m) => m.path === relPath);
  if (!managed) return 'skipped-clash';
  const onDisk = normalizeEol(fs.readFileSync(abs, 'utf8'));
  if (sha256(onDisk) !== managed.hash) return 'dev-edited';
  return stripStamp(onDisk) === stripStamp(content) ? 'unchanged' : 'update';
}

export function buildPlan(input: PlanInput): Plan {
  const { root, cfg, stacks, now } = input;
  const warnings: string[] = [];
  const tpl = templatesRoot();

  const profiles = new Map<string, StackProfileFiles>();
  for (const s of stacks) {
    const p = loadStackProfile(s.id, tpl);
    if (p) profiles.set(s.id, p);
    else warnings.push(`No profile found for stack "${s.id}"; only the generic rules are generated for it.`);
  }
  const vars: Record<string, string> = { ...buildVars(cfg, stacks, profiles), testHandoff: testHandoff(cfg), testHandoffSentence: testHandoffSentence(cfg), handoffTable: handoffTable(cfg) };
  const graphRules = input.graphRules ?? [];
  const commitTag = graphRules[0]?.source ?? '';
  const sourceTag = `template@${TEMPLATE_VERSION}${commitTag ? `+${commitTag}` : ''}`;

  // ---- rules: collect from every template, resolve topics globally, then render per file -----------------------
  const fronts = new Map<RuleFileKey, { front?: string; title: string; file: string }>();
  const all: Rule[] = [];
  for (const rf of RULE_FILES) {
    const text = substitute(readBaseTemplate(rf.template, tpl), vars);
    const { front, body } = splitFrontMatter(text);
    fronts.set(rf.key, { front, title: titleOf(body), file: rf.file });
    all.push(...parseTemplateRules(body, rf.key, TEMPLATE_VERSION));
  }
  for (const s of stacks) {
    const p = profiles.get(s.id);
    if (!p?.ruleTemplate) continue;
    const key: RuleFileKey = `stack-${s.id}`;
    const stackVars = { ...vars, stackGlobs: JSON.stringify(0) };
    const globs = [...(p.globs.source ?? []), ...(p.globs.test ?? [])].map((g) => (s.dir === '.' ? g : `${s.dir}/${g}`));
    stackVars.stackGlobs = `[${globs.map((g) => JSON.stringify(g)).join(', ')}]`;
    const text = substitute(p.ruleTemplate, stackVars);
    const { front, body } = splitFrontMatter(text);
    fronts.set(key, { front, title: titleOf(body), file: `ds-stack-${s.id}.md` });
    all.push(...parseTemplateRules(body, key, TEMPLATE_VERSION));
  }
  all.push(...graphRules);

  const { kept, dropped } = resolveRules(all);
  const files: PlannedFile[] = [];
  const cap = cfg.thresholds.ruleCapPerFile;

  for (const [key, meta] of fronts) {
    let rules = kept.filter((r) => r.file === key);
    if (rules.length === 0 && key !== 'core') continue;
    if (rules.length > cap) {
      warnings.push(`${meta.file} has ${rules.length} rules, over the soft cap of ${cap}. Consolidation needs your approval.`);
      rules = orderRules(rules).slice(0, cap);
    }
    const content = renderRuleFile({ front: meta.front, title: meta.title, rules, source: sourceTag, now });
    const rel = `.claude/rules/${meta.file}`;
    files.push({
      path: rel,
      kind: 'rule',
      content,
      status: statusOf(root, cfg, rel, content),
      tokens: estimateTokens(content),
      loading: key === 'core' ? 'always' : 'on-demand',
      source: sourceTag
    });
  }

  const enrichment = loadEnrichment(root, cfg);
  // ---- agents ---------------------------------------------------------------------------------------------------
  for (const id of AGENT_IDS) {
    if (id !== 'developer' && cfg.agents[id as keyof DevSarathiConfig['agents']] === false) continue;
    const agentVars = { ...vars, agentName: agentNameFor(cfg, id), teamTable: teamTable(cfg), stackChecklist: stackChecklist(stacks, profiles, id, vars), enrichment: enrichmentSection(enrichment, id) };
    // an empty {{enrichment}} leaves a gap: collapse runs of blank lines
    const text = substitute(readBaseTemplate(`agents/ds-${id}.md`, tpl), agentVars).replace(/\n{3,}/g, '\n\n');
    const content = stamp(text, `template@${TEMPLATE_VERSION}`, now);
    const rel = `.claude/agents/ds-${id}.md`;
    files.push({ path: rel, kind: 'agent', content, status: statusOf(root, cfg, rel, content), tokens: estimateTokens(content), loading: 'on-invoke', source: `template@${TEMPLATE_VERSION}` });
  }

  // ---- commands -------------------------------------------------------------------------------------------------
  const commands = readJson<{ file: string; cli: string; description: string; hint: string; body: string }[]>(path.join(tpl, 'base', 'commands.json')) ?? [];
  for (const c of commands) {
    const front = [`description: ${c.description}`, c.hint ? `argument-hint: ${c.hint}` : '', 'allowed-tools: Bash(devsarathi *)'].filter(Boolean).join('\n');
    const content = stamp(`---\n${front}\n---\n${c.body}\n`, `template@${TEMPLATE_VERSION}`, now);
    const rel = `.claude/commands/${c.file}.md`;
    files.push({ path: rel, kind: 'command', content, status: statusOf(root, cfg, rel, content), tokens: estimateTokens(content), loading: 'on-invoke', source: `template@${TEMPLATE_VERSION}` });
  }

  // ---- the workspace map and the persona: always loaded, so Claude is told what exists and who it is ---------------
  const mapVars = {
    ...vars,
    stackInline: stackInline(stacks),
    buildCommand: vars.buildCommand,
    ruleTable: '',
    agentTable: agentTable(files, cfg),
    teamTable: teamTable(cfg),
    commandTable: commandTable(files)
  };
  const docFiles: { file: string; template: string }[] = [
    { file: 'ds-index.md', template: 'rules/ds-index.md' },
    { file: 'ds-persona.md', template: 'rules/ds-persona.md' }
  ];
  const withDocs: PlannedFile[] = [...files];
  for (const d of docFiles) {
    const rel = `.claude/rules/${d.file}`;
    // the rule table lists every other rule file plus these two, so build the shell first and fill it in below
    withDocs.push({ path: rel, kind: 'rule', content: '', status: 'new', tokens: 0, loading: 'always', source: sourceTag });
  }
  mapVars.ruleTable = ruleTable(withDocs);
  for (const d of docFiles) {
    const rel = `.claude/rules/${d.file}`;
    const text = substitute(readBaseTemplate(d.template, tpl), { ...mapVars, stackInline: mapVars.stackInline });
    const content = stamp(text, `template@${TEMPLATE_VERSION}`, now);
    files.push({ path: rel, kind: 'rule', content, status: statusOf(root, cfg, rel, content), tokens: estimateTokens(content), loading: 'always', source: `template@${TEMPLATE_VERSION}` });
  }

  const alwaysLoadedTokens = files.filter((f) => f.loading === 'always').reduce((n, f) => n + f.tokens, 0);
  const clashes = files.filter((f) => f.status === 'skipped-clash');
  for (const f of clashes) warnings.push(`${f.path} already exists and was not created by DevSarathi; it will be skipped.`);
  for (const f of files.filter((x) => x.status === 'dev-edited')) warnings.push(`${f.path} was edited by you; it will not be overwritten.`);

  return { files, dropped, warnings, alwaysLoadedTokens, graphRules: graphRules.length };
}

/** Token budget preview (MASTER 5.5): size of each piece and whether it is loaded always or on demand. */
export function budgetPreview(plan: Plan): string {
  const rows = plan.files.map((f) => `  ${f.status.padEnd(13)} ${String(f.tokens).padStart(5)} tok  ${f.loading.padEnd(10)} ${f.path}`);
  return [
    `Always loaded: ${plan.alwaysLoadedTokens} tokens (${plan.files.filter((f) => f.loading === 'always').map((f) => path.posix.basename(f.path)).join(', ') || 'none'}).`,
    'Per file (estimated, ~4 characters per token):',
    ...rows
  ].join('\n');
}

export interface ApplyResult {
  written: string[];
  unchanged: string[];
  skipped: { path: string; reason: string }[];
  managedFiles: ManagedFile[];
}

/**
 * Writes only new and unedited-managed files (I-5, I-10). Returns the updated managed list; the caller saves
 * the config so a crash never leaves files on disk that DevSarathi does not know it owns.
 */
export function applyPlan(root: string, cfg: DevSarathiConfig, plan: Plan): ApplyResult {
  const p = repoPaths(root);
  const written: string[] = [];
  const unchanged: string[] = [];
  const skipped: ApplyResult['skipped'] = [];
  const managed = new Map(cfg.managedFiles.map((m) => [m.path, m] as const));

  for (const f of plan.files) {
    if (f.status === 'skipped-clash') {
      skipped.push({ path: f.path, reason: 'a file with this name already exists and was not created by DevSarathi' });
      continue;
    }
    if (f.status === 'dev-edited') {
      skipped.push({ path: f.path, reason: 'you edited this file; it is never overwritten' });
      continue;
    }
    if (f.status === 'unchanged') {
      unchanged.push(f.path);
      continue;
    }
    const abs = path.join(root, ...f.path.split('/'));
    writeFileAtomic(abs, f.content);
    // The 3-way merge base for `migrate`: exactly what we generated last time.
    const base = path.join(p.state, 'generated', ...f.path.split('/'));
    writeFileAtomic(base, f.content);
    managed.set(f.path, { path: toPosix(f.path), hash: sha256(normalizeEol(f.content)), templateVersion: TEMPLATE_VERSION, source: f.source });
    written.push(f.path);
  }
  ensureDir(p.state);
  return { written, unchanged, skipped, managedFiles: [...managed.values()] };
}
