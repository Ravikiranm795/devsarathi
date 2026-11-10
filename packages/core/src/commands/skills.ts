import * as path from 'path';
import { registerCommand, CommandDef } from '../registry';
import { requireConfig, saveConfig } from '../lib/config';
import { repoPaths } from '../lib/paths';
import { readJson, writeJson } from '../lib/fsutil';
import { recordEvent } from '../lib/events';
import { buildStackSummary, payloadPreview, researchPrompt, StackSummary } from '../skills/summary';
import { researchWithClaude, ResearchFn } from '../skills/research';
import { verifySuggestion, orderResults, githubClient, GithubClient, Verified } from '../skills/verify';
import { installSkills, installPreview } from '../skills/install';

/** Replaceable for tests: the real step uses the Claude CLI for research and GitHub's public API for checks. */
export const skillsDeps: { research: ResearchFn; github: GithubClient } = { research: researchWithClaude, github: githubClient };

const cachePath = (root: string) => path.join(repoPaths(root).state, 'skills-cache.json');

interface Cache {
  at: string;
  results: Verified[];
}

function describe(v: Verified, i: number): string {
  const s = v.suggestion;
  const badge = v.verified ? 'VERIFIED' : 'WARNING: NOT VERIFIED';
  const lines = [
    `${i + 1}. ${s.name} [${badge}]${v.preTick ? ' (suggested)' : ''}`,
    `   ${s.description}`,
    `   Source: ${s.source}`,
    `   Rating: ${v.stars ?? '?'} stars, last update ${v.pushedAt ? v.pushedAt.slice(0, 10) : '?'}${v.license ? `, ${v.license}` : ''}. Stack match: ${(v.match * 100).toFixed(0)}%.`,
    `   Why: ${s.reason}`
  ];
  lines.push(v.verified ? `   Checked: ${v.reasons[0]}` : `   Why it is not verified: ${v.reasons.join('; ')}`);
  const medium = v.risks.filter((r) => r.severity === 'medium');
  if (medium.length) lines.push(`   Note: ${medium.map((r) => `${r.file} ${r.what}`).join('; ')}`);
  return lines.join('\n');
}

const skills: CommandDef = {
  name: 'skills',
  description: 'Optional: research, verify and install community Claude skills for this stack (sends a stack summary only, after you preview it)',
  args: [
    { name: 'preview', type: 'boolean', description: 'Only show the exact payload that would be sent' },
    { name: 'yes', type: 'boolean', description: 'Agree to send the previewed summary (non-interactive)' },
    { name: 'install', type: 'string', description: 'Install these skills from the last research (comma-separated names)' }
  ],
  needsInit: true,
  async run(ctx, args) {
    const root = ctx.repoRoot;
    const cfg = requireConfig(root);
    const summary: StackSummary = buildStackSummary(root, cfg);
    const preview = payloadPreview(summary, researchPrompt(summary));

    // --install: only from a previous research the developer has already seen
    if (args.install) {
      const cache = readJson<Cache>(cachePath(root));
      if (!cache) return { ok: false, message: 'There is no research to install from. Run: devsarathi skills', exitCode: 1 };
      const want = String(args.install).split(',').map((s) => s.trim()).filter(Boolean);
      const picks = cache.results.filter((v) => want.includes(v.suggestion.name));
      const missing = want.filter((w) => !picks.some((p) => p.suggestion.name === w));
      if (missing.length) return { ok: false, message: `Not in the last research: ${missing.join(', ')}`, exitCode: 1 };
      return doInstall(ctx.repoRoot, picks, !!args.yes, ctx);
    }

    if (args.preview) return { ok: true, message: preview, data: { payload: summary } };

    // 1. the developer sees the exact payload and opts in (D-17)
    process.stderr.write(`\n${preview}\n\n`);
    let agreed = !!args.yes;
    if (!agreed) {
      if (!ctx.ask) return { ok: false, message: `${preview}\n\nRun again with --yes to send this summary, or devsarathi skills --preview to only look.`, exitCode: 2 };
      agreed = await ctx.ask.confirm('Send this stack summary to Claude to research skills?', false);
    }
    if (!agreed) return { ok: true, message: 'Nothing was sent.' };

    // 2. research, then 3. verify locally
    ctx.progress('Skills', 'researching the market (this can take a few minutes)');
    let suggestions;
    try {
      suggestions = await skillsDeps.research(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `Skills research did not run: ${msg}`, exitCode: 1 };
    }
    recordEvent(root, { type: 'skills-research', data: { suggestions: suggestions.length } });
    ctx.progress('Skills', `verifying ${suggestions.length} suggestion(s) locally`);
    const results = orderResults(await Promise.all(suggestions.map((s) => verifySuggestion(s, summary, skillsDeps.github))));
    writeJson(cachePath(root), { at: new Date().toISOString(), results } satisfies Cache);

    const list = results.map(describe).join('\n\n') || 'No skills were suggested.';
    if (results.length === 0) return { ok: true, message: list, data: { results } };

    // 4. selection: unverified are never pre-ticked and need a deliberate choice
    if (!ctx.ask) return { ok: true, message: `${list}\n\nInstall with: devsarathi skills --install <name,name> --yes`, data: { results } };
    process.stderr.write(`\n${list}\n\n`);
    const chosen = await ctx.ask.multi(
      'Which skills should be installed? (unverified ones are never pre-ticked)',
      results.map((v) => ({ value: v.suggestion.name, label: `${v.suggestion.name} ${v.verified ? '[verified]' : '[NOT VERIFIED]'}`, checked: v.verified && v.preTick }))
    );
    if (chosen.length === 0) return { ok: true, message: 'Nothing was installed.', data: { results } };
    return doInstall(ctx.repoRoot, results.filter((v) => chosen.includes(v.suggestion.name)), false, ctx);
  }
};

async function doInstall(root: string, picks: Verified[], yes: boolean, ctx: Parameters<CommandDef['run']>[0]) {
  const cfg = requireConfig(root);
  const preview = installPreview(picks);
  process.stderr.write(`\nAbout to install:\n${preview}\n\n`);
  const unverified = picks.filter((p) => !p.verified);
  let ok = yes;
  if (!ok) {
    if (!ctx.ask) return { ok: false, message: `About to install:\n${preview}\nRun again with --yes to confirm.`, exitCode: 2 };
    ok = await ctx.ask.confirm(unverified.length ? `${unverified.length} of these are NOT verified. Install exactly these sources anyway?` : 'Install exactly these sources at these pinned versions?', false);
  }
  if (!ok) return { ok: true, message: 'Nothing was installed.' };
  const out = await installSkills(root, cfg, picks, skillsDeps.github);
  saveConfig(root, cfg);
  recordEvent(root, { type: 'skills-install', data: { installed: out.installed.length, skipped: out.skipped.length } });
  const lines = [
    out.installed.length ? `Installed ${out.installed.map((i) => `${i.name}@${i.commit.slice(0, 7)}`).join(', ')} into .claude/skills/.` : 'Nothing was installed.',
    ...out.skipped.map((s) => `Skipped ${s.name}: ${s.reason}`)
  ];
  return { ok: out.skipped.length === 0, message: lines.join('\n'), data: out };
}

registerCommand(skills);
