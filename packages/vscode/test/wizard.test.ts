import { describe, it, expect } from 'vitest';
import { parseDetect, buildInitFlags, preflightProblems, validateTitle, agentsFlag, parseInitPreview, buildPreviewDoc, settingsNeedApproval, DetectData } from '../src/wizard';

const stack = (id: string, name = id) => ({ id, name, category: 'x', dir: '.', frameworks: [], testFramework: null, linter: null, buildTool: null });
const detect = (stacks: ReturnType<typeof stack>[], needsConfirmation: boolean, title = 'Angular Developer') => ({
  node: { version: '24.0.0', ok: true, required: 20 },
  git: { isRepo: true, currentBranch: 'main' },
  initialized: false,
  existing: null,
  stacks,
  notes: [],
  baseline: { suggested: 'main', options: ['main', 'develop'] },
  persona: { defaultName: 'Ravi', proposedTitle: title, needsConfirmation },
  optionalAgents: ['tester', 'security', 'peer-review', 'auditor']
});
const parse = (x: unknown): DetectData => {
  const d = parseDetect(x);
  if (!d) throw new Error('detect data did not parse');
  return d;
};
const answers = { baseline: 'main', persona: 'Ravi', title: '', agents: ['tester', 'security', 'peer-review', 'auditor'] };

describe('wizard flags', () => {
  it('1 stack: title may stay the proposed one; all agents -> --agents=all; --yes always', () => {
    const d = parse(detect([stack('angular', 'Angular')], false));
    expect(buildInitFlags(d, answers)).toEqual(['--yes', '--baseline=main', '--persona=Ravi', '--title=Angular Developer', '--agents=all']);
  });

  it('2 stacks: no confirmation needed, a typed title wins, specs are passed when given', () => {
    const d = parse(detect([stack('angular'), stack('java')], false, 'Full-Stack Developer'));
    const flags = buildInitFlags(d, { ...answers, title: ' Angular and Java Dev ', agents: ['tester', 'auditor'], specs: ' docs/specs/**/*.md ' });
    expect(flags).toEqual(['--yes', '--baseline=main', '--persona=Ravi', '--title=Angular and Java Dev', '--agents=tester,auditor', '--specs=docs/specs/**/*.md']);
  });

  it('more than 2 stacks: the title is REQUIRED', () => {
    const d = parse(detect([stack('angular'), stack('java'), stack('python')], true, 'Polyglot Developer'));
    expect(d.persona.needsConfirmation).toBe(true);
    expect(validateTitle('', true)).toMatch(/confirm or edit/);
    expect(validateTitle('   ', true)).toMatch(/confirm or edit/);
    expect(validateTitle('', false)).toBeUndefined();
    expect(() => buildInitFlags(d, { ...answers, title: '' })).toThrow(/confirm or edit the persona title/);
    expect(buildInitFlags(d, { ...answers, title: 'Polyglot Developer' })).toContain('--title=Polyglot Developer');
  });

  it('agents flag: all, none or a list in canonical order', () => {
    const all = ['tester', 'security', 'peer-review', 'auditor'];
    expect(agentsFlag(all, all)).toBe('all');
    expect(agentsFlag([], all)).toBe('none');
    expect(agentsFlag(['auditor', 'tester'], all)).toBe('tester,auditor');
  });

  it('refuses unsafe branch and persona values; a value that looks like an option stays inside --name=value', () => {
    const d = parse(detect([stack('angular')], false));
    expect(() => buildInitFlags(d, { ...answers, baseline: '--force' })).toThrow();
    expect(() => buildInitFlags(d, { ...answers, baseline: 'a;rm -rf' })).toThrow();
    expect(() => buildInitFlags(d, { ...answers, persona: '' })).toThrow();
    expect(buildInitFlags(d, { ...answers, persona: '-x' })).toContain('--persona=-x');
  });
});

describe('detect data', () => {
  it('parses the real shape, including an existing config', () => {
    const d = parse({ ...detect([stack('angular', 'Angular')], false), initialized: true, existing: { baselineBranch: 'develop', persona: { name: 'Asha', title: 'T' }, agents: { tester: false, security: true }, specsPath: null } });
    expect(d.existing).toMatchObject({ baselineBranch: 'develop', personaName: 'Asha', personaTitle: 'T', specsPath: undefined });
    expect(d.existing?.agents.tester).toBe(false);
  });
  it('rejects garbage', () => {
    expect(parseDetect(null)).toBeUndefined();
    expect(parseDetect({ stacks: [] })).toBeUndefined();
  });
  it('preflight problems: node, git, no stacks', () => {
    expect(preflightProblems(parse(detect([stack('a')], false)))).toEqual([]);
    const bad = parse({ ...detect([], false), node: { version: '16.0.0', ok: false, required: 20 }, git: { isRepo: false, currentBranch: '' }, notes: ['No package.json.'] });
    const p = preflightProblems(bad).join(' ');
    expect(p).toMatch(/Node 20/);
    expect(p).toMatch(/not a git repository/);
    expect(p).toMatch(/No package.json/);
  });
});

describe('preview', () => {
  const data = {
    files: [
      { path: '.claude/rules/ds-core.md', status: 'new', tokens: 120, loading: 'always' },
      { path: '.claude/agents/ds-tester.md', status: 'skipped-clash', tokens: 80, loading: 'on-demand' },
      { path: '.claude/rules/ds-x.md', status: 'dev-edited', tokens: 10, loading: 'on-demand' }
    ],
    alwaysLoadedTokens: 120,
    warnings: ['big'],
    settings: { exists: true, valid: true, alreadyMerged: false, text: 'Hook entries to merge: ...' }
  };
  it('builds a document with the budget table and every file group', () => {
    const p = parseInitPreview(data);
    expect(p).toBeDefined();
    const doc = buildPreviewDoc(p!);
    expect(doc).toContain('| `.claude/rules/ds-core.md` | NEW | 120 | always |');
    expect(doc).toContain('SKIPPED');
    expect(doc).toContain('KEPT');
    expect(doc).toContain('120 tokens');
    expect(doc).toContain('Hook entries to merge');
    expect(doc).toContain('- big');
  });
  it('asks about settings only when the file exists, is valid and is not merged yet', () => {
    const p = parseInitPreview(data)!;
    expect(settingsNeedApproval(p)).toBe('ask');
    expect(settingsNeedApproval({ ...p, settings: { ...p.settings, alreadyMerged: true } })).toBe('no');
    expect(settingsNeedApproval({ ...p, settings: { ...p.settings, exists: false } })).toBe('no');
    expect(settingsNeedApproval({ ...p, settings: { ...p.settings, valid: false } })).toBe('invalid');
  });
});
