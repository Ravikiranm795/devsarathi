import * as path from 'path';
import { spawn } from 'child_process';
import { registerCommand, CommandDef, getCommand, CommandContext } from '../registry';
import { loadConfig } from '../lib/config';
import { failOpen, writeNotice } from '../lib/failopen';
import { currentBranch, git, headCommit } from '../lib/git';
import { repoPaths } from '../lib/paths';
import { readJson, writeJson, sha256 } from '../lib/fsutil';
import { recordEvent } from '../lib/events';
import { parsePushRefs, pushRange } from '../lib/range';
import { collectStatus, statusLine } from './status';
import { resolveBaselineRef } from '../graph/drishti';
import { gitHooksHealthy } from '../hooks/gitHooks';
import { versionCheckDue } from '../lib/version';

/**
 * Entry points for git and Claude Code hooks. Every one is wrapped in failOpen: a crash becomes a visible
 * notice and exit 0, never a blocked git operation (I-2, I-3), and each one does nothing when the kill
 * switch is on (D-31).
 */

/** Task-end code detection ignores the whole .claude folder: DevSarathi and the editor write config there, not code. */
const OWN_PATHSPEC = [':(exclude).claude'];

const CLI = path.resolve(__dirname, '..', '..', '..', '..', 'bin', 'devsarathi.js');

/** Start a DevSarathi command in the background. Git never waits for it (D-14). */
export function runDetached(root: string, args: string[]): void {
  const child = spawn(process.execPath, [CLI, ...args, '-C', root], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

async function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.resume();
  });
}

/** post-merge / post-rewrite: refresh the graph only when a pull lands on the baseline branch (I-6). */
async function onPull(root: string, hook: string): Promise<string> {
  const cfg = loadConfig(root);
  if (!cfg) return '';
  const branch = await currentBranch(root);
  if (branch !== cfg.baselineBranch) return ''; // feature-branch pulls trigger nothing
  recordEvent(root, { type: 'refresh-triggered', data: { hook } });
  runDetached(root, ['refresh']);
  return `DevSarathi: refreshing the graph for ${cfg.baselineBranch} in the background.`;
}

/** pre-push: run the same review as /ds-review on the commits being pushed. Always exit 0 (I-2). */
async function onPrePush(root: string): Promise<string> {
  const cfg = loadConfig(root);
  if (!cfg) return '';
  const stdin = await readStdin();
  const refs = parsePushRefs(stdin);
  const baselineRef = await resolveBaselineRef(root, cfg.baselineBranch);
  const out: string[] = [];
  const review = getCommand('review');
  for (const ref of refs) {
    const range = await pushRange(root, ref, baselineRef);
    if (!range) continue; // deleting a branch: nothing to review
    if (!review) {
      out.push('Review did not run: the review command is not available in this DevSarathi version.');
      continue;
    }
    try {
      const res = await review.run(
        { repoRoot: root, log: { debug() {}, info() {}, warn() {}, error() {} }, progress: () => undefined },
        { range, trigger: 'pre-push' }
      );
      out.push(res.message);
    } catch (err) {
      // I-4: a failed review must never look like a clean one
      const msg = err instanceof Error ? err.message : String(err);
      writeNotice(root, 'pre-push', `Review did not run: ${msg}`);
      out.push(`Review did not run: ${msg}`);
    }
  }
  return out.join('\n\n');
}

function changeSignature(root: string): Promise<string> {
  return Promise.all([git(['status', '--porcelain=v1', '-z', '--', '.', ...OWN_PATHSPEC], root), headCommit(root)]).then(([s, h]) => sha256(`${h}\n${s.stdout}`));
}

/** Claude Code Stop: when code changed during the task, start the tester in the background. */
async function onStop(root: string): Promise<string> {
  recordEvent(root, { type: 'task-end' });
  const sig = await changeSignature(root);
  const file = path.join(repoPaths(root).state, 'last-stop.json');
  const last = readJson<{ sig: string }>(file);
  const dirty = (await git(['status', '--porcelain', '--', '.', ...OWN_PATHSPEC], root)).stdout.trim() !== '';
  writeJson(file, { sig, at: new Date().toISOString() });
  if (!dirty || last?.sig === sig) return '';
  if (!getCommand('test')) return '';
  runDetached(root, ['test']);
  return 'DevSarathi: code changed during this task, so ds-tester is running in the background. Results appear in the notifications.';
}

async function onPrompt(root: string): Promise<string> {
  // Counts only: the prompt text is never read or stored (I-8).
  recordEvent(root, { type: 'prompt' });
  return '';
}

async function onSessionStart(root: string): Promise<string> {
  const cfg = loadConfig(root);
  if (!cfg) return '';
  const status = await collectStatus(root);
  let line = statusLine(status);
  if (!cfg.disabled) {
    const health = await gitHooksHealthy(root, cfg);
    if (health.missing.length) line += ` | git hooks missing (${health.missing.join(', ')}): run devsarathi init`;
  }
  recordEvent(root, { type: 'session-start' });
  // The version notice is refreshed in the background (npm metadata only) at most once a day; it is off with versionCheck:false.
  if (cfg.versionCheck && versionCheckDue()) runDetached(root, ['version-check']);
  // `systemMessage` is shown to the developer; `additionalContext` tells Claude the same facts (no instructions).
  const facts = `${line}. Workspace: persona ${cfg.persona.name} (${cfg.persona.title}); rules in .claude/rules/ds-*.md, starting with ds-index.md (the map of rules, agents and commands); subagents ds-*; slash commands /ds-*.`;
  return JSON.stringify({ systemMessage: line, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: facts } });
}

const HANDLERS: Record<string, (root: string, name: string) => Promise<string>> = {
  'post-merge': (r, n) => onPull(r, n),
  'post-rewrite': (r, n) => onPull(r, n),
  'pre-push': (r) => onPrePush(r),
  stop: (r) => onStop(r),
  prompt: (r) => onPrompt(r),
  'session-start': (r) => onSessionStart(r)
};

export async function runHook(ctx: CommandContext, name: string): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) return '';
  let output = '';
  await failOpen(ctx.repoRoot, name, async () => {
    output = await handler(ctx.repoRoot, name);
  });
  return output;
}

const hook: CommandDef = {
  name: 'hook',
  description: 'Internal: entry point for git and Claude Code hooks (always exits 0)',
  args: [{ name: 'name', type: 'string', description: 'post-merge | post-rewrite | pre-push | session-start | prompt | stop', positional: true, required: true }],
  async run(ctx, args) {
    const out = await runHook(ctx, String(args.name));
    // Hooks never fail: ok stays true and the CLI exit code is 0 whatever happened.
    return { ok: true, message: out, exitCode: 0 };
  }
};

registerCommand(hook);

