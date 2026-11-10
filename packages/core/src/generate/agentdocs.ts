import * as path from 'path';
import { AGENT_IDS, AGENT_ROLES, AgentId, DEFAULT_AGENT_NAMES, DevSarathiConfig, OPTIONAL_AGENTS } from '@devsarathi/shared';
import { DetectedStack } from '../detect/detect';
import { StackProfileFiles, substitute } from './templates';
import { readJson } from '../lib/fsutil';
import { repoPaths } from '../lib/paths';

/** The name an agent goes by: the persona for the developer, otherwise what the developer chose, otherwise a default. */
export function agentNameFor(cfg: DevSarathiConfig, id: AgentId): string {
  if (id === 'developer') return cfg.persona.name;
  const chosen = cfg.agentNames[id]?.trim();
  return chosen || DEFAULT_AGENT_NAMES[id as (typeof OPTIONAL_AGENTS)[number]];
}

export function enabledAgents(cfg: DevSarathiConfig): AgentId[] {
  return AGENT_IDS.filter((id) => id === 'developer' || cfg.agents[id as keyof DevSarathiConfig['agents']] !== false);
}

const DUTY: Record<AgentId, string> = {
  developer: 'Implements the spec with impact lookups before every edit',
  tester: 'Proves the work: tests exist, run and map to the acceptance criteria. Read-only',
  security: 'Reviews the diff for secrets, injection and unsafe configuration. Read-only',
  'peer-review': 'Second opinion against the spec, rules and impact list. Read-only',
  auditor: 'Audits these generated rules, agents and commands. Never edits'
};

/** Who is on the team, by name, so each agent knows its colleagues and when to hand work over. */
export function teamTable(cfg: DevSarathiConfig): string {
  const rows = enabledAgents(cfg).map((id) => `| ${agentNameFor(cfg, id)} | \`ds-${id}\` | ${AGENT_ROLES[id]}: ${DUTY[id]} |`);
  return ['| Name | Agent | Role |', '|------|-------|------|', ...rows].join('\n');
}

/** Stack-specific checklist for one agent, from each detected stack's profile (agents.json). */
export function stackChecklist(stacks: DetectedStack[], profiles: Map<string, StackProfileFiles>, id: AgentId, vars: Record<string, string>): string {
  const blocks: string[] = [];
  for (const s of stacks) {
    const items = profiles.get(s.id)?.agents?.[id] ?? [];
    if (items.length === 0) continue;
    const body = items.map((t) => `- ${substitute(t, vars)}`).join('\n');
    blocks.push(stacks.length > 1 ? `**${s.displayName}**\n${body}` : body);
  }
  return blocks.length ? blocks.join('\n\n') : '- Follow the conventions of the files you touch and the rules in `.claude/rules/`.';
}

export interface AgentEnrichment {
  guidance: string[];
  pitfalls: string[];
}

export type EnrichmentFile = { generatedAt: string; model: string; agents: Partial<Record<AgentId, AgentEnrichment>> };

export const enrichmentPath = (root: string) => path.join(repoPaths(root).state, 'enrichment.json');

export function loadEnrichment(root: string, cfg: DevSarathiConfig): EnrichmentFile | undefined {
  if (!cfg.enrich.enabled) return undefined;
  return readJson<EnrichmentFile>(enrichmentPath(root));
}

/** The Claude-drafted section. Marked as drafted so the developer knows to review it; empty when there is none. */
export function enrichmentSection(file: EnrichmentFile | undefined, id: AgentId): string {
  const e = file?.agents?.[id];
  if (!e || (e.guidance.length === 0 && e.pitfalls.length === 0)) return '';
  const lines = ['## Stack guidance drafted by Claude (review it; your edits win)', '<!-- source:llm -->'];
  if (e.guidance.length) lines.push('', 'Do:', ...e.guidance.map((g, i) => `${i + 1}. ${g}`));
  if (e.pitfalls.length) lines.push('', 'Watch out for:', ...e.pitfalls.map((g, i) => `${i + 1}. ${g}`));
  return lines.join('\n');
}
