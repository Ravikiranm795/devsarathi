import * as vscode from 'vscode';
import * as path from 'path';
import { CliOutcome, RunSpec } from './cli';
import { Controller } from './controller';
import { summarize } from './result';
import { describeOp } from './format';
import { DashboardPanel } from './dashboard';
import { PanelMessage } from './panel';
import { AGENT_LABELS, DEFAULT_AGENT_NAMES, WizardAnswers, buildInitFlags, buildPreviewDoc, describeStack, parseDetect, parseInitPreview, preflightProblems, settingsNeedApproval, validateBranch, validatePersona, validateTitle } from './wizard';

/*
 * The interactive parts (init wizard, enhance, approvals) and the command registrations. All questions are asked here;
 * every decision about what to do with the answers is made by the CLI.
 */

/** Read-only virtual documents (the init preview), so the developer cannot edit what is only a preview. */
export class PreviewProvider implements vscode.TextDocumentContentProvider {
  static scheme = 'devsarathi-preview';
  private docs = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.emitter.event;

  set(name: string, text: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${PreviewProvider.scheme}:/${name}`);
    this.docs.set(uri.path, text);
    this.emitter.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.path) ?? '';
  }
}

interface Rec {
  [k: string]: unknown;
}
const asRec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const resultOf = (o: CliOutcome | undefined): { ok: boolean; message: string; data?: unknown } | undefined => (o?.status === 'result' ? o.result : undefined);

/** Commands that need a set-up repo: say so once, with a way forward, instead of letting the CLI fail. */
async function ensureInitialized(ctrl: Controller): Promise<boolean> {
  await ctrl.refresh();
  if (ctrl.currentStatus.status?.initialized === false) {
    void vscode.window.showInformationMessage('DevSarathi is not set up in this repo yet.', 'Run Init').then((c) => {
      if (c) void vscode.commands.executeCommand('devsarathi.init');
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Init wizard (MASTER 5, D-25)
// ---------------------------------------------------------------------------------------------------------------------

export async function initWizard(ctrl: Controller, previews: PreviewProvider): Promise<void> {
  const w = vscode.window;
  const detectRun = await ctrl.run({ command: ['detect'] }, { title: 'detecting your stack', quietSuccess: true, noRefresh: true, cancellable: true });
  const detectResult = resultOf(detectRun?.outcome);
  if (!detectRun || !detectResult || !detectResult.ok) return; // the failure was already shown, with Rerun
  const d = parseDetect(detectResult.data);
  if (!d) {
    void w.showErrorMessage('devsarathi detect did not run: it returned data the extension does not understand. Update DevSarathi and the extension to the same version.');
    return;
  }
  const problems = preflightProblems(d);
  if (problems.length) {
    void w.showErrorMessage(`DevSarathi init cannot start: ${problems.join(' ')}`);
    return;
  }

  // 2. confirm the detected stacks
  const stackText = d.stacks.map(describeStack).join(', ');
  const confirmStacks = await w.showInformationMessage(
    `Detected: ${stackText}.${d.initialized ? ' DevSarathi is already set up here; this refreshes it and keeps your edits.' : ''} Is that right?`,
    { modal: true, detail: d.notes.join('\n') || undefined },
    'Yes, continue'
  );
  if (!confirmStacks) return;

  // 3. baseline branch
  const other = 'Another branch...';
  const preferred = d.existing?.baselineBranch || d.baseline.suggested;
  const branchItems = [...new Set([preferred, ...d.baseline.options])].map((b) => ({ label: b, description: b === d.baseline.suggested ? 'suggested' : undefined }));
  const pickedBranch = await w.showQuickPick([...branchItems, { label: other, description: undefined }], { title: 'DevSarathi init (1/5): baseline branch', placeHolder: 'The graph is built from this branch; your working branch is never switched' });
  if (!pickedBranch) return;
  let baseline = pickedBranch.label;
  if (baseline === other) {
    const typed = await w.showInputBox({ title: 'DevSarathi init: baseline branch', prompt: 'Branch name', validateInput: (v) => validateBranch(v) });
    if (!typed) return;
    baseline = typed.trim();
  }

  // 4. persona name and title
  const persona = await w.showInputBox({ title: 'DevSarathi init (2/5): developer persona', prompt: "The persona's name", value: d.existing?.personaName ?? d.persona.defaultName, validateInput: (v) => validatePersona(v) });
  if (persona === undefined) return;
  const needs = d.persona.needsConfirmation;
  const title = await w.showInputBox({
    title: 'DevSarathi init (3/5): persona title',
    prompt: needs ? `${d.stacks.length} stacks were detected, so you must confirm or edit the persona title (required)` : 'Confirm or edit the persona title',
    value: d.existing?.personaTitle ?? d.persona.proposedTitle,
    validateInput: (v) => validateTitle(v, needs)
  });
  if (title === undefined) return;

  // optional agents: all default yes
  const agentItems = d.optionalAgents.map((a) => ({ label: a, picked: d.existing?.agents[a] ?? true }));
  const pickedAgents = await w.showQuickPick(agentItems, { title: 'DevSarathi init (4/5): optional agents', placeHolder: 'Untick an agent to leave it out (all are on by default)', canPickMany: true });
  if (!pickedAgents) return;

  // a name for each agent that will be created (the developer agent is the persona)
  const agentNames: Record<string, string> = {};
  for (const a of pickedAgents.map((p) => p.label)) {
    const name = await w.showInputBox({ title: `DevSarathi init: name for the ${AGENT_LABELS[a] ?? a} agent`, prompt: `What should the ${AGENT_LABELS[a] ?? a} agent (ds-${a}) be called?`, value: d.existing?.agentNames?.[a] ?? DEFAULT_AGENT_NAMES[a] ?? a, validateInput: (v) => validatePersona(v) });
    if (name === undefined) return;
    agentNames[a] = name.trim();
  }

  // specs
  const specs = await w.showInputBox({ title: 'DevSarathi init (5/5): specs location', prompt: 'Path or glob where specs live (optional, leave empty if none)', value: d.existing?.specsPath ?? '', placeHolder: 'docs/specs/**/*.md' });
  if (specs === undefined) return;

  // optional: have Claude draft stack-specific guidance for each agent file. Only the stack summary is sent.
  const enrichPick = await w.showInformationMessage(
    'Have Claude draft stack-specific guidance for each agent file?',
    { modal: true, detail: 'Only a stack summary is sent (framework and tool names, top-level folder names), to Claude with no tools: no files, shell or web. To see the exact text first, cancel and run: devsarathi enrich --preview. The built-in checklists are used either way.' },
    'Yes, draft with Claude',
    'No, built-in only'
  );
  if (enrichPick === undefined) return;

  // optional: import the workspace map, persona and core rules from CLAUDE.md so Claude loads them every session
  const cmPick = await w.showInformationMessage(
    'Make Claude load the workspace map, persona and core rules every session?',
    { modal: true, detail: 'Adds a small marked block to CLAUDE.md (or creates .claude/CLAUDE.md). A backup is made first and uninstall removes only that block. Unpathed files in .claude/rules already load automatically, so this mainly helps repos that import rules explicitly.' },
    'Add the block',
    'Not now'
  );
  if (cmPick === undefined) return;

  const answers: WizardAnswers = { baseline, persona, title, agents: pickedAgents.map((p) => p.label), specs, agentNames, enrich: enrichPick === 'Yes, draft with Claude', claudeMd: cmPick === 'Add the block' };
  let flags: string[];
  try {
    flags = buildInitFlags(d, answers);
  } catch (err) {
    void w.showErrorMessage(`DevSarathi init: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 5 + 6. token budget and full preview: nothing is written yet
  const previewRun = await ctrl.run({ command: ['init'], flags: ['--preview', ...flags] }, { title: 'preparing the preview', quietSuccess: true, noRefresh: true, cancellable: true });
  const pr = resultOf(previewRun?.outcome);
  if (!previewRun || !pr || !pr.ok) return;
  const preview = parseInitPreview(pr.data);
  if (!preview) {
    void w.showErrorMessage('devsarathi init did not run: the preview came back in a format the extension does not understand.');
    return;
  }
  const uri = previews.set('init-preview.md', buildPreviewDoc(preview));
  const doc = await vscode.workspace.openTextDocument(uri);
  await w.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });

  const fresh = preview.files.filter((f) => f.status === 'new').length;
  const go = await w.showInformationMessage(
    `Create ${fresh} new file(s) and install the hooks? The preview is open next to this window: ${preview.alwaysLoadedTokens} tokens are always loaded.`,
    { modal: true, detail: preview.warnings.join('\n') || undefined },
    'Create'
  );
  if (!go) return;

  // settings.json merge needs its own explicit yes (D-07)
  const flagsToRun = [...flags];
  const need = settingsNeedApproval(preview);
  if (need === 'ask') {
    const merge = await w.showWarningMessage(
      "Merge DevSarathi's hook entries into your existing .claude/settings.json?",
      { modal: true, detail: `${preview.settings.text}\n\nA backup is made first. Nothing else in the file is touched.` },
      'Merge',
      'Do not merge'
    );
    if (!merge) return;
    if (merge === 'Merge') flagsToRun.push('--approve-settings');
  } else if (need === 'invalid') {
    void w.showWarningMessage('.claude/settings.json is not valid JSON, so DevSarathi will not touch it. The Claude Code hook entries stay off until it is fixed.');
  }

  // 7-11. build, generate, hooks, audit under the staged progress notification
  const run = await ctrl.run({ command: ['init'], flags: flagsToRun }, { title: 'init', quietSuccess: true });
  const res = resultOf(run?.outcome);
  if (!run || run.verdict.kind !== 'ok' || !res) return; // not-run / problems were announced by run()
  const root = await ctrl.root();
  const choice = await w.showInformationMessage(summarize(res.message.split('\n').slice(0, 4).join('\n'), 400), 'Open .claude folder', 'Show details');
  if (choice === 'Open .claude folder' && root) void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.join(root, '.claude')));
  else if (choice === 'Show details') ctrl.output.show(true);

  // 12. optional skills step, last
  const skills = await w.showInformationMessage('Optional last step: research Claude skills for this stack? Only a stack summary is sent, and only after you preview it.', { modal: true }, 'Run skills');
  if (skills) await ctrl.run({ command: ['skills'] }, { title: 'skills' });
}

