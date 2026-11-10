import * as path from 'path';
import { registerCommand, CommandDef } from '../registry';
import { requireConfig } from '../lib/config';
import { repoPaths } from '../lib/paths';
import { writeJson } from '../lib/fsutil';
import { DrishtiClient } from '../graph/drishti';
import { auditWorkspace, formatAudit, AuditReport } from '../audit/auditor';
import { planWorkspace } from '../generate/service';
import { diffGraphRules, readPending, writePending, applyChange, logChange, readRejected, addRejected, RuleChange } from '../rules/changes';
import { buildGraphLocked, describeOutcome } from './graph';

export function runAudit(root: string): AuditReport {
  const cfg = requireConfig(root);
  const client = new DrishtiClient(root);
  let report: AuditReport;
  if (client.hasGraph()) {
    const h = client.open();
    try {
      report = auditWorkspace(root, cfg, h.store);
    } finally {
      h.close();
    }
  } else {
    report = auditWorkspace(root, cfg);
  }
  writeJson(path.join(repoPaths(root).reviews, `audit-${Date.now()}.json`), { ...report, createdAt: new Date().toISOString() });
  return report;
}

const audit: CommandDef = {
  name: 'audit',
  description: 'Audit the generated workspace: contradictions, duplicates, vague rules, missing evidence, size, broken references',
  args: [],
  needsInit: true,
  async run(ctx) {
    const report = runAudit(ctx.repoRoot);
    return { ok: report.status === 'pass', message: formatAudit(report), data: report, exitCode: report.status === 'pass' ? 0 : 1 };
  }
};

export interface RefreshResult {
  autoApplied: RuleChange[];
  pending: RuleChange[];
  message: string;
}

/** Rule proposals from the current graph: low risk applies and is logged, high risk waits for approval. */
export function proposeAndApply(root: string): RefreshResult {
  const cfg = requireConfig(root);
  const { plan } = planWorkspace(root, cfg);
  const rejected = new Set(readRejected(root));
  const changes = diffGraphRules(root, cfg, plan).filter((c) => !rejected.has(c.id));
  const known = new Set(readPending(root).map((c) => c.id));
  const auto: RuleChange[] = [];
  const pending = readPending(root);
  for (const c of changes) {
    if (c.risk === 'low') {
      if (applyChange(root, cfg, c)) {
        logChange(root, c, 'auto-applied');
        auto.push(c);
      } else if (!known.has(c.id)) {
        pending.push({ ...c, risk: 'high', reason: `${c.reason} (could not be applied automatically)` });
      }
    } else if (!known.has(c.id)) {
      pending.push(c);
    }
  }
  writePending(root, pending);
  const parts = [`${auto.length} low-risk rule change(s) applied and logged.`];
  if (pending.length) parts.push(`${pending.length} change(s) wait for your approval: devsarathi rules pending`);
  if (plan.warnings.length) parts.push(...plan.warnings.map((w) => `Note: ${w}`));
  return { autoApplied: auto, pending, message: parts.join('\n') };
}

const refresh: CommandDef = {
  name: 'refresh',
  description: 'Incrementally refresh the graph, then propose rule updates (low risk auto-applies, high risk waits for approval)',
  args: [],
  needsInit: true,
  async run(ctx) {
    ctx.progress('Building graph', 'incremental refresh');
    const res = await buildGraphLocked(ctx.repoRoot, { progress: ctx.progress });
    if (!res.ran) return { ok: true, message: 'A graph build is already running; one follow-up is queued.' };
    ctx.progress('Generating rules', 'comparing with the new graph');
    const r = proposeAndApply(ctx.repoRoot);
    return { ok: true, message: `${describeOutcome(res.outcome!)}\n${r.message}`, data: { build: res.outcome!.record, ...r } };
  }
};

function describeChange(c: RuleChange): string {
  const what = c.op === 'add' ? `add to ${c.file}` : c.op === 'change' ? `change in ${c.file}` : `remove from ${c.file}`;
  const text = (c.newLine ?? c.oldLine ?? '').replace(/<!--.*?-->/g, '').trim();
  return `[${c.id}] ${what} (${c.risk} risk)\n    ${text}\n    Why: ${c.reason}`;
}

const rulesPending: CommandDef = {
  name: 'rules pending',
  description: 'List rule changes waiting for your approval',
  args: [],
  needsInit: true,
  async run(ctx) {
    const list = readPending(ctx.repoRoot);
    return { ok: true, message: list.length ? list.map(describeChange).join('\n') : 'No rule changes are waiting.', data: list };
  }
};

function decide(kind: 'approve' | 'reject'): CommandDef {
  return {
    name: `rules ${kind}`,
    description: kind === 'approve' ? 'Approve a pending rule change (or "all")' : 'Reject a pending rule change (or "all")',
    args: [{ name: 'id', type: 'string', description: 'Change id from `rules pending`, or "all"', positional: true, required: true }],
    needsInit: true,
    async run(ctx, args) {
      const cfg = requireConfig(ctx.repoRoot);
      const pending = readPending(ctx.repoRoot);
      const targets = args.id === 'all' ? pending : pending.filter((c) => c.id === args.id);
      if (targets.length === 0) return { ok: false, message: `No pending change "${args.id}".`, exitCode: 1 };
      const left = pending.filter((c) => !targets.includes(c));
      const done: string[] = [];
      const failed: string[] = [];
      for (const c of targets) {
        if (kind === 'approve') {
          if (applyChange(ctx.repoRoot, cfg, c)) {
            logChange(ctx.repoRoot, c, 'approved');
            done.push(c.id);
          } else {
            failed.push(c.id);
            left.push(c);
          }
        } else {
          logChange(ctx.repoRoot, c, 'rejected');
          addRejected(ctx.repoRoot, [c.id]);
          done.push(c.id);
        }
      }
      writePending(ctx.repoRoot, left);
      const msg = `${kind === 'approve' ? 'Approved' : 'Rejected'} ${done.length} change(s).${failed.length ? ` Could not apply ${failed.join(', ')}: the file changed since the proposal; run devsarathi refresh.` : ''}`;
      return { ok: failed.length === 0, message: msg, exitCode: failed.length ? 1 : 0 };
    }
  };
}

registerCommand(audit);
registerCommand(refresh);
registerCommand(rulesPending);
registerCommand(decide('approve'));
registerCommand(decide('reject'));
