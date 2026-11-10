import { DevSarathiConfig } from '@devsarathi/shared';
import { DetectedStack } from '../detect/detect';
import { requireConfig } from '../lib/config';
import { DrishtiClient } from '../graph/drishti';
import { deriveConventions } from '../rules/conventions';
import { Rule } from '../rules/engine';
import { buildPlan, Plan } from './plan';

export const STACK_NAMES: Record<string, string> = { angular: 'Angular', react: 'React', java: 'Java', python: 'Python', php: 'PHP', node: 'Node.js' };

const SOURCE_EXTS: Record<string, string[]> = {
  angular: ['.ts', '.html', '.scss'],
  react: ['.ts', '.tsx', '.js', '.jsx'],
  java: ['.java'],
  python: ['.py'],
  node: ['.js', '.mjs', '.cjs', '.ts'],
  php: ['.php']
};

export function stacksOf(cfg: DevSarathiConfig): DetectedStack[] {
  return cfg.stacks.map((s) => ({
    ...s,
    displayName: STACK_NAMES[s.id] ?? s.id,
    signals: []
  })) as DetectedStack[];
}

export interface GraphRules {
  rules: Rule[];
  /** Why graph-derived rules were skipped, when they were (D-10). */
  skippedReason?: string;
}

/** Graph-derived rules, or none with a reason when the graph is missing or below the coverage threshold. */
export function graphDerivedRules(root: string, cfg: DevSarathiConfig): GraphRules {
  const client = new DrishtiClient(root);
  const rec = client.lastBuild();
  if (!rec || !client.hasGraph()) return { rules: [], skippedReason: 'No graph yet: only the template rule layer was generated. Build one with: devsarathi graph build' };
  if (rec.belowThreshold) {
    return {
      rules: [],
      skippedReason: `Graph coverage is ${(rec.coverage.ratio * 100).toFixed(0)}%, below the ${(cfg.thresholds.coverage * 100).toFixed(0)}% threshold: only the template rule layer was generated. Rebuild with: devsarathi graph build --full`
    };
  }
  const exts = [...new Set(cfg.stacks.flatMap((s) => SOURCE_EXTS[s.id] ?? []))];
  const h = client.open();
  try {
    return { rules: deriveConventions(h.store, { commit: rec.commit, sourceExts: exts }) };
  } finally {
    h.close();
  }
}

export interface WorkspacePlan {
  plan: Plan;
  graphSkipped?: string;
}

export function planWorkspace(root: string, cfg: DevSarathiConfig = requireConfig(root), now?: Date): WorkspacePlan {
  const g = graphDerivedRules(root, cfg);
  const plan = buildPlan({ root, cfg, stacks: stacksOf(cfg), graphRules: g.rules, now });
  if (g.skippedReason) plan.warnings.unshift(g.skippedReason);
  return { plan, graphSkipped: g.skippedReason };
}
