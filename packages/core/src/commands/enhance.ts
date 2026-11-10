import { registerCommand, CommandDef } from '../registry';
import { requireConfig } from '../lib/config';
import { recordEvent } from '../lib/events';
import { DrishtiClient } from '../graph/drishti';
import { loadSpec, specIssues, recordActiveSpec, readActiveSpec, parseSpec, ParsedSpec, SpecIssue } from '../enhance/spec';
import { gatherContext, capFor, compose } from '../enhance/enhancer';
import * as fs from 'fs';
import * as path from 'path';
import { specCachePath } from '../enhance/spec';

const OUTCOMES = ['accepted', 'edited', 'rejected'];

const enhance: CommandDef = {
  name: 'enhance',
  description: 'Turn a short request plus the spec or Jira ticket into an accurate, ordered prompt (preview first)',
  args: [
    { name: 'request', type: 'string', description: 'What you want done', positional: true },
    { name: 'spec', type: 'string', description: 'Path to a markdown spec' },
    { name: 'jira', type: 'string', description: 'Jira ticket key (its text comes from the cache or --paste)' },
    { name: 'paste', type: 'string', description: 'Ticket or spec text pasted by the developer (cached read-only)' },
    { name: 'pasteFile', type: 'string', description: 'Read the pasted ticket text from this file (no length limit)' },
    { name: 'confirm', type: 'boolean', description: 'Proceed although the spec has open problems (you have settled them)' },
    { name: 'outcome', type: 'string', description: 'Record what happened to the last prompt: accepted, edited or rejected' }
  ],
  needsInit: true,
  async run(ctx, args) {
    const root = ctx.repoRoot;
    const cfg = requireConfig(root);

    if (args.outcome !== undefined) {
      const o = String(args.outcome);
      if (!OUTCOMES.includes(o)) return { ok: false, message: `outcome must be one of: ${OUTCOMES.join(', ')}`, exitCode: 2 };
      recordEvent(root, { type: 'enhance-outcome', data: { outcome: o } });
      return { ok: true, message: `Recorded: the enhanced prompt was ${o}.` };
    }
    if (!args.request) return { ok: false, message: 'Give the request to enhance, for example: devsarathi enhance "add retry to the webhook handler" --spec specs/webhook.md', exitCode: 2 };
    const request = String(args.request);

    // spec intake: a path, a Jira key (cached or pasted), or the spec already recorded for this work
    let spec: ParsedSpec | undefined;
    if (args.spec || args.jira) {
      let paste = args.paste as string | undefined;
      if (args.pasteFile) {
        try {
          paste = fs.readFileSync(path.resolve(String(args.pasteFile)), 'utf8');
        } catch (e) {
          return { ok: false, message: `Could not read --paste-file: ${e instanceof Error ? e.message : String(e)}`, exitCode: 2 };
        }
      }
      const loaded = loadSpec(root, { spec: args.spec as string | undefined, jira: args.jira as string | undefined, paste, specsPath: cfg.specsPath });
      if (!loaded.ok) return { ok: false, message: loaded.message, data: { status: 'needs-spec-input' }, exitCode: 3 }; // D-23: ask for a paste, never proceed on partial context
      spec = loaded.spec;
    } else {
      const active = readActiveSpec(root);
      if (active) {
        const file = active.path ? path.resolve(root, active.path) : specCachePath(root, active.ref);
        try {
          spec = parseSpec(active.ref, fs.readFileSync(file, 'utf8'));
        } catch {
          /* the recorded spec is gone: continue without it, and say so below */
        }
      }
    }

    ctx.progress('Gathering context', 'searching the graph');
    const client = new DrishtiClient(root);
    const context = await gatherContext(client, spec ? `${request} ${spec.title}` : request);

    // problems to settle BEFORE any work starts (D-22). The enhancer lists them and stops; it never fills the gaps.
    let issues: SpecIssue[] = [];
    if (spec) {
      let knows: (name: string) => boolean = () => true;
      if (client.hasGraph()) {
        const h = client.open();
        try {
          const symStmt = h.store.db.prepare('SELECT 1 FROM symbols WHERE name = ? LIMIT 1');
          const fileStmt = h.store.db.prepare('SELECT 1 FROM files WHERE path = ? OR path LIKE ? LIMIT 1');
          knows = (name: string) => (name.includes('/') || name.includes('\\') ? !!fileStmt.get(name.replace(/\\/g, '/'), `%/${name.replace(/\\/g, '/')}`) : !!symStmt.get(name));
          issues = specIssues(spec, knows);
        } finally {
          h.close();
        }
      } else issues = specIssues(spec, knows);
    }
    const questions = issues.map((i) => i.message);
    if (!spec) questions.unshift('No spec or ticket was given. The spec is the source of truth: pass --spec <path> or --jira <KEY>, or confirm you want to continue without one.');

    if (questions.length && !args.confirm) {
      recordEvent(root, { type: 'enhance', data: { status: 'needs-confirmation', questions: questions.length, specKnown: !!spec } });
      return {
        ok: true,
        message: `Not ready: ${questions.length} problem(s) to settle first. DevSarathi will not guess.\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nSettle them (or fix the spec with its owner), then run again with --confirm.`,
        data: { status: 'needs-confirmation', questions },
        exitCode: 0
      };
    }

    const cap = capFor(cfg, context, spec?.criteria ?? []);
    const composed = compose({ request, spec, ctx: context, questions, cap });
    if (spec) recordActiveSpec(root, spec); // the spec hash is recorded when work starts; review warns if it changes
    recordEvent(root, { type: 'enhance', data: { status: 'ready', chars: composed.chars, cap, trimmed: composed.trimmed, specKnown: !!spec, questions: questions.length } });

    const header = cfg.previewPrompt ? `Preview (nothing has been sent; ${composed.chars} of ${cap} characters):\n` : '';
    return {
      ok: true,
      message: `${header}${composed.prompt}`,
      data: { status: 'ready', prompt: composed.prompt, chars: composed.chars, cap, trimmed: composed.trimmed, preview: cfg.previewPrompt, specRef: spec?.ref }
    };
  }
};

registerCommand(enhance);
