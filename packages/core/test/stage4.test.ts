import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  runCommand,
  createLogger,
  loadConfig,
  repoPaths,
  readEvents,
  readRegistry,
  previewSettingsMerge,
  mergeSettings,
  removeSettingsEntries,
  uninstallGitHooks,
  dispatcherSource,
  settingsFile,
  parseRenderedRules
} from '../src';
import { tmpDir, rmrf, git, fixtureRepo, write } from './helpers';

const CLI = path.resolve(__dirname, '../../../bin/devsarathi.js');
const dirs: string[] = [];
const mk = <T extends string>(d: T): T => (dirs.push(d), d);
const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.DEVSARATHI_EMBEDDER = 'fake';
  process.env.DEVSARATHI_HOME = mk(tmpDir('ds-home-'));
});
afterAll(() => {
  process.env = { ...savedEnv };
  while (dirs.length) rmrf(dirs.pop() as string);
});

const ctxFor = (root: string) => ({ repoRoot: root, log: createLogger(undefined), progress: () => undefined });
const unconfigured = (fx: string, branch = 'main') => mk(fixtureRepo(fx, { configure: false, branch }));

async function initRepo(root: string, args: Record<string, unknown> = {}) {
  return runCommand('init', { yes: true, persona: 'Asha', ...args }, ctxFor(root));
}

