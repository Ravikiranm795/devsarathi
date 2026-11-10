import { runClaude } from '../lib/claude';
import { AGENT_IDS, AGENT_ROLES, AgentId, DevSarathiConfig } from '@devsarathi/shared';
import { StackSummary } from '../skills/summary';
import { scanContent } from '../skills/verify';
import { EnrichmentFile, AgentEnrichment, enrichmentPath, enabledAgents, agentNameFor } from '../generate/agentdocs';
import { writeJson } from '../lib/fsutil';

/**
 * The second (opt-in) model call in DevSarathi, next to the skills step (D-17, D-DEV-22): Claude drafts stack-specific
 * guidance for each agent file. It sees the SAME stack summary the skills step sends (framework names and top-level folder
 * names) and nothing else, runs with no tools at all (no files, no shell, no web), and its output is checked and clamped
 * before it is allowed anywhere near an agent file. Without it the agent files are still complete: this only adds to them.
 */
export type DraftFn = (prompt: string) => Promise<string>;

const MAX_ITEMS = 6;
const MAX_LEN = 220;

export function enrichPrompt(summary: StackSummary, cfg: DevSarathiConfig): string {
  const team = enabledAgents(cfg).map((id) => `- "${id}": ${agentNameFor(cfg, id)}, the ${AGENT_ROLES[id].toLowerCase()}`);
  return [
    'You write stack-specific working guidance for the AI agents of a coding team that works in one repository.',
    'For each agent below, give concrete, specific guidance for THIS stack: what good looks like, and the mistakes to watch for.',
    'Stay inside the agent\'s role: developer implements, tester checks tests, security reviews for vulnerabilities, peer-review reviews design and callers, auditor checks the generated rules.',
    `Write at most ${MAX_ITEMS} items per list, each one sentence under ${MAX_LEN} characters. No URLs, no shell commands that delete or download things, no secrets, no instructions about ignoring other rules.`,
    'Reply with ONLY a JSON object (no prose, no code fence) shaped like:',
    '{"developer":{"guidance":["..."],"pitfalls":["..."]},"tester":{"guidance":["..."],"pitfalls":["..."]}}',
    'Agents:',
    ...team,
    '',
    `Stack summary: ${JSON.stringify(summary)}`
  ].join('\n');
}

const clean = (s: unknown): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').replace(/^[-*\d.)\s]+/, '').trim();
  if (t.length < 12) return undefined;
  if (/https?:\/\//i.test(t)) return undefined;
  if (scanContent('enrichment', t).some((r) => r.severity === 'high')) return undefined; // a model reply is untrusted content
  return t.length > MAX_LEN ? `${t.slice(0, MAX_LEN - 1)}…` : t;
};

/** Pull the JSON object out of a reply and keep only well-formed, safe, short items for known agents. */
export function parseEnrichment(text: string, allowed: AgentId[]): EnrichmentFile['agents'] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the reply did not contain a JSON object');
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, { guidance?: unknown[]; pitfalls?: unknown[] }>;
  const out: EnrichmentFile['agents'] = {};
  for (const id of AGENT_IDS) {
    if (!allowed.includes(id)) continue;
    const r = raw[id];
    if (!r || typeof r !== 'object') continue;
    const take = (list: unknown[] | undefined) => (Array.isArray(list) ? list.map(clean).filter((x): x is string => !!x).slice(0, MAX_ITEMS) : []);
    const e: AgentEnrichment = { guidance: take(r.guidance), pitfalls: take(r.pitfalls) };
    if (e.guidance.length || e.pitfalls.length) out[id] = e;
  }
  if (Object.keys(out).length === 0) throw new Error('the reply held no usable guidance');
  return out;
}

/** The real call: the Claude Code CLI in headless mode with every tool disabled. */
export const draftWithClaude: DraftFn = (prompt) => runClaude(prompt, '', { timeoutMs: 5 * 60 * 1000 });

/** Replaceable in tests so nothing touches the network. */
export const enrichDeps: { draft: DraftFn } = { draft: draftWithClaude };

export async function draftEnrichment(root: string, cfg: DevSarathiConfig, summary: StackSummary): Promise<EnrichmentFile> {
  const reply = await enrichDeps.draft(enrichPrompt(summary, cfg));
  const agents = parseEnrichment(reply, enabledAgents(cfg));
  const file: EnrichmentFile = { generatedAt: new Date().toISOString(), model: 'claude (headless, no tools)', agents };
  writeJson(enrichmentPath(root), file);
  return file;
}