// ---------------------------------------------------------------------------------------------------------------------
// Enhance (MASTER 13)
// ---------------------------------------------------------------------------------------------------------------------

const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]+-\d+$/;
const MAX_PASTE = 20_000; // keeps the argument list well under the Windows command-line limit

async function askEnhanceSource(root: string): Promise<{ flags: string[] } | undefined> {
  const w = vscode.window;
  const pick = await w.showQuickPick(
    [
      { label: 'Use the active spec (or none)', id: 'none' },
      { label: 'Pick a spec file...', id: 'file' },
      { label: 'Jira ticket key...', id: 'jira' }
    ],
    { title: 'DevSarathi enhance: where is the spec?', placeHolder: 'The spec is the source of truth (D-21)' }
  );
  if (!pick) return undefined;
  if (pick.id === 'none') return { flags: [] };
  if (pick.id === 'jira') {
    const key = await w.showInputBox({ title: 'DevSarathi enhance: Jira ticket', prompt: 'Ticket key, for example PROJ-123', validateInput: (v) => (JIRA_KEY.test(v.trim()) ? undefined : 'Enter a key like PROJ-123.') });
    return key ? { flags: [`--jira=${key.trim().toUpperCase()}`] } : undefined;
  }
  const files = await w.showOpenDialog({ canSelectMany: false, defaultUri: vscode.Uri.file(root), filters: { Markdown: ['md', 'markdown'] }, openLabel: 'Use this spec' });
  if (!files?.[0]) return undefined;
  const rel = path.relative(root, files[0].fsPath);
  return { flags: [`--spec=${rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : files[0].fsPath}`] };
}

