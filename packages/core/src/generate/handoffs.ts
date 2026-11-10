import { DevSarathiConfig } from '@devsarathi/shared';
import { agentNameFor } from './agentdocs';

/**
 * Hand-off wording that only names agents that exist, so no generated file points at a teammate who was turned off
 * (the auditor flags such references).
 */
export function testHandoff(cfg: DevSarathiConfig): string {
  if (cfg.agents.tester === false) return 'run the tests yourself and report the real result';
  return `hand off to ${agentNameFor(cfg, 'tester')} (\`ds-tester\`, \`/ds-test\`)`;
}

export function testHandoffSentence(cfg: DevSarathiConfig): string {
  const t = testHandoff(cfg);
  return `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;
}

export function handoffTable(cfg: DevSarathiConfig): string {
  const rows = [
    cfg.agents.tester === false
      ? '| The task is complete | Run the tests yourself and report the real result |'
      : `| The task is complete | Hand off to ${agentNameFor(cfg, 'tester')} (\`ds-tester\`, \`/ds-test\`) |`,
    '| Before every push | Run `/ds-review` and answer each numbered finding |'
  ];
  if (cfg.agents.security !== false) rows.push(`| You need a security view of the diff | Ask ${agentNameFor(cfg, 'security')} (\`ds-security\`) |`);
  if (cfg.agents['peer-review'] !== false) rows.push(`| You want a second opinion on the change | Ask ${agentNameFor(cfg, 'peer-review')} (\`ds-peer-review\`) |`);
  if (cfg.agents.auditor !== false) rows.push(`| The generated rules look wrong or contradictory | Ask ${agentNameFor(cfg, 'auditor')} (\`ds-auditor\`); \`/ds-status\` shows pending changes |`);
  return ['| When | Do this |', '|------|---------|', ...rows].join('\n');
}
