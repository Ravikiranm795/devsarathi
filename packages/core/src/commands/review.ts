import { registerCommand, CommandDef } from '../registry';
import { requireConfig } from '../lib/config';
import { recordEvent } from '../lib/events';
import { writeJson } from '../lib/fsutil';
import * as path from 'path';
import { repoPaths } from '../lib/paths';
import { DrishtiClient, resolveBaselineRef } from '../graph/drishti';
import { computeOverlay } from '../graph/overlay';
import { collectChanges } from '../lib/diff';
import { runReview } from '../review/pipeline';
import { checkTestPresence, runTests } from '../review/tester';
import { checkSpecChanged } from '../enhance/spec';
import { notifyFailure } from '../lib/notify';

/**
 * One review command, three front doors (D-12): `/ds-review`, `devsarathi review` and the pre-push hook all run
 * exactly this. There is no lighter pass for the hook.
 */
const review: CommandDef = {
  name: 'review',
  description: 'Full review of the current changes: security, impact on callers, tests and spec. Same command the pre-push hook runs',
  args: [
    { name: 'range', type: 'string', description: 'Revision range A..B to review (default: everything that differs from the baseline)' },
    { name: 'only', type: 'string', description: 'Run one check only: security, impact, tester, peer-review, spec' },
    { name: 'agent', type: 'string', description: 'Alias of --only' },
    { name: 'trigger', type: 'string', description: 'Who started this run: manual, pre-push' }
  ],
  needsInit: true,
  async run(ctx, args) {
    requireConfig(ctx.repoRoot);
    const only = (args.only ?? args.agent) as string | undefined;
    const trigger = args.trigger === 'pre-push' ? 'pre-push' : 'manual';
    try {
      const out = await runReview(ctx.repoRoot, { range: args.range as string | undefined, only: only as never, trigger });
      return { ok: true, message: out.text, data: out.result, exitCode: 0 };
    } catch (err) {
      // I-4: a review that did not run is reported as such, never as clean.
      const msg = err instanceof Error ? err.message : String(err);
      notifyFailure(ctx.repoRoot, 'review', msg);
      return { ok: false, message: `Review did not run: ${msg}`, exitCode: 1 };
    }
  }
};

const test: CommandDef = {
  name: 'test',
  description: 'Run the tester: tests exist for changed logic, run the stack test command, map results to the acceptance criteria',
  args: [{ name: 'range', type: 'string', description: 'Revision range A..B (default: everything that differs from the baseline)' }],
  needsInit: true,
  async run(ctx, args) {
    const root = ctx.repoRoot;
    const cfg = requireConfig(root);
    if (!cfg.agents.tester) return { ok: true, message: 'The tester agent is turned off in this repo.' };
    const client = new DrishtiClient(root);
    const baseline = await resolveBaselineRef(root, cfg.baselineBranch);
    let missing: string[] = [];
    let testText = '';
    let presenceError: string | undefined;
    try {
      const changes = await collectChanges(root, { range: args.range as string | undefined, baseRef: baseline });
      const isTest: (p: string) => boolean = (await import('../graph/brain')).brain.config().isTestFile;
      testText = changes.files.filter((f) => isTest(f.path)).map((f) => f.added.map((a) => a.text).join('\n')).join('\n');
      if (client.hasGraph()) {
        const overlay = await computeOverlay(root, client, { range: args.range as string | undefined, persist: false });
        missing = (await checkTestPresence(client, overlay, changes, { root, range: args.range as string | undefined })).missing;
      } else presenceError = 'there is no graph, so missing tests could not be checked';
    } catch (err) {
      presenceError = err instanceof Error ? err.message : String(err);
    }

    ctx.progress('Testing', 'running the stack test command');
    const spec = checkSpecChanged(root).current;
    const res = await runTests(root, cfg, { criteria: spec?.criteria, changedTestText: testText });
    res.missingTests = missing;
    const status = presenceError && res.status === 'pass' ? 'incomplete' : res.status;

    const payload = { status, criteria: res.criteria, missingTests: missing, failures: res.failures, run: { status: res.run.status, error: res.run.error ?? presenceError }, commands: res.commands.map((c) => ({ command: c.command, exitCode: c.exitCode, ran: c.ran })) };
    writeJson(path.join(repoPaths(root).reviews, `test-${Date.now()}.json`), payload);
    recordEvent(root, { type: 'tester-run', data: { status, run: res.run.status, missing: missing.length, failures: res.failures.length } });
    if (res.run.status !== 'completed') notifyFailure(root, 'ds-tester', res.run.error ?? res.run.status);

    const lines = [`ds-tester: ${status.toUpperCase()}`];
    if (res.run.status !== 'completed') lines.push(`ds-tester did not run: ${res.run.error}`); // I-4
    if (presenceError) lines.push(`Missing-test check did not run: ${presenceError}`);
    for (const f of res.failures) lines.push(`  failed: ${f}`);
    for (const m of missing) lines.push(`  no test for: ${m}`);
    for (const c of res.criteria) lines.push(`  ${c.id}: ${c.result}`);
    return { ok: status === 'pass' && missing.length === 0, message: lines.join('\n'), data: payload, exitCode: status === 'pass' && missing.length === 0 ? 0 : 1 };
  }
};

registerCommand(review);
registerCommand(test);
