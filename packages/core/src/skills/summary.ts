import * as path from 'path';
import { DevSarathiConfig } from '@devsarathi/shared';
import { repoPaths } from '../lib/paths';
import { readJson } from '../lib/fsutil';

/**
 * The ONLY thing the skills step ever sends to a model (D-17, MASTER 19.2): a stack summary. It is built from the
 * config and the graph's folder summary: names and counts. No source code, no secrets, no env contents, no file
 * paths below the top-level folders, no repo name. The developer sees this exact payload before anything is sent.
 */
export interface StackSummary {
  stacks: { name: string; frameworks: string[]; testFramework?: string; linter?: string; buildTool?: string; packageManager?: string; stateManagement?: string }[];
  personaTitle: string;
  folders: string[];
  languages: Record<string, number>;
}

const NAMES: Record<string, string> = { angular: 'Angular', react: 'React', java: 'Java', python: 'Python', php: 'PHP' };

export function buildStackSummary(root: string, cfg: DevSarathiConfig): StackSummary {
  const sum = readJson<{ modules?: { name: string }[]; languages?: Record<string, number> }>(path.join(repoPaths(root).graph, 'summary.json'));
  // Top-level folder names only, never a path or a file name.
  const folders = [...new Set((sum?.modules ?? []).map((m) => m.name.split('/')[0]).filter((n) => n && n !== '(root)'))].slice(0, 20);
  return {
    stacks: cfg.stacks.map((s) => ({
      name: NAMES[s.id] ?? s.id,
      frameworks: s.frameworks,
      testFramework: s.testFramework,
      linter: s.linter,
      buildTool: s.buildTool,
      packageManager: s.packageManager,
      stateManagement: s.stateManagement
    })),
    personaTitle: cfg.persona.title,
    folders,
    languages: sum?.languages ?? {}
  };
}

export function payloadPreview(_summary: StackSummary, prompt: string): string {
  return [
    'This is EXACTLY what would be sent to Claude (web search enabled, no access to local files or a shell):',
    '',
    prompt,
    '',
    'Nothing else leaves your machine: no source code, no secrets, no env values, no file names, no repo name.'
  ].join('\n');
}

export function researchPrompt(summary: StackSummary): string {
  return [
    'You help a developer choose Claude Code skills (folders with a SKILL.md) for their project stack.',
    'Search the web for popular, well-rated, actively maintained community skills that match this stack.',
    'Official Anthropic skills alone are not enough: framework skills (for example Angular, Spring, Django) come from the community.',
    'Only suggest skills that live in a PUBLIC GitHub repository. Give the exact GitHub URL of the skill folder or repo.',
    'Reply with ONLY a JSON array (no prose, no code fence) of up to 12 items:',
    '[{"name":"kebab-case-name","description":"one sentence","source":"https://github.com/owner/repo/tree/main/path/to/skill","reason":"why it fits this stack","stackTerms":["angular","rxjs"]}]',
    '',
    `Stack summary: ${JSON.stringify(summary)}`
  ].join('\n');
}
