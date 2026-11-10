import * as fs from 'fs';
import * as path from 'path';
import { DevSarathiConfig, TEMPLATE_VERSION, StackId } from '@devsarathi/shared';
import { templatesRoot } from '../lib/paths';
import { readJson, normalizeEol } from '../lib/fsutil';
import { DetectedStack } from '../detect/detect';
import { TOOL_VERSION } from '../lib/config';

export interface StackProfileFiles {
  persona: { titleFragment: string; category: string };
  commands: Record<string, Record<string, string>>;
  security: { focus: string; patterns: SecurityPattern[] };
  globs: { source: string[]; test: string[] };
  ruleTemplate: string;
  /** Stack checklists per agent id (agents.json). */
  agents?: Record<string, string[]>;
}

export interface SecurityPattern {
  id: string;
  re: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  ext: string[];
}

export function loadStackProfile(id: StackId | string, root = templatesRoot()): StackProfileFiles | undefined {
  const dir = path.join(root, 'profiles', id);
  const persona = readJson<StackProfileFiles['persona']>(path.join(dir, 'persona.json'));
  if (!persona) return undefined;
  let ruleTemplate = '';
  try {
    ruleTemplate = normalizeEol(fs.readFileSync(path.join(dir, `ds-stack-${id}.md`), 'utf8'));
  } catch {
    /* profile without a rule template: allowed, the stack just has no strict rules */
  }
  return {
    persona,
    commands: readJson(path.join(dir, 'commands.json')) ?? {},
    security: readJson(path.join(dir, 'security.json')) ?? { focus: '', patterns: [] },
    globs: readJson(path.join(dir, 'globs.json')) ?? { source: [], test: [] },
    agents: readJson(path.join(dir, 'agents.json')),
    ruleTemplate
  };
}

export function readBaseTemplate(rel: string, root = templatesRoot()): string {
  return normalizeEol(fs.readFileSync(path.join(root, 'base', rel), 'utf8'));
}

export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export interface FrontMatterSplit {
  front?: string; // the lines between the --- markers, without them
  body: string;
}

export function splitFrontMatter(content: string): FrontMatterSplit {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!m) return { body: content };
  return { front: m[1], body: content.slice(m[0].length) };
}

export const STAMP_RE = /^<!-- devsarathi-version:[^>]*-->\n?/m;

export function stampLine(source: string, now = new Date()): string {
  return `<!-- devsarathi-version: ${TOOL_VERSION} | template: ${TEMPLATE_VERSION} | generated: ${now.toISOString()} | source: ${source} -->`;
}

/** Insert the version stamp right after the front matter (or at the top when there is none). */
export function stamp(content: string, source: string, now?: Date): string {
  const { front, body } = splitFrontMatter(content);
  const line = stampLine(source, now);
  return front !== undefined ? `---\n${front}\n---\n${line}\n${body.replace(/^\n+/, '')}` : `${line}\n${content}`;
}

/** Content with the stamp removed, so regenerating does not look like a change. */
export function stripStamp(content: string): string {
  return normalizeEol(content).replace(STAMP_RE, '');
}

export function parseStamp(content: string): { version?: string; template?: string; source?: string } {
  const m = /<!-- devsarathi-version: ([^|]*)\| template: ([^|]*)\| generated: [^|]*\| source: ([^>]*?)\s*-->/.exec(content);
  return m ? { version: m[1].trim(), template: m[2].trim(), source: m[3].trim() } : {};
}

// ---- variables -------------------------------------------------------------------------------------------------

export function stackCommand(
  stack: DetectedStack,
  profile: StackProfileFiles | undefined,
  kind: 'test' | 'lint' | 'build'
): { command: string; cwd: string } | undefined {
  const table = profile?.commands?.[kind];
  if (!table) return undefined;
  const key = (stack.packageManager ?? stack.buildTool ?? '').toLowerCase();
  const command = table[key] ?? table.default;
  return command ? { command, cwd: stack.dir } : undefined;
}

function where(cwd: string): string {
  return cwd === '.' ? '' : ` (in \`${cwd}/\`)`;
}

export function describeCommands(stacks: DetectedStack[], profiles: Map<string, StackProfileFiles>, kind: 'test' | 'lint' | 'build'): string {
  const parts = stacks
    .map((s) => {
      const c = stackCommand(s, profiles.get(s.id), kind);
      return c ? { s, c } : undefined;
    })
    .filter(Boolean) as { s: DetectedStack; c: { command: string; cwd: string } }[];
  if (parts.length === 0) return `the repo's ${kind} command`;
  if (parts.length === 1) return `${parts[0].c.command}${where(parts[0].c.cwd)}`;
  return parts.map(({ s, c }) => `${s.displayName}: ${c.command}${where(c.cwd)}`).join('; ');
}

export function stackSummary(stacks: DetectedStack[]): string {
  if (stacks.length === 0) return 'No supported stack was detected; follow the repository conventions.';
  return stacks
    .map((s) => {
      const bits = [s.frameworks.length ? `frameworks: ${s.frameworks.join(', ')}` : '', s.testFramework ? `tests: ${s.testFramework}` : '', s.linter ? `lint: ${s.linter}` : '', s.buildTool ? `build: ${s.buildTool}` : '', s.stateManagement ? `state: ${s.stateManagement}` : '']
        .filter(Boolean)
        .join('; ');
      return `- ${s.displayName}${s.dir !== '.' ? ` (in \`${s.dir}/\`)` : ''}${bits ? ` (${bits})` : ''}`;
    })
    .join('\n');
}

function withDir(globs: string[], dir: string): string[] {
  return dir === '.' ? globs : globs.map((g) => `${dir}/${g}`);
}

export const quoteList = (globs: string[]): string => `[${globs.map((g) => JSON.stringify(g)).join(', ')}]`;

export function buildVars(
  cfg: DevSarathiConfig,
  stacks: DetectedStack[],
  profiles: Map<string, StackProfileFiles>
): Record<string, string> {
  const src = stacks.flatMap((s) => withDir(profiles.get(s.id)?.globs.source ?? [], s.dir));
  const tst = stacks.flatMap((s) => withDir(profiles.get(s.id)?.globs.test ?? [], s.dir));
  return {
    personaName: cfg.persona.name,
    personaTitle: cfg.persona.title,
    primaryStack: stacks[0]?.id ?? 'generic',
    sourceGlobs: quoteList(src.length ? [...new Set(src)] : ['**/*']),
    testGlobs: quoteList(tst.length ? [...new Set(tst)] : ['**/*test*']),
    testCommand: describeCommands(stacks, profiles, 'test'),
    lintCommand: describeCommands(stacks, profiles, 'lint'),
    buildCommand: describeCommands(stacks, profiles, 'build'),
    testFramework: stacks.map((s) => s.testFramework).filter(Boolean).join(', ') || 'the repo test framework',
    stackSummary: stackSummary(stacks),
    stackInline: '',
    securityFocus: stacks.map((s) => profiles.get(s.id)?.security.focus).filter(Boolean).join(' ')
  };
}

export { withDir };
