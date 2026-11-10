import * as vscode from 'vscode';
import { CliOutcome, INIT_STAGES, RunSpec, StageTracker, redactSecrets, renderTrail, startCli, buildArgv } from './cli';
import { evaluate, summarize, Verdict, commandLabel } from './result';
import { Notice, NoticeDeduper, NoticeSuppressor, TailState, endOfFile, noticeSeverity, noticeToRerun, noticesFile, readNewNotices } from './notices';
import { PendingChange, StatusView, parsePending, parseStatus } from './format';
import { PanelState } from './panel';
import { pickRepoRoot, findRepoRoot } from './repo';

/*
 * Everything that needs the VS Code API but holds no DevSarathi logic: run a CLI command under a staged progress
 * notification, report its outcome (never a failure as a pass), watch notices.jsonl, and keep the status state that the
 * sidebar and the status bar both draw from.
 */

/** Commands that are safe to stop half way: they only read, or write a single result file at the end. */
const CANCELLABLE = new Set(['review', 'test', 'enhance']);

const PLANNED: Record<string, string[]> = {
  init: INIT_STAGES,
  refresh: ['Building graph', 'Generating rules'],
  'graph build': ['Building graph']
};

export interface UiOptions {
  /** Title in the notification; defaults to the command name. */
  title?: string;
  cancellable?: boolean;
  /** Do not announce success (the caller has a better message). Failures are always announced. */
  quietSuccess?: boolean;
  /** Do not refresh the sidebar afterwards. */
  noRefresh?: boolean;
  /** Return true when the caller deals with this outcome itself (e.g. a question to ask), so nothing is announced. */
  handled?: (outcome: CliOutcome) => boolean;
}

export interface UiResult {
  outcome: CliOutcome;
  verdict: Verdict;
}

const NOTICE_CATCH_UP = 5;

export class Controller implements vscode.Disposable {
  readonly output: vscode.OutputChannel;
  state: PanelState = { pending: [], running: [] };
  private status: StatusView | undefined;
  private statusFetchedAt = 0;
  private listeners = new Set<() => void>();
  private inflight = new Map<string, { cancel(): void }>();
  private refreshing: Promise<void> | undefined;
  private suppressor = new NoticeSuppressor();
  private deduper = new NoticeDeduper();
  private tail: TailState | undefined;
  private tailFile: string | undefined;
  private warnedMissing = false;
  private rootChoice: string | undefined;
  private disposables: vscode.Disposable[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('DevSarathi');
    this.disposables.push(this.output);
  }

  // --- configuration and workspace -------------------------------------------------------------------------------------

  cliPath(): string {
    return vscode.workspace.getConfiguration('devsarathi').get<string>('cliPath') || 'devsarathi';
  }

  /** Repo root for background work: never prompts. */
  quietRoot(): string | undefined {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    return this.rootChoice ?? pickRepoRoot(folders) ?? folders[0];
  }

