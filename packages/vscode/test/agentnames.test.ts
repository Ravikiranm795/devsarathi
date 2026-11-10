import { describe, it, expect } from 'vitest';
import { buildInitFlags, parseDetect, DetectData, DEFAULT_AGENT_NAMES, AGENT_LABELS } from '../src/wizard';

const detect = (existing: unknown = null) => ({
  node: { version: '24.0.0', ok: true, required: 20 },
  git: { isRepo: true, currentBranch: 'main' },
  initialized: !!existing,
  existing,
  stacks: [{ id: 'angular', name: 'Angular', category: 'frontend', dir: '.', frameworks: [] }],
  notes: [],
  baseline: { suggested: 'main', options: ['main'] },
  persona: { defaultName: 'Ravi', proposedTitle: 'Angular Developer', needsConfirmation: false },
  optionalAgents: ['tester', 'security', 'peer-review', 'auditor']
});
const parse = (x: unknown): DetectData => parseDetect(x) as DetectData;
const base = { baseline: 'main', persona: 'Ravi', title: '', agents: ['tester', 'security', 'peer-review', 'auditor'] };

describe('wizard: a name for each agent, plus the opt-in questions', () => {
  it('passes one --agent-names flag with every kept agent, and --enrich / --claude-md only when chosen', () => {
    const d = parse(detect());
    const flags = buildInitFlags(d, { ...base, agentNames: { tester: 'Tara', security: 'Raksha', 'peer-review': 'Mitra', auditor: 'Lekha' }, enrich: true, claudeMd: true });
    expect(flags).toContain('--agent-names=tester=Tara,security=Raksha,peer-review=Mitra,auditor=Lekha');
    expect(flags).toContain('--enrich');
    expect(flags).toContain('--claude-md');
    const plain = buildInitFlags(d, base);
    expect(plain.some((f) => f.startsWith('--agent-names'))).toBe(false);
    expect(plain).not.toContain('--enrich');
    expect(plain).not.toContain('--claude-md');
  });

  it('only names agents that were kept', () => {
    const flags = buildInitFlags(parse(detect()), { ...base, agents: ['tester'], agentNames: { tester: 'Tara', security: 'Raksha' } });
    expect(flags).toContain('--agent-names=tester=Tara');
    expect(flags.join(' ')).not.toContain('Raksha');
  });

  it('rejects names that would break the flag, and empty names', () => {
    const d = parse(detect());
    expect(() => buildInitFlags(d, { ...base, agentNames: { tester: 'Tara,Evil=1' } })).toThrow(/commas or equals/);
    expect(() => buildInitFlags(d, { ...base, agentNames: { tester: '   ' } })).toThrow(/name is required/);
    expect(() => buildInitFlags(d, { ...base, agentNames: { tester: 'x\ny' } })).toThrow(/single-line/);
  });

  it('a name cannot be read as another option (flags are --name=value)', () => {
    const flags = buildInitFlags(parse(detect()), { ...base, agentNames: { tester: '--yes' } });
    expect(flags).toContain('--agent-names=tester=--yes');
  });

  it('reads the names already chosen from detect, and has defaults and labels for every optional agent', () => {
    const d = parse(detect({ baselineBranch: 'main', persona: { name: 'Ravi', title: 'Angular Developer' }, agents: { tester: true }, agentNames: { tester: 'Pariksha', bogus: 7 }, specsPath: null }));
    expect(d.existing?.agentNames).toEqual({ tester: 'Pariksha' });
    for (const a of ['tester', 'security', 'peer-review', 'auditor']) {
      expect(DEFAULT_AGENT_NAMES[a]).toBeTruthy();
      expect(AGENT_LABELS[a]).toBeTruthy();
    }
  });
});