function runHookScript(root: string, name: string, input = ''): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(repoPaths(root).hooks, 'ds-hook.js'), name], { cwd: root, input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('init (MASTER 5)', () => {
  it('sets up a repo end to end and touches nothing that already existed (I-5)', async () => {
    const repo = unconfigured('angular-app');
    const tracked = git(repo, 'ls-files').split('\n');
    const before = Object.fromEntries(tracked.map((f) => [f, fs.readFileSync(path.join(repo, f), 'utf8')]));

    const res = await initRepo(repo);
    expect(res.ok, res.message).toBe(true);
    expect(res.message).toMatch(/Angular Developer/);
    expect(res.message).toMatch(/Audit PASS/);

    const cfg = loadConfig(repo)!;
    expect(cfg.baselineBranch).toBe('main');
    expect(cfg.stacks.map((s) => s.id)).toEqual(['angular']);
    expect(cfg.managedFiles.length).toBeGreaterThan(15);
    expect(fs.existsSync(path.join(repoPaths(repo).graph, 'build-record.json'))).toBe(true);

    // generated workspace
    for (const f of ['.claude/rules/ds-core.md', '.claude/agents/ds-developer.md', '.claude/commands/ds-review.md']) expect(fs.existsSync(path.join(repo, f)), f).toBe(true);

    // tracked files byte-identical; the state folder stays out of git status without touching a tracked file
    for (const f of tracked) expect(fs.readFileSync(path.join(repo, f), 'utf8'), f).toBe(before[f]);
    const status = git(repo, 'status', '--porcelain');
    expect(status).not.toContain('.claude/devsarathi');
    expect(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8')).toContain('.claude/devsarathi/');

    // registered for the dashboard
    expect(readRegistry().map((r) => path.resolve(r.path).toLowerCase())).toContain(path.resolve(repo).toLowerCase());
    expect(readEvents(repo).map((e) => e.type)).toContain('init');
  }, 180000);

  it('installs git hooks and Claude Code hook entries', async () => {
    const repo = unconfigured('python-fastapi');
    await initRepo(repo);
    for (const h of ['post-merge', 'post-rewrite', 'pre-push']) {
      const src = fs.readFileSync(path.join(repo, '.git/hooks', h), 'utf8');
      expect(src, h).toContain('# devsarathi:managed hook=' + h);
      expect(src).toContain('|| true'); // its own step can never fail the hook
    }
    expect(fs.existsSync(path.join(repoPaths(repo).hooks, 'ds-hook.js'))).toBe(true);
    const runtime = JSON.parse(fs.readFileSync(path.join(repoPaths(repo).hooks, 'runtime.json'), 'utf8'));
    expect(fs.existsSync(runtime.cli)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsFile(repo), 'utf8'));
    expect(Object.keys(settings.hooks).sort()).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('devsarathi/hooks/ds-hook.js');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('${CLAUDE_PROJECT_DIR}'); // no machine-specific path
  }, 180000);

  it('is re-runnable: nothing is duplicated and unchanged files are left alone', async () => {
    const repo = unconfigured('python-fastapi');
    await initRepo(repo);
    const hookBefore = fs.readFileSync(path.join(repo, '.git/hooks/pre-push'), 'utf8');
    const settingsBefore = fs.readFileSync(settingsFile(repo), 'utf8');
    const second = await initRepo(repo);
    expect(second.ok, second.message).toBe(true);
    expect(second.message).toMatch(/Created 0 file\(s\)/);
    expect(fs.readFileSync(path.join(repo, '.git/hooks/pre-push'), 'utf8')).toBe(hookBefore);
    expect(fs.readFileSync(settingsFile(repo), 'utf8')).toBe(settingsBefore);
  }, 240000);

  it('more than two stacks must be confirmed, never guessed (D-24)', async () => {
    const repo = unconfigured('angular-app');
    write(repo, 'pom.xml', '<project><artifactId>spring-boot</artifactId></project>');
    write(repo, 'requirements.txt', 'flask\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'more stacks');
    const res = await initRepo(repo);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/persona title must be confirmed/);
    const ok = await initRepo(repo, { title: 'Platform Developer' });
    expect(ok.ok, ok.message).toBe(true);
    expect(loadConfig(repo)!.persona.title).toBe('Platform Developer');
  }, 240000);

  it('refuses outside a git repo and without a terminal or --yes', async () => {
    const plain = mk(tmpDir('ds-plain-'));
    expect((await initRepo(plain)).message).toMatch(/not a git repository/);
    const repo = unconfigured('python-fastapi');
    const res = await runCommand('init', {}, ctxFor(repo));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/interactive/);
  });

  it('runs from the real CLI binary', async () => {
    const repo = unconfigured('python-fastapi');
    const r = spawnSync(process.execPath, [CLI, 'init', '--yes', '--persona', 'Ravi', '-C', repo], { encoding: 'utf8', env: process.env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Python Developer/);
    expect(r.stderr).toMatch(/\[Building graph\]/); // staged progress
    expect(r.stderr).toMatch(/\[Installing hooks\]/);
    const status = spawnSync(process.execPath, [CLI, 'status', '-C', repo], { encoding: 'utf8' });
    expect(status.stdout).toMatch(/graph .* old @ [0-9a-f]{7} \(baseline\)/);
  }, 240000);
});

describe('hooks never block and fail open (I-2, I-3)', () => {
  it('a real push succeeds, with the review notice printed, even though no review exists yet', async () => {
    const repo = unconfigured('python-fastapi');
    await initRepo(repo);
    const remote = mk(tmpDir('ds-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    const r = spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: repo, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'HEAD'));
  }, 240000);

  it('chains onto an existing hook, keeps its exit status, and restores it byte for byte on uninstall', async () => {
    const repo = unconfigured('python-fastapi');
    const original = '#!/bin/sh\necho "team pre-push ran"\nexit 7\n';
    fs.writeFileSync(path.join(repo, '.git/hooks/pre-push'), original, { mode: 0o755 });
    const res = await initRepo(repo);
    expect(res.message).toMatch(/Existing pre-push hook found/);

    const remote = mk(tmpDir('ds-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    const r = spawnSync('git', ['push', 'origin', 'main'], { cwd: repo, encoding: 'utf8' });
    expect(r.stderr + r.stdout).toContain('team pre-push ran');
    expect(r.status).not.toBe(0); // the TEAM's hook said no: DevSarathi never overrides or adds to that

    const cfg = loadConfig(repo)!;
    const out = uninstallGitHooks(cfg);
    expect(out.restored.length).toBe(1);
    expect(fs.readFileSync(path.join(repo, '.git/hooks/pre-push'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(repo, '.git/hooks/post-merge'))).toBe(false); // ours with no original: removed
  }, 240000);

  it('a broken runtime (CLI moved or missing) gives a visible notice and exit 0', async () => {
    const repo = unconfigured('python-fastapi');
    await initRepo(repo);
    fs.writeFileSync(path.join(repoPaths(repo).hooks, 'runtime.json'), JSON.stringify({ node: process.execPath, cli: path.join(repo, 'gone.js') }));
    const r = runHookScript(repo, 'pre-push');
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/pre-push did not run: DevSarathi is not installed/);
    expect(fs.readFileSync(path.join(repoPaths(repo).state, 'notices.jsonl'), 'utf8')).toMatch(/did not run/);
  }, 180000);

  it('the kill switch silences every hook, and enabling brings them back (D-31)', async () => {
    const repo = unconfigured('python-fastapi');
    await initRepo(repo);
    await runCommand('disable', {}, ctxFor(repo));
    const eventsBefore = readEvents(repo).length;
    const off = runHookScript(repo, 'session-start');
    expect(off.status).toBe(0);
    expect(off.stdout).toBe('');
    expect(runHookScript(repo, 'prompt').status).toBe(0);
    expect(readEvents(repo).length).toBe(eventsBefore); // nothing recorded while off

    await runCommand('enable', {}, ctxFor(repo));
    const on = runHookScript(repo, 'session-start');
    expect(on.status).toBe(0);
    expect(on.stdout).toContain('DevSarathi v');
  }, 240000);

  it('session start reports status as JSON the Claude Code hook protocol accepts', async () => {
    const repo = unconfigured('python-fastapi');
    await initRepo(repo);
    const r = runHookScript(repo, 'session-start');
    const j = JSON.parse(r.stdout);
    expect(j.systemMessage).toMatch(/graph .* old @ [0-9a-f]{7} \(baseline\)/);
    expect(j.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(j.hookSpecificOutput.additionalContext.startsWith(j.systemMessage)).toBe(true); // same facts, plus the workspace pointers
  }, 180000);

  it('the prompt hook records a count and never the prompt text (I-8)', async () => {
    const repo = unconfigured('python-fastapi');
    await initRepo(repo);
    runHookScript(repo, 'prompt', JSON.stringify({ prompt: 'my secret AKIAIOSFODNN7EXAMPLE plan' }));
    const events = fs.readFileSync(path.join(repoPaths(repo).metricsDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"type":"prompt"');
    expect(events).not.toContain('AKIA');
    expect(events).not.toContain('secret');
  }, 180000);
});

describe('graph refresh on pull: baseline only (D-08, I-6)', () => {
  /** A repo with a bare remote and a second clone that pushes new commits. */
  async function withRemote() {
    const repo = unconfigured('python-fastapi');
    const remote = mk(tmpDir('ds-remote-'));
    git(remote, 'init', '-q', '--bare');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    await initRepo(repo);
    const other = mk(tmpDir('ds-other-'));
    git(other, 'clone', '-q', '-b', 'main', remote, '.');
    git(other, 'config', 'user.email', 'o@example.com');
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'core.autocrlf', 'false');
    return { repo, remote, other };
  }

  async function waitFor(check: () => boolean, ms = 60000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return check();
  }

  it('a pull that lands on the baseline starts a background refresh', async () => {
    const { repo, other } = await withRemote();
    const first = JSON.parse(fs.readFileSync(repoPaths(repo).buildRecord, 'utf8'));
    write(other, 'app/pulled.py', 'def pulled_in():\n    return 1\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'new module');
    git(other, 'push', '-q', 'origin', 'main');

    const t0 = Date.now();
    git(repo, 'pull', '-q', '--no-rebase', 'origin', 'main'); // fires post-merge
    expect(Date.now() - t0).toBeLessThan(20000); // git did not wait for the build
    expect(readEvents(repo).some((e) => e.type === 'refresh-triggered')).toBe(true);

    const head = git(repo, 'rev-parse', 'HEAD');
    const refreshed = await waitFor(() => {
      try {
        return JSON.parse(fs.readFileSync(repoPaths(repo).buildRecord, 'utf8')).commit === head;
      } catch {
        return false;
      }
    });
    expect(refreshed).toBe(true);
    expect(JSON.parse(fs.readFileSync(repoPaths(repo).buildRecord, 'utf8')).builtAt).not.toBe(first.builtAt);
  }, 240000);

  it('a pull on a feature branch triggers nothing', async () => {
    const { repo, other } = await withRemote();
    git(repo, 'checkout', '-q', '-b', 'feature/q');
    git(repo, 'push', '-q', '-u', 'origin', 'feature/q');
    git(other, 'fetch', '-q', 'origin');
    git(other, 'checkout', '-q', 'feature/q');
    write(other, 'app/feat.py', 'def feat():\n    return 1\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'feature commit');
    git(other, 'push', '-q', 'origin', 'feature/q');

    const buildBefore = fs.readFileSync(repoPaths(repo).buildRecord, 'utf8');
    git(repo, 'pull', '-q', '--no-rebase', 'origin', 'feature/q');
    await new Promise((r) => setTimeout(r, 3000));
    expect(readEvents(repo).filter((e) => e.type === 'refresh-triggered')).toEqual([]);
    expect(fs.readFileSync(repoPaths(repo).buildRecord, 'utf8')).toBe(buildBefore);
    expect(fs.existsSync(path.join(repoPaths(repo).locks, 'graph.lock'))).toBe(false);
  }, 240000);
});

describe('settings merge: the one edit to a file DevSarathi did not create (I-5)', () => {
  const existing = { permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo team stop hook' }] }] }, env: { FOO: 'bar' } };

  it('without approval an existing settings.json is left byte-identical', () => {
    const repo = unconfigured('python-fastapi');
    write(repo, '.claude/settings.json', JSON.stringify(existing, null, 2));
    const before = fs.readFileSync(settingsFile(repo), 'utf8');
    const preview = previewSettingsMerge(repo);
    expect(preview.exists).toBe(true);
    expect(preview.text).toMatch(/backed up first/);
    expect(mergeSettings(repo, false)).toMatchObject({ merged: false, reason: 'not approved' });
    expect(fs.readFileSync(settingsFile(repo), 'utf8')).toBe(before);
  });

  it('with approval it backs up, merges only its own entries, and uninstall removes only those', () => {
    const repo = unconfigured('python-fastapi');
    write(repo, '.claude/settings.json', JSON.stringify(existing, null, 2));
    const before = fs.readFileSync(settingsFile(repo), 'utf8');
    const res = mergeSettings(repo, true);
    expect(res.merged).toBe(true);
    expect(fs.readFileSync(res.backup as string, 'utf8')).toBe(before);

    const merged = JSON.parse(fs.readFileSync(settingsFile(repo), 'utf8'));
    expect(merged.permissions).toEqual(existing.permissions);
    expect(merged.env).toEqual(existing.env);
    expect(merged.hooks.Stop).toHaveLength(2); // the team's own Stop hook is still there
    expect(merged.hooks.Stop[0].hooks[0].command).toBe('echo team stop hook');
    expect(merged.hooks.SessionStart).toHaveLength(1);

    expect(mergeSettings(repo, true).reason).toBe('already present'); // never duplicated
    expect(JSON.parse(fs.readFileSync(settingsFile(repo), 'utf8')).hooks.Stop).toHaveLength(2);

    expect(removeSettingsEntries(repo)).toEqual({ removed: true, deletedFile: false });
    expect(JSON.parse(fs.readFileSync(settingsFile(repo), 'utf8'))).toEqual(existing);
  });

  it('a settings file DevSarathi created itself is deleted again on uninstall', () => {
    const repo = unconfigured('python-fastapi');
    expect(mergeSettings(repo, false).merged).toBe(true); // no file yet: no approval needed
    expect(removeSettingsEntries(repo)).toEqual({ removed: true, deletedFile: true });
    expect(fs.existsSync(settingsFile(repo))).toBe(false);
  });

  it('invalid JSON is never touched', () => {
    const repo = unconfigured('python-fastapi');
    write(repo, '.claude/settings.json', '{ not json');
    expect(previewSettingsMerge(repo).text).toMatch(/not valid JSON/);
    expect(mergeSettings(repo, true).merged).toBe(false);
    expect(fs.readFileSync(settingsFile(repo), 'utf8')).toBe('{ not json');
  });
});

describe('hooks folder resolution', () => {
  it('installs into core.hooksPath when set (Husky-style) and says so', async () => {
    const repo = unconfigured('python-fastapi');
    fs.mkdirSync(path.join(repo, '.husky', '_'), { recursive: true });
    git(repo, 'config', 'core.hooksPath', '.husky/_');
    const res = await initRepo(repo);
    expect(res.message).toMatch(/Husky manages this hooks folder/);
    expect(fs.readFileSync(path.join(repo, '.husky/_/pre-push'), 'utf8')).toContain('devsarathi:managed');
    expect(fs.existsSync(path.join(repo, '.git/hooks/pre-push'))).toBe(false);
  }, 180000);

  it('the dispatcher passes stdin through to the original and uses its exit status', () => {
    const src = dispatcherSource('pre-push', '/x/ds-hook.js', '/x/orig');
    expect(src).toContain('INPUT=$(cat; printf x)');
    expect(src).toMatch(/exit \$\?/);
    expect(dispatcherSource('post-merge', '/x/ds-hook.js', null)).not.toContain('/x/orig');
  });
});

describe('workspace is unaffected by the kill switch for manual use', () => {
  it('manual commands still work while hooks are off', async () => {
    const repo = unconfigured('python-fastapi');
    await initRepo(repo);
    await runCommand('disable', {}, ctxFor(repo));
    const res = await runCommand('impact', { symbol: 'get_user' }, ctxFor(repo));
    expect(res.ok, res.message).toBe(true);
    expect(res.message).toMatch(/Callers/);
    const rules = fs.readFileSync(path.join(repo, '.claude/rules/ds-testing.md'), 'utf8');
    expect(parseRenderedRules(rules).length).toBeGreaterThan(2);
  }, 240000);
});

void execFileSync;
