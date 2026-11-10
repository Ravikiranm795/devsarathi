import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCommand, createLogger, loadConfig, repoPaths, importedByBlock, BEGIN, END, previewClaudeMd } from '../src';
import { tmpDir, rmrf, fixtureRepo, write, git } from './helpers';

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
const repoOf = (fx: string) => mk(fixtureRepo(fx, { configure: false }));
const init = (repo: string, args: Record<string, unknown> = {}) => runCommand('init', { yes: true, persona: 'Sidda', skipHooks: true, ...args }, ctxFor(repo));

describe('workspace map and persona (always loaded)', () => {
  it('ds-index lists every rule file, agent and command that was generated, and says when each loads', async () => {
    const repo = repoOf('angular-app');
    const r = await init(repo);
    expect(r.ok, r.message).toBe(true);
    const index = fs.readFileSync(path.join(repo, '.claude/rules/ds-index.md'), 'utf8');
    expect(index).not.toMatch(/^---/); // no paths: loaded every session
    expect(index).not.toMatch(/\{\{/);
    expect(index).toContain('Sidda, Angular Developer');
    for (const rule of ['ds-index.md', 'ds-persona.md', 'ds-core.md', 'ds-architecture.md', 'ds-naming-style.md', 'ds-testing.md', 'ds-stack-angular.md']) expect(index, rule).toContain(`\`${rule}\``);
    expect(index).toMatch(/`ds-core\.md` \| always/);
    expect(index).toMatch(/`ds-stack-angular\.md` \| on demand: src\/\*\*\/\*\.ts/);
    for (const agent of ['ds-developer', 'ds-tester', 'ds-security', 'ds-peer-review', 'ds-auditor']) expect(index, agent).toContain(`\`${agent}\``);
    for (const cmd of ['/ds-status', '/ds-impact <symbol> | --file <path>', '/ds-review', '/ds-enhance', '/ds-test']) expect(index, cmd).toContain(cmd);
    expect(index).toContain('Jasmine/Karma');
    expect(index).toMatch(/Never\n\n1\. Read, print or hard-code secret values/);
  }, 240000);

  it('the persona file carries the identity, the operating principles and the hand-offs', async () => {
    const repo = repoOf('python-fastapi');
    await init(repo, { persona: 'Asha' });
    const p = fs.readFileSync(path.join(repo, '.claude/rules/ds-persona.md'), 'utf8');
    expect(p).toContain('# Persona: Asha, Python Developer');
    expect(p).toMatch(/Ask before guessing/);
    expect(p).toMatch(/\| The task is complete \| Hand off to Tara \(`ds-tester`/);
    expect(p).toContain('python -m pytest -q');
  }, 240000);

  it('an agent turned off disappears from the map instead of being advertised', async () => {
    const repo = repoOf('python-fastapi');
    await init(repo, { agents: 'security,auditor,peer-review' });
    const index = fs.readFileSync(path.join(repo, '.claude/rules/ds-index.md'), 'utf8');
    expect(index).not.toMatch(/\| `ds-tester` \|/);
    expect(index).toMatch(/\| `ds-security` \|/);
  }, 240000);

  it('the generated workspace still audits clean with the new files', async () => {
    const repo = repoOf('java-spring');
    await init(repo);
    const res = await runCommand('audit', {}, ctxFor(repo));
    expect(res.ok, res.message).toBe(true);
  }, 240000);

  it('the session-start context names the persona, the rules index, the agents and the commands', async () => {
    const repo = mk(fixtureRepo('python-fastapi', { configure: false }));
    await runCommand('init', { yes: true, persona: 'Asha' }, ctxFor(repo));
    const r = spawnSync(process.execPath, [path.join(repoPaths(repo).hooks, 'ds-hook.js'), 'session-start'], { cwd: repo, encoding: 'utf8' });
    const j = JSON.parse(r.stdout);
    expect(j.hookSpecificOutput.additionalContext).toMatch(/persona Asha \(Python Developer\)/);
    expect(j.hookSpecificOutput.additionalContext).toMatch(/ds-index\.md/);
    expect(j.hookSpecificOutput.additionalContext).toMatch(/\/ds-\*/);
    expect(j.systemMessage).not.toMatch(/persona/); // the user-visible line stays one short status line
  }, 240000);
});

describe('CLAUDE.md import block (makes Claude load the map, persona and core rules)', () => {
  const EXISTING = '# my-project\n\nProject rules live in `.claude/rules/`.\n\n@.claude/rules/00-overview.md\n@.claude/rules/20-persona.md\n';

  it('an existing CLAUDE.md is left alone without the flag, with a note on how to add the block', async () => {
    const repo = repoOf('angular-app');
    write(repo, 'CLAUDE.md', EXISTING);
    const r = await init(repo);
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(EXISTING);
    expect(r.message).toMatch(/init --claude-md/);
    expect(loadConfig(repo)!.claudeMd).toBeUndefined();
  }, 240000);

  it('--claude-md appends a marked block after a backup and keeps every line of the original', async () => {
    const repo = repoOf('angular-app');
    write(repo, 'CLAUDE.md', EXISTING);
    const r = await init(repo, { claudeMd: true });
    expect(r.ok, r.message).toBe(true);
    const after = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(after.startsWith(EXISTING)).toBe(true);
    expect(after).toContain(BEGIN);
    expect(after).toContain('@.claude/rules/ds-index.md');
    expect(after).toContain('@.claude/rules/ds-persona.md');
    expect(after).toContain('@.claude/rules/ds-core.md');
    expect(after).not.toContain('@.claude/rules/ds-stack-angular.md'); // on-demand files keep loading by their paths
    expect(after.trimEnd().endsWith(END)).toBe(true);

    const cfg = loadConfig(repo)!;
    expect(cfg.claudeMd).toMatchObject({ file: 'CLAUDE.md', created: false });
    expect(fs.readFileSync(cfg.claudeMd!.backup as string, 'utf8')).toBe(EXISTING);
    expect(r.message).toMatch(/CLAUDE\.md: the DevSarathi import block is in CLAUDE\.md/);
    // every import points at a file that exists
    for (const imp of importedByBlock(repo, 'CLAUDE.md')) expect(fs.existsSync(path.join(repo, imp)), imp).toBe(true);
  }, 240000);

  it('re-running refreshes the block in place and never duplicates it', async () => {
    const repo = repoOf('angular-app');
    write(repo, 'CLAUDE.md', EXISTING);
    await init(repo, { claudeMd: true });
    const once = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    await init(repo, { claudeMd: true });
    await runCommand('migrate', { yes: true }, ctxFor(repo));
    const twice = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(twice).toBe(once);
    expect(twice.split(BEGIN).length - 1).toBe(1);
  }, 300000);

  it('creates .claude/CLAUDE.md when none exists, and uninstall deletes it again', async () => {
    const repo = repoOf('python-fastapi');
    const r = await init(repo, { claudeMd: true });
    expect(r.ok, r.message).toBe(true);
    expect(fs.existsSync(path.join(repo, '.claude/CLAUDE.md'))).toBe(true);
    expect(loadConfig(repo)!.claudeMd).toMatchObject({ file: '.claude/CLAUDE.md', created: true });
    const u = await runCommand('uninstall', { yes: true }, ctxFor(repo));
    expect(u.message).toMatch(/the file was created by DevSarathi, so it was deleted/);
    expect(fs.existsSync(path.join(repo, '.claude/CLAUDE.md'))).toBe(false);
  }, 300000);

  it('uninstall removes only the block and leaves the rest of the developer file byte-identical', async () => {
    const repo = repoOf('angular-app');
    write(repo, 'CLAUDE.md', EXISTING);
    await init(repo, { claudeMd: true });
    const u = await runCommand('uninstall', { yes: true }, ctxFor(repo));
    expect(u.ok, u.message).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(EXISTING);
  }, 300000);

  it('the auditor flags an import that points at a file that is gone', async () => {
    const repo = repoOf('python-fastapi');
    await init(repo, { claudeMd: true });
    fs.rmSync(path.join(repo, '.claude/rules/ds-persona.md'));
    const a = await runCommand('audit', {}, ctxFor(repo));
    expect(a.ok).toBe(false);
    expect(a.message).toMatch(/CLAUDE\.md imports a missing file/);
    expect(a.message).toMatch(/@\.claude\/rules\/ds-persona\.md/);
  }, 240000);

  it('the preview says whether the repo already imports rules by @ (so adding ours follows its convention)', () => {
    const repo = repoOf('python-fastapi');
    write(repo, 'CLAUDE.md', EXISTING);
    git(repo, 'add', '-A');
    const p = previewClaudeMd(repo);
    expect(p.recommended).toBe(true);
    expect(p.alreadyMerged).toBe(false);
    expect(p.text).toMatch(/a backup is made first/);
    const none = previewClaudeMd(repoOf('python-fastapi'));
    expect(none.target.exists).toBe(false);
    expect(none.recommended).toBe(false);
    expect(none.text).toMatch(/Note: unpathed files in .claude\/rules\/ already load automatically/);
  });

  it('init --preview reports the CLAUDE.md plan without writing anything', async () => {
    const repo = repoOf('angular-app');
    write(repo, 'CLAUDE.md', EXISTING);
    const r = await runCommand('init', { yes: true, persona: 'Sidda', preview: true }, ctxFor(repo));
    const data = r.data as { claudeMd: { file: string; exists: boolean; recommended: boolean } };
    expect(data.claudeMd).toMatchObject({ file: 'CLAUDE.md', exists: true, recommended: true });
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe(EXISTING);
    expect(fs.existsSync(repoPaths(repo).config)).toBe(false);
  }, 240000);
});