async function recordOutcome(ctrl: Controller, outcome: 'accepted' | 'edited' | 'rejected'): Promise<void> {
  await ctrl.run({ command: ['enhance'], flags: [`--outcome=${outcome}`] }, { title: 'recording your choice', quietSuccess: true, noRefresh: true });
}

export async function enhanceFlow(ctrl: Controller): Promise<void> {
  const w = vscode.window;
  if (!(await ensureInitialized(ctrl))) return;
  const root = await ctrl.root();
  if (!root) return;
  const request = await w.showInputBox({ title: 'DevSarathi enhance', prompt: 'What do you want done?', placeHolder: 'add retry to the webhook handler', validateInput: (v) => (v.trim() ? undefined : 'Describe the task in a sentence.') });
  if (!request) return;
  const source = await askEnhanceSource(root);
  if (!source) return;

  let flags = source.flags;
  for (let round = 0; round < 3; round++) {
    const spec: RunSpec = { command: ['enhance'], flags, positionals: [request.trim()] };
    const status = (o: CliOutcome): string | undefined => (o.status === 'result' ? (asRec(o.result.data)?.status as string | undefined) : undefined);
    const run = await ctrl.run(spec, {
      title: 'enhance',
      quietSuccess: true,
      cancellable: true,
      noRefresh: true,
      handled: (o) => ['needs-confirmation', 'needs-spec-input', 'ready'].includes(status(o) ?? '')
    });
    const res = resultOf(run?.outcome);
    if (!run || !res) return;
    const data = asRec(res.data);

    if (data?.status === 'needs-spec-input') {
      // D-23: never proceed on partial context. The developer pastes the ticket text instead.
      const act = await w.showWarningMessage(res.message, { modal: true, detail: 'Copy the ticket text to the clipboard, then choose the button.' }, 'Use clipboard text');
      if (!act) return;
      const text = (await vscode.env.clipboard.readText()).trim();
      if (!text) {
        void w.showErrorMessage('The clipboard is empty. Copy the ticket text first.');
        return;
      }
      if (text.length > MAX_PASTE) {
        void w.showErrorMessage(`The pasted text is ${text.length} characters, too long to hand to the CLI. Save it as a markdown spec and choose "Pick a spec file".`);
        return;
      }
      flags = [...flags.filter((f) => !f.startsWith('--paste=')), `--paste=${text}`];
      continue;
    }
    if (data?.status === 'needs-confirmation') {
      const questions = Array.isArray(data.questions) ? data.questions.filter((q): q is string => typeof q === 'string') : [];
      const go = await w.showWarningMessage(`Not ready: ${questions.length} problem(s) to settle first. DevSarathi will not guess.`, { modal: true, detail: questions.map((q, i) => `${i + 1}. ${q}`).join('\n') }, 'I have settled these, continue');
      if (!go) return;
      flags = [...flags.filter((f) => f !== '--confirm'), '--confirm'];
      continue;
    }
    if (data?.status === 'ready' && typeof data.prompt === 'string') {
      await reviewPrompt(ctrl, data.prompt, data.preview !== false);
      return;
    }
    // Anything else (a status we do not know) is shown as it is, never as a success.
    void w.showWarningMessage(`devsarathi enhance returned an unexpected result: ${summarize(res.message)}`);
    return;
  }
}

