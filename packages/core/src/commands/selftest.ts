import { registerCommand, CommandDef } from '../registry';
import { runSelfTest } from '../selftest/run';
import { recordEvent } from '../lib/events';

const selftest: CommandDef = {
  name: 'selftest',
  description: 'Run the planted-problem self-test: confirms the agents and hooks actually catch what they should',
  args: [{ name: 'keep', type: 'boolean', description: 'Keep the throw-away repo for inspection' }],
  async run(ctx, args) {
    const res = await runSelfTest({ keep: !!args.keep, onProgress: (m) => ctx.progress('Self-test', m) });
    const failed = res.checks.filter((c) => !c.passed);
    recordEvent(ctx.repoRoot, { type: 'selftest', data: { passed: res.passed, total: res.total, failed: failed.map((f) => f.name).join(',') } });
    const lines = res.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'}  ${c.name}${c.passed ? '' : `\n      ${c.detail}`}`);
    lines.push('', failed.length ? `Self-test FAILED: ${failed.length} of ${res.total} checks did not pass.` : `Self-test passed: ${res.passed} of ${res.total} checks.`);
    if (res.dir) lines.push(`Kept at ${res.dir}`);
    return { ok: failed.length === 0, message: lines.join('\n'), data: res, exitCode: failed.length ? 1 : 0 };
  }
};

registerCommand(selftest);
