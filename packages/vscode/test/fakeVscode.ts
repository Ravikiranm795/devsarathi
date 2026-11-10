/*
 * A small in-test fake of the parts of the VS Code API the extension uses. The real `vscode` module only exists inside
 * VS Code, so tests mock it with `vi.mock('vscode', () => import('./fakeVscode').then((m) => m.api))`.
 */

export interface Msg {
  kind: 'error' | 'warning' | 'info';
  text: string;
  items: string[];
}

class Disposable {
  constructor(private fn: () => void = () => undefined) {}
  dispose(): void {
    this.fn();
  }
}

class EventEmitter<T> {
  private ls: ((e: T) => void)[] = [];
  event = (l: (e: T) => void): Disposable => {
    this.ls.push(l);
    return new Disposable(() => (this.ls = this.ls.filter((x) => x !== l)));
  };
  fire(e: T): void {
    for (const l of this.ls) l(e);
  }
}

export const state = {
  messages: [] as Msg[],
  /** Scripted answers for the next notifications, by kind. */
  choices: { error: [] as (string | undefined)[], warning: [] as (string | undefined)[], info: [] as (string | undefined)[] },
  commands: new Map<string, (...a: unknown[]) => unknown>(),
  executed: [] as string[],
  config: { cliPath: 'devsarathi' } as Record<string, unknown>,
  folders: [] as { uri: { fsPath: string }; name: string }[],
  statusItems: [] as { text: string; tooltip?: string; command?: string; shown: boolean }[],
  providers: new Map<string, unknown>(),
  progressTitles: [] as string[],
  progressMessages: [] as string[],
  watchers: 0,
  watcherHandlers: [] as (() => void)[],
  panels: [] as { html: string; disposed: boolean; onDispose?: () => void }[]
};

export function reset(): void {
  state.messages = [];
  state.choices = { error: [], warning: [], info: [] };
  state.commands.clear();
  state.executed = [];
  state.config = { cliPath: 'devsarathi' };
  state.folders = [];
  state.statusItems = [];
  state.providers.clear();
  state.progressTitles = [];
  state.progressMessages = [];
  state.watchers = 0;
  state.watcherHandlers = [];
  state.panels = [];
}

function messenger(kind: Msg['kind']) {
  return (text: string, ...rest: unknown[]): Promise<string | undefined> => {
    const items = rest.filter((r): r is string => typeof r === 'string');
    state.messages.push({ kind, text, items });
    return Promise.resolve(state.choices[kind].shift());
  };
}

const out = { appendLine: () => undefined, append: () => undefined, show: () => undefined, dispose: () => undefined };

export const api = {
  Disposable,
  EventEmitter,
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p.replace(/\\/g, '/'), scheme: 'file' }),
    parse: (s: string) => {
      const m = /^([a-z-]+):(.*)$/.exec(s)!;
      return { scheme: m[1], path: m[2], fsPath: m[2] };
    }
  },
  RelativePattern: class {
    constructor(public base: unknown, public pattern: string) {}
  },
  ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  window: {
    createOutputChannel: () => out,
    showErrorMessage: messenger('error'),
    showWarningMessage: messenger('warning'),
    showInformationMessage: messenger('info'),
    showQuickPick: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
    showOpenDialog: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve(undefined),
    createStatusBarItem: () => {
      const item = { text: '', tooltip: undefined as string | undefined, command: undefined as string | undefined, name: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
      state.statusItems.push(item);
      return item;
    },
    registerWebviewViewProvider: (id: string, provider: unknown) => {
      state.providers.set(id, provider);
      return new Disposable();
    },
    createWebviewPanel: () => {
      const rec = { html: '', disposed: false, onDispose: undefined as (() => void) | undefined };
      state.panels.push(rec);
      return {
        webview: {
          set html(v: string) {
            rec.html = v;
          },
          get html() {
            return rec.html;
          }
        },
        reveal() {},
        onDidDispose(cb: () => void) {
          rec.onDispose = cb;
          return new Disposable();
        },
        dispose() {
          rec.disposed = true;
          rec.onDispose?.();
        }
      };
    },
    withProgress: async (opts: { title?: string }, task: (p: { report(v: { message?: string }): void }, t: { onCancellationRequested(cb: () => void): Disposable }) => Promise<unknown>) => {
      state.progressTitles.push(opts.title ?? '');
      return task({ report: (v) => void (v.message && state.progressMessages.push(v.message)) }, { onCancellationRequested: () => new Disposable() });
    }
  },
  workspace: {
    get workspaceFolders() {
      return state.folders.length ? state.folders : undefined;
    },
    getConfiguration: () => ({ get: (k: string) => state.config[k] }),
    createFileSystemWatcher: () => {
      state.watchers++;
      return { onDidChange: (cb: () => void) => (state.watcherHandlers.push(cb), new Disposable()), onDidCreate: () => new Disposable(), onDidDelete: () => new Disposable(), dispose() {} };
    },
    registerTextDocumentContentProvider: () => new Disposable(),
    openTextDocument: () => Promise.resolve({ getText: () => '' }),
    onDidChangeWorkspaceFolders: () => new Disposable(),
    onDidChangeConfiguration: () => new Disposable()
  },
  commands: {
    registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => {
      state.commands.set(id, fn);
      return new Disposable(() => state.commands.delete(id));
    },
    executeCommand: (id: string, ...args: unknown[]) => {
      state.executed.push(id);
      const fn = state.commands.get(id);
      return Promise.resolve(fn ? fn(...args) : undefined);
    }
  },
  env: { clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() } }
};

export function makeContext(): { subscriptions: { dispose(): void }[]; workspaceState: { get<T>(k: string): T | undefined; update(k: string, v: unknown): Promise<void> } } {
  const store = new Map<string, unknown>();
  return {
    subscriptions: [],
    workspaceState: { get: <T>(k: string) => store.get(k) as T | undefined, update: (k: string, v: unknown) => (store.set(k, v), Promise.resolve()) }
  };
}