  /** Repo root for a command the developer started: the first folder with a git repo, else ask. */
  async root(): Promise<string | undefined> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (!folders.length) {
      void vscode.window.showErrorMessage('DevSarathi: open a folder (a git repository) first.');
      return undefined;
    }
    const q = this.quietRoot();
    if (q && (this.rootChoice || pickRepoRoot(folders) || folders.length === 1)) return q;
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f, description: findRepoRoot(f) ? '' : 'not a git repository' })),
      { placeHolder: 'None of the workspace folders is a git repository. Which folder should DevSarathi use?' }
    );
    if (!picked) return undefined;
    this.rootChoice = picked.label;
    return picked.label;
  }

  // --- state ---------------------------------------------------------------------------------------------------------------

  onState(cb: () => void): vscode.Disposable {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  get currentStatus(): { status?: StatusView; fetchedAt: number; error?: string } {
    return { status: this.status, fetchedAt: this.statusFetchedAt, error: this.state.error };
  }

  private emit(): void {
    this.state.running = [...this.inflight.keys()];
    this.state.status = this.status;
    this.state.statusFetchedAt = this.statusFetchedAt;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* a broken listener must not break the others */
      }
    }
  }

  // --- logging ---------------------------------------------------------------------------------------------------------------

  log(line: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${redactSecrets(line)}`);
  }

  private logOutcome(spec: RunSpec, outcome: CliOutcome): void {
    const key = spec.command.join(' ');
    if (outcome.status === 'result') {
      this.log(`devsarathi ${key}: ${outcome.result.ok ? 'ok' : 'FAILED'} (exit ${outcome.exitCode})`);
      for (const l of outcome.result.message.split(/\r?\n/)) if (l.trim()) this.output.appendLine(`    ${redactSecrets(l)}`);
    } else if (outcome.status === 'failed') {
      this.log(`devsarathi ${key}: did not run: ${outcome.error}`);
      for (const l of outcome.stderrTail.split(/\r?\n/).slice(-20)) if (l.trim()) this.output.appendLine(`    ${l}`);
    } else if (outcome.status === 'unavailable') this.log(`devsarathi ${key}: could not start: ${outcome.error}`);
    else this.log(`devsarathi ${key}: cancelled`);
  }

  // --- running commands --------------------------------------------------------------------------------------------------

  /** Background run with no notification (status polling). The caller shows any problem in its own place. */
  async quiet(spec: RunSpec): Promise<CliOutcome | undefined> {
    const root = this.quietRoot();
    if (!root) return undefined;
    return startCli({ cliPath: this.cliPath(), root, spec }).promise;
  }

  /** A command the developer asked for: staged progress, then a result or a "did not run" notification with Rerun. */
  async run(spec: RunSpec, opts: UiOptions = {}): Promise<UiResult | undefined> {
    const root = await this.root();
    if (!root) return undefined;
    const key = spec.command.join(' ');
    if (this.inflight.has(key)) {
      void vscode.window.showInformationMessage(`${commandLabel(spec.command)} is already running.`);
      return undefined;
    }
    // Claim the slot synchronously so a double click cannot start the same command twice.
    this.inflight.set(key, { cancel: () => undefined });
    const tracker = new StageTracker(PLANNED[key] ?? []);
    const win = this.suppressor.start(spec.command, Date.now());
    this.log(`devsarathi ${buildArgv(spec, root).join(' ')}`);
    let outcome: CliOutcome;
    try {
      outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `DevSarathi: ${opts.title ?? key}`, cancellable: opts.cancellable ?? CANCELLABLE.has(key) },
        async (progress, token) => {
          // No time cap (D-14): the notification stays until the CLI is done, and the developer keeps working.
          progress.report({ message: renderTrail(tracker.trail(), 'starting (no time limit)') });
          const run = startCli({
            cliPath: this.cliPath(),
            root,
            spec,
            onStage: (ev) => {
              tracker.update(ev);
              progress.report({ message: renderTrail(tracker.trail(), tracker.currentMessage) });
            }
          });
          this.inflight.set(key, run);
          this.emit();
          token.onCancellationRequested(() => run.cancel());
          const o = await run.promise;
          tracker.finish();
          return o;
        }
      );
    } catch (err) {
      // Whatever went wrong inside the wrapper is still a failure to run, never silence.
      outcome = { status: 'failed', error: err instanceof Error ? err.message : String(err), exitCode: null, stderrTail: '' };
    } finally {
      this.inflight.delete(key);
      this.suppressor.end(win, Date.now());
    }
    this.logOutcome(spec, outcome);
    const verdict = evaluate(spec, outcome);
    if (!opts.handled?.(outcome)) this.announce(spec, verdict, outcome, opts);
    if (!opts.noRefresh) void this.refresh();
    else this.emit();
    return { outcome, verdict };
  }

  private announce(spec: RunSpec, verdict: Verdict, outcome: CliOutcome, opts: UiOptions): void {
    const w = vscode.window;
    const details = 'Show details';
    switch (verdict.kind) {
      case 'not-run': {
        // D-13 / I-4: exactly "<Agent or command> did not run: <error>" plus a Rerun button.
        const extra = outcome.status === 'unavailable' ? ['Open Settings'] : [];
        void w.showErrorMessage(verdict.text, 'Rerun', ...extra, details).then((c) => this.onChoice(c, spec, opts));
        break;
      }
      case 'problems':
        void w.showWarningMessage(verdict.text, details, 'Rerun').then((c) => this.onChoice(c, spec, opts));
        break;
      case 'cancelled':
        void w.showInformationMessage(verdict.text);
        break;
      case 'ok':
        if (!opts.quietSuccess) void w.showInformationMessage(summarize(verdict.text) || `${commandLabel(spec.command)} finished.`, details).then((c) => this.onChoice(c, spec, opts));
        break;
    }
  }

  private onChoice(choice: string | undefined, spec: RunSpec, opts: UiOptions): void {
    if (choice === 'Rerun') void this.run(spec, opts);
    else if (choice === 'Show details') this.output.show(true);
    else if (choice === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'devsarathi.cliPath');
  }

  // --- status and pending list ---------------------------------------------------------------------------------------

  /** Re-reads `status` and `rules pending` and redraws everything. Called after every command and on a timer. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const out = await this.quiet({ command: ['status'] });
        if (!out) {
          this.status = undefined;
          this.state.error = undefined;
          return;
        }
        const v = evaluate({ command: ['status'] }, out);
        const status = out.status === 'result' && out.result.ok ? parseStatus(out.result.data) : undefined;
        if (status) {
          this.status = status;
          this.statusFetchedAt = Date.now();
          this.state.error = undefined;
        } else {
          this.status = undefined;
          this.state.error = v.kind === 'not-run' ? v.failures.map((f) => f.error).join('; ') : 'status returned data the extension does not understand';
          if (out.status === 'unavailable') this.warnMissingCli(out.error);
        }
        let pending: PendingChange[] = [];
        this.state.pendingError = undefined;
        if (status?.initialized && status.pendingRules > 0) {
          const p = await this.quiet({ command: ['rules', 'pending'] });
          if (p?.status === 'result' && p.result.ok) pending = parsePending(p.result.data);
          else this.state.pendingError = p?.status === 'result' ? p.result.message : p && p.status !== 'cancelled' ? (p as { error: string }).error : 'unknown error';
        }
        this.state.pending = pending;
      } catch (err) {
        this.state.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.refreshing = undefined;
        this.emit();
      }
    })();
    return this.refreshing;
  }

  private warnMissingCli(error: string): void {
    if (this.warnedMissing) return;
    this.warnedMissing = true;
    void vscode.window.showErrorMessage(`DevSarathi CLI not available: ${error}`, 'Open Settings').then((c) => {
      if (c === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'devsarathi.cliPath');
    });
  }

  // --- notices.jsonl -------------------------------------------------------------------------------------------------

  /** Starts watching the notices file of the current repo; each new notice is shown once. */
  watchNotices(): void {
    const root = this.quietRoot();
    if (!root) return;
    const file = noticesFile(root);
    if (this.tailFile === file) return;
    this.tailFile = file;
    const key = `devsarathi.noticeTail:${file}`;
    const saved = this.context.workspaceState.get<TailState>(key);
    // First time here: start at the end, so old history is not replayed. Later: continue where we stopped, so notices
    // raised while VS Code was closed (a pre-push hook, a background build) still reach the developer.
    this.tail = saved ?? endOfFile(file);
    const check = (): void => this.checkNotices(file, key);
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '.claude/devsarathi/notices.jsonl'));
      watcher.onDidChange(check);
      watcher.onDidCreate(check);
      this.disposables.push(watcher);
    } catch (err) {
      this.log(`file watcher unavailable, polling only: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The watcher can miss events (network drives, some editors); a cheap stat every 15s is the safety net.
    this.timers.push(setInterval(check, 15_000));
    check();
  }

  checkNotices(file: string, key: string): void {
    if (!this.tail) return;
    let res;
    try {
      res = readNewNotices(file, this.tail);
    } catch (err) {
      this.log(`could not read notices: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.tail = res.state;
    void this.context.workspaceState.update(key, res.state);
    let fresh = this.deduper.fresh(res.notices).filter((n) => !this.suppressor.suppresses(n));
    if (fresh.length > NOTICE_CATCH_UP) {
      this.log(`${fresh.length - NOTICE_CATCH_UP} older notice(s) not shown; see ${file}`);
      fresh = fresh.slice(-NOTICE_CATCH_UP);
    }
    for (const n of fresh) this.showNotice(n);
    if (fresh.length) void this.refresh();
  }

  showNotice(n: Notice): void {
    const text = redactSecrets(n.message);
    const rerun = noticeToRerun(n.source);
    this.log(`notice from ${n.source || 'devsarathi'}: ${text}`);
    const buttons = rerun ? ['Rerun'] : [];
    const show = noticeSeverity(n) === 'error' ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    void show(text, ...buttons).then((c) => {
      if (c === 'Rerun' && rerun) void this.run(rerun);
    });
  }

  /** Timers: status/panel every 60s (MASTER 17). */
  startTimers(): void {
    this.timers.push(setInterval(() => void this.refresh(), 60_000));
  }

  cancelAll(): void {
    for (const r of this.inflight.values()) r.cancel();
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.cancelAll();
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables = [];
    this.listeners.clear();
  }
}