async function reviewPrompt(ctrl: Controller, prompt: string, preview: boolean): Promise<void> {
  const w = vscode.window;
  if (!preview) {
    await vscode.env.clipboard.writeText(prompt);
    void w.showInformationMessage('Enhanced prompt copied to the clipboard.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: prompt });
  await w.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  const choice = await w.showInformationMessage('Enhanced prompt (nothing has been sent). Accept, edit or reject it?', 'Accept', 'Edit', 'Reject');
  if (choice === 'Accept') {
    await vscode.env.clipboard.writeText(prompt);
    void w.showInformationMessage('Prompt copied to the clipboard: paste it into Claude.');
    await recordOutcome(ctrl, 'accepted');
  } else if (choice === 'Edit') {
    const done = await w.showInformationMessage('Edit the prompt in the open tab, then choose Done.', 'Done', 'Discard');
    if (done === 'Done') {
      const text = doc.getText();
      await vscode.env.clipboard.writeText(text);
      void w.showInformationMessage('Edited prompt copied to the clipboard: paste it into Claude.');
      await recordOutcome(ctrl, text === prompt ? 'accepted' : 'edited');
    } else if (done === 'Discard') await recordOutcome(ctrl, 'rejected');
  } else if (choice === 'Reject') await recordOutcome(ctrl, 'rejected');
  // Dismissed without choosing: nothing is recorded; we do not guess an outcome.
}

// ---------------------------------------------------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------------------------------------------------

export async function decideRule(ctrl: Controller, decision: 'approve' | 'reject', id: string): Promise<void> {
  await ctrl.run({ command: ['rules', decision], positionals: [id] }, { title: `rules ${decision}` });
}

export async function approvalsFlow(ctrl: Controller): Promise<void> {
  const w = vscode.window;
  if (!(await ensureInitialized(ctrl))) return;
  await ctrl.refresh();
  const pending = ctrl.state.pending;
  if (ctrl.state.pendingError) {
    void w.showErrorMessage(`devsarathi rules pending did not run: ${ctrl.state.pendingError}`);
    return;
  }
  if (!pending.length) {
    void w.showInformationMessage('No rule changes are waiting for approval.');
    return;
  }
  const pick = await w.showQuickPick(
    pending.map((c) => ({ label: describeOp(c), description: `${c.risk} risk`, detail: [c.text, c.reason].filter(Boolean).join('  |  '), id: c.id })),
    { title: `DevSarathi: ${pending.length} pending rule change(s)`, placeHolder: 'Pick a change to approve or reject', matchOnDetail: true }
  );
  if (!pick) return;
  const choice = await w.showInformationMessage(`${pick.label} (${pick.description})`, { modal: true, detail: pick.detail }, 'Approve', 'Reject');
  if (choice === 'Approve') await decideRule(ctrl, 'approve', pick.id);
  else if (choice === 'Reject') await decideRule(ctrl, 'reject', pick.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------------------------------

export const COMMAND_IDS = [
  'devsarathi.init',
  'devsarathi.enhance',
  'devsarathi.review',
  'devsarathi.test',
  'devsarathi.refresh',
  'devsarathi.approvals',
  'devsarathi.selftest',
  'devsarathi.skills',
  'devsarathi.dashboard',
  'devsarathi.disable',
  'devsarathi.enable',
  'devsarathi.status',
  'devsarathi.refreshPanel',
  'devsarathi.showOutput'
] as const;

export function registerCommands(ctrl: Controller, dash: DashboardPanel, previews: PreviewProvider): vscode.Disposable[] {
  const reg = (id: (typeof COMMAND_IDS)[number], fn: () => Promise<unknown> | unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async () => {
      try {
        await fn();
      } catch (err) {
        // A bug in the extension must still be visible, never a silent no-op.
        const msg = err instanceof Error ? err.message : String(err);
        ctrl.log(`${id} failed: ${msg}`);
        void vscode.window.showErrorMessage(`${id} did not run: ${msg}`);
      }
    });
  const simple = (command: string[], title: string, needsInit = true) => async (): Promise<void> => {
    if (needsInit && !(await ensureInitialized(ctrl))) return;
    await ctrl.run({ command }, { title });
  };
  return [
    reg('devsarathi.init', () => initWizard(ctrl, previews)),
    reg('devsarathi.enhance', () => enhanceFlow(ctrl)),
    reg('devsarathi.review', simple(['review'], 'review')),
    reg('devsarathi.test', simple(['test'], 'test')),
    reg('devsarathi.refresh', simple(['refresh'], 'refresh')),
    reg('devsarathi.approvals', () => approvalsFlow(ctrl)),
    reg('devsarathi.selftest', simple(['selftest'], 'self-test', false)),
    reg('devsarathi.skills', simple(['skills'], 'skills')),
    reg('devsarathi.dashboard', () => dash.open()),
    reg('devsarathi.disable', simple(['disable'], 'disable')),
    reg('devsarathi.enable', simple(['enable'], 'enable')),
    reg('devsarathi.status', simple(['status'], 'status', false)),
    reg('devsarathi.refreshPanel', () => ctrl.refresh()),
    reg('devsarathi.showOutput', () => ctrl.output.show(true))
  ];
}

/** Sidebar clicks go through the same commands as the palette, so there is one code path per action. */
export async function handlePanelMessage(ctrl: Controller, msg: PanelMessage | undefined): Promise<void> {
  if (!msg) return;
  if (msg.type === 'rule') {
    await decideRule(ctrl, msg.decision, msg.id);
    return;
  }
  const map: Record<string, string> = {
    init: 'devsarathi.init',
    enhance: 'devsarathi.enhance',
    review: 'devsarathi.review',
    test: 'devsarathi.test',
    refresh: 'devsarathi.refresh',
    approvals: 'devsarathi.approvals',
    selftest: 'devsarathi.selftest',
    skills: 'devsarathi.skills',
    dashboard: 'devsarathi.dashboard',
    reload: 'devsarathi.refreshPanel',
    output: 'devsarathi.showOutput',
    toggle: ctrl.currentStatus.status?.disabled ? 'devsarathi.enable' : 'devsarathi.disable'
  };
  const id = map[msg.id];
  if (id) await vscode.commands.executeCommand(id);
}
