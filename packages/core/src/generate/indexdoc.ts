import * as path from 'path';
import type { PlannedFile } from './plan';
import { splitFrontMatter } from './templates';
import { DetectedStack } from '../detect/detect';
import { DevSarathiConfig, AgentId } from '@devsarathi/shared';
import { agentNameFor } from './agentdocs';

const RULE_PURPOSE: Record<string, string> = {
  'ds-index.md': 'This map: what exists, when it loads, what to run',
  'ds-persona.md': 'Who you are in this repo, principles and hand-offs',
  'ds-core.md': 'The short, strict rules: spec first, impact before edits, minimal scope, tests, no secrets',
  'ds-architecture.md': 'Structure, module boundaries, layering, dependency injection, routes seen in the graph',
  'ds-naming-style.md': 'File and symbol naming observed in this repo, lint and style',
  'ds-testing.md': 'Where tests live, how they are named, how to run them'
};

const AGENT_PURPOSE: Record<string, string> = {
  'ds-developer': 'Implements a spec or ticket with the persona, impact lookup before every edit, then hands off to ds-tester',
  'ds-tester': 'Checks changed logic has tests, runs the stack test command, maps results to acceptance criteria. Read-only',
  'ds-security': 'Reviews the staged and unpushed diff for secrets, injection, unsafe configuration and risky dependency changes. Read-only',
  'ds-peer-review': 'Reviews the diff against the spec, the rules and the impact list; checks every caller was considered. Read-only',
  'ds-auditor': 'Audits these generated files for contradictions, duplicates, vague rules, missing evidence and broken references. Never edits'
};

function loads(f: PlannedFile): string {
  if (f.loading === 'always') return 'always';
  const { front } = splitFrontMatter(f.content);
  const m = front ? /^paths:\s*(.*)$/m.exec(front) : null;
  return m ? `on demand: ${m[1].replace(/[\[\]"]/g, '').trim()}` : 'on demand';
}

const code = (s: string) => `\`${s}\``;

export function ruleTable(files: PlannedFile[]): string {
  const rows = files
    .filter((f) => f.kind === 'rule')
    .map((f) => {
      const name = path.posix.basename(f.path);
      const stack = /^ds-stack-(.+)\.md$/.exec(name);
      const purpose = RULE_PURPOSE[name] ?? (stack ? `Strict ${stack[1]} rules: dependency injection, layering, security, tests` : 'Rules');
      return `| ${code(name)} | ${loads(f)} | ${purpose} |`;
    });
  return ['| File | Loads | Covers |', '|------|-------|--------|', ...rows].join('\n');
}

export function agentTable(files: PlannedFile[], cfg: DevSarathiConfig): string {
  const rows = files
    .filter((f) => f.kind === 'agent')
    .map((f) => {
      const name = path.posix.basename(f.path, '.md');
      return `| ${agentNameFor(cfg, name.replace(/^ds-/, '') as AgentId)} | ${code(name)} | ${AGENT_PURPOSE[name] ?? 'Agent'} |`;
    });
  return ['| Name | Agent | Use it when |', '|------|-------|-------------|', ...rows].join('\n');
}

export function commandTable(files: PlannedFile[]): string {
  const rows = files
    .filter((f) => f.kind === 'command')
    .map((f) => {
      const name = path.posix.basename(f.path, '.md');
      const { front } = splitFrontMatter(f.content);
      const desc = front ? (/^description:\s*(.*)$/m.exec(front)?.[1] ?? '') : '';
      const hint = front ? (/^argument-hint:\s*(.*)$/m.exec(front)?.[1] ?? '') : '';
      return `| ${code(`/${name}${hint ? ' ' + hint : ''}`)} | ${desc} |`;
    });
  return ['| Command | What it does |', '|---------|--------------|', ...rows].join('\n');
}

/** One line per stack, no bullets: bullets in a rule file would be read as rules by the auditor. */
export function stackInline(stacks: DetectedStack[]): string {
  if (stacks.length === 0) return 'No supported stack was detected; follow the repository conventions.';
  return stacks
    .map((s) => {
      const bits = [s.frameworks.length ? `frameworks ${s.frameworks.join(', ')}` : '', s.testFramework ? `tests ${s.testFramework}` : '', s.linter ? `lint ${s.linter}` : '', s.buildTool ? `build ${s.buildTool}` : '', s.stateManagement ? `state ${s.stateManagement}` : ''].filter(Boolean).join('; ');
      return `**${s.displayName}**${s.dir !== '.' ? ` (in \`${s.dir}/\`)` : ''}${bits ? `: ${bits}` : ''}.`;
    })
    .join(' ');
}
