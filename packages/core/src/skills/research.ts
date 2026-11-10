import { runClaude } from '../lib/claude';
import { StackSummary, researchPrompt } from './summary';

export interface Suggestion {
  name: string;
  description: string;
  source: string;
  reason: string;
  stackTerms: string[];
}

export type ResearchFn = (summary: StackSummary) => Promise<Suggestion[]>;

/** Pull the JSON array out of a model reply, tolerating a code fence or a sentence around it. */
export function parseSuggestions(text: string): Suggestion[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('the reply did not contain a JSON list of skills');
  const raw = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(raw)) throw new Error('the reply was not a JSON list');
  const out: Suggestion[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r.name !== 'string' || typeof r.source !== 'string') continue;
    out.push({
      name: r.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill',
      description: typeof r.description === 'string' ? r.description.slice(0, 300) : '',
      source: r.source.trim(),
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 300) : '',
      stackTerms: Array.isArray(r.stackTerms) ? r.stackTerms.filter((t): t is string => typeof t === 'string').slice(0, 10) : []
    });
  }
  return out.slice(0, 12);
}

/**
 * The skills research call (D-17): the Claude Code CLI in headless mode with ONLY web search and fetch tools, so the model has
 * no access to local files or a shell. It sends the stack summary and nothing else.
 */
export const researchWithClaude: ResearchFn = async (summary) => parseSuggestions(await runClaude(researchPrompt(summary), 'WebSearch,WebFetch'));
