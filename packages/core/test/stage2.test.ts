import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  detectStacks,
  personaTitle,
  DrishtiClient,
  computeOverlay,
  overlayImpact,
  impactOfSymbol,
  repoPaths,
  redact,
  isSecretFile,
  brain,
  buildGraphLocked
} from '../src';
import { tmpDir, rmrf, git, fixtureRepo, write, copyDirSync } from './helpers';
import { saveConfigFor } from './fixtureConfig';

const dirs: string[] = [];
const mk = <T extends string>(d: T): T => (dirs.push(d), d);
const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.DEVSARATHI_EMBEDDER = 'fake'; // deterministic, offline: the embedding model is not what these tests cover
  process.env.DEVSARATHI_HOME = mk(tmpDir('ds-home-'));
});
afterEach(() => {
  process.env.DEVSARATHI_EMBEDDER = 'fake';
  delete process.env.DEVSARATHI_OFFLINE;
  delete process.env.DEVSARATHI_MODEL_DIR;
});
afterAll(() => {
  process.env = { ...savedEnv };
  while (dirs.length) rmrf(dirs.pop() as string);
});

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function treeHash(root: string, skip: (rel: string) => boolean): string {
  const h = crypto.createHash('sha256');
  for (const f of walkFiles(root).sort()) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (skip(rel)) continue;
    h.update(rel).update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

describe('stack detection (MASTER 6)', () => {
  it('detects Angular with its tooling', () => {
    const r = detectStacks(path.resolve(__dirname, '../../../test-fixtures/angular-app'));
    expect(r.stacks.map((s) => s.id)).toEqual(['angular']);
    const s = r.stacks[0];
    expect(s.category).toBe('frontend');
    expect(s.testFramework).toBe('Jasmine/Karma');
    expect(s.linter).toBe('ESLint');
    expect(s.buildTool).toBe('Angular CLI');
    expect(s.frameworks).toContain('NgRx');
    expect(s.stateManagement).toBe('NgRx');
  });

  it('detects Java + Spring Boot, Maven and JUnit 5', () => {
    const s = detectStacks(path.resolve(__dirname, '../../../test-fixtures/java-spring')).stacks[0];
    expect(s.id).toBe('java');
    expect(s.frameworks).toContain('Spring Boot');
    expect(s.buildTool).toBe('Maven');
    expect(s.testFramework).toBe('JUnit 5');
  });

  it('detects Python + FastAPI, pytest and Ruff', () => {
    const s = detectStacks(path.resolve(__dirname, '../../../test-fixtures/python-fastapi')).stacks[0];
    expect(s.id).toBe('python');
    expect(s.frameworks).toContain('FastAPI');
    expect(s.testFramework).toBe('pytest');
    expect(s.linter).toBe('Ruff');
    expect(s.packageManager).toBe('pip');
  });

  it('recognises a full-stack repo from subfolders and says where each stack was found', () => {
    const root = mk(tmpDir('ds-mono-'));
    copyDirSync(path.resolve(__dirname, '../../../test-fixtures/angular-app'), path.join(root, 'frontend'));
    copyDirSync(path.resolve(__dirname, '../../../test-fixtures/java-spring'), path.join(root, 'backend'));
    const r = detectStacks(root);
    expect(r.stacks.map((s) => s.id)).toEqual(['angular', 'java']);
    expect(r.notes.join(' ')).toMatch(/"frontend" subfolder/);
    expect(personaTitle(r.stacks).title).toBe('Full Stack Developer (Angular + Java)');
  });

  it('React is not reported next to Angular in the same folder', () => {
    const root = mk(tmpDir('ds-react-'));
    write(root, 'package.json', JSON.stringify({ dependencies: { react: '18', '@angular/core': '17' } }));
    expect(detectStacks(root).stacks.map((s) => s.id)).toEqual(['angular']);
  });

  it('reports nothing for an unsupported repo instead of guessing', () => {
    const root = mk(tmpDir('ds-none-'));
    write(root, 'main.go', 'package main');
    const r = detectStacks(root);
    expect(r.stacks).toEqual([]);
    expect(r.notes[0]).toMatch(/No supported stack/);
  });

  it('persona titles follow the rules, and more than two stacks must be confirmed (D-24)', () => {
    const A = { id: 'angular', category: 'frontend' } as const;
    const R = { id: 'react', category: 'frontend' } as const;
    const J = { id: 'java', category: 'backend' } as const;
    const P = { id: 'python', category: 'backend' } as const;
    expect(personaTitle([A])).toEqual({ title: 'Angular Developer', needsConfirmation: false });
    expect(personaTitle([A, R]).title).toBe('Front-end Developer (Angular + React)');
    expect(personaTitle([A, J]).title).toBe('Full Stack Developer (Angular + Java)');
    expect(personaTitle([A, J, P]).needsConfirmation).toBe(true);
  });
});

describe('graph build: baseline model, coverage, secrets', () => {
  let py: string;
  let client: DrishtiClient;
  beforeAll(async () => {
    py = mk(fixtureRepo('python-fastapi'));
    client = new DrishtiClient(py);
    await client.build({ full: true });
  }, 120000);

  it('records branch, commit, baseline label and coverage', () => {
    const r = client.lastBuild()!;
    expect(r.branch).toBe('main');
    expect(r.commit).toBe(git(py, 'rev-parse', 'HEAD'));
    expect(r.baseline).toBe(true);
    expect(r.status).toBe('completed');
    expect(r.coverage.parsedFiles).toBe(r.coverage.eligibleFiles);
    expect(r.coverage.ratio).toBe(1);
    expect(r.belowThreshold).toBe(false);
    expect(r.coverage.symbols).toBeGreaterThan(4);
  });

  it('keeps the graph inside .claude/devsarathi/graph and writes nothing else into the repo (I-5)', () => {
    expect(fs.existsSync(path.join(repoPaths(py).graph, 'graph.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(py, 'BRAIN-INSTRUCTIONS.md'))).toBe(false);
    const status = git(py, 'status', '--porcelain');
    expect(status.split('\n').filter((l) => l && !l.includes('.claude'))).toEqual([]);
  });

  it('impact of a function lists callers from both modules, with a confidence grade and reasons', () => {
    const h = client.open();
    try {
      const hits = h.store.searchByName('get_user', 5) as { symbolId: number }[];
      const symId = hits.map((x) => x.symbolId).find((id) => h.store.getSymbolById(id).name === 'get_user')!;
      expect(symId).toBeTruthy();
      const impact = impactOfSymbol(h.store, symId)!;
      const callerNames = impact.callers.map((c) => c.name).sort();
      expect(callerNames).toEqual(expect.arrayContaining(['invoice_owner', 'read_user']));
      expect(['high', 'medium', 'low']).toContain(impact.confidence);
      expect(impact.reasons.join(' ')).toMatch(/dynamic|reflection/i); // the accuracy limit is always stated
      expect(impact.risk).toBe('untested'); // no test calls get_user
    } finally {
      h.close();
    }
  });

  it('a second build with no changes is incremental', async () => {
    const out = await client.build({});
    expect(out.record.full).toBe(false);
    expect(out.record.coverage.ratio).toBe(1);
  });
});

describe('secrets never enter the graph (I-8)', () => {
  it('Angular: .env is recorded by path only; its values are not in any graph file', async () => {
    const repo = mk(fixtureRepo('angular-app'));
    const client = new DrishtiClient(repo);
    await client.build({ full: true });
    expect(client.secretFiles()).toContain('.env');
    for (const f of walkFiles(repoPaths(repo).graph)) {
      const bytes = fs.readFileSync(f).toString('latin1');
      expect(bytes, f).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(bytes, f).not.toContain('wJalrXUtnFEMI');
    }
  }, 120000);

  it('Java: a hard-coded key inside ordinary source is masked before it is stored', async () => {
    const repo = mk(fixtureRepo('java-spring'));
    const client = new DrishtiClient(repo);
    await client.build({ full: true });
    const h = client.open();
    try {
      const rows = h.store.db.prepare('SELECT code FROM chunks').all() as { code: string }[];
      expect(rows.some((r) => r.code.includes('[redacted:'))).toBe(true);
    } finally {
      h.close();
    }
    for (const f of walkFiles(repoPaths(repo).graph)) {
      expect(fs.readFileSync(f).toString('latin1'), f).not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
  }, 120000);

  it('the TypeScript scanner patterns and the brain patterns agree', () => {
    const samples = [
      'AKIAIOSFODNN7EXAMPLE',
      `ghp_${'b'.repeat(36)}`,
      'xoxb-123456789012-abcdefghijkl',
      `sk_live_${'c'.repeat(24)}`,
      `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`,
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
      'password = "correct-horse-battery"',
      'const nothing = 42; // harmless'
    ];
    const { redactSecrets } = brain.secrets();
    for (const s of samples) expect(redact(s) !== s, s).toBe(redactSecrets(s) !== s);
    for (const f of ['.env', 'a/.env.local', 'x.pem', 'credentials.json', '.env.example', 'src/app.ts']) {
      expect(isSecretFile(f), f).toBe(brain.secrets().isSecretFile(f));
    }
  });
});

describe('baseline branch model (D-08, I-6)', () => {
  it('builds the baseline from a temp worktree while the developer stays on a feature branch', async () => {
    const repo = mk(fixtureRepo('python-fastapi'));
    const baselineCommit = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'feature/x');
    write(repo, 'app/feature_only.py', 'def only_on_feature():\n    return 1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'feature work');
    write(repo, 'app/uncommitted.py', 'def scratch():\n    return 2\n');

    const client = new DrishtiClient(repo);
    const { record } = await client.build({ full: true });
    expect(record.branch).toBe('main');
    expect(record.commit).toBe(baselineCommit);
    expect(record.baseline).toBe(true);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/x'); // never switched
    expect(fs.existsSync(path.join(repo, 'app', 'uncommitted.py'))).toBe(true); // untouched
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1); // temp worktree cleaned up

    const h = client.open();
    try {
      const names = (h.store.db.prepare('SELECT name FROM symbols').all() as { name: string }[]).map((r) => r.name);
      expect(names).toContain('get_user');
      expect(names).not.toContain('only_on_feature');
      expect(names).not.toContain('scratch');
    } finally {
      h.close();
    }
  }, 120000);

  it('a manual build of another branch is labeled non-baseline and never presented as baseline', async () => {
    const repo = mk(fixtureRepo('python-fastapi'));
    git(repo, 'checkout', '-q', '-b', 'feature/y');
    write(repo, 'app/extra.py', 'def extra():\n    return 1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'extra');
    const { record } = await new DrishtiClient(repo).build({ full: true, mode: 'current' });
    expect(record.branch).toBe('feature/y');
    expect(record.baseline).toBe(false);
  }, 120000);

  it('the queued, locked entry point runs the build once and reports it', async () => {
    const repo = mk(fixtureRepo('python-fastapi'));
    const res = await buildGraphLocked(repo, { full: true });
    expect(res.ran).toBe(true);
    expect(res.outcome?.record.status).toBe('completed');
    expect(fs.existsSync(path.join(repoPaths(repo).locks, 'graph.lock'))).toBe(false);
  }, 120000);
});

describe('coverage threshold and failure handling (D-10, MASTER 7.4)', () => {
  it('a repo with an unparseable-by-size code file falls below the threshold', async () => {
    const repo = mk(fixtureRepo('python-fastapi', { configure: false }));
    write(repo, 'app/generated.py', '# generated\n' + 'x = 1\n'.repeat(70000)); // > 300 KB, skipped by the walker
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'big');
    saveConfigFor(repo, 'main', { thresholds: { coverage: 0.9 } });
    const { record, notes } = await new DrishtiClient(repo).build({ full: true });
    expect(record.coverage.eligibleFiles).toBeGreaterThan(record.coverage.parsedFiles);
    expect(record.belowThreshold).toBe(true);
    expect(notes.join(' ')).toMatch(/template rule layer/);
  }, 120000);

  it('a failed incremental build keeps the previous graph in use and says so', async () => {
    const repo = mk(fixtureRepo('python-fastapi'));
    const client = new DrishtiClient(repo);
    const first = (await client.build({ full: true })).record;

    write(repo, 'app/new_module.py', 'def brand_new():\n    return 1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'new module');

    // No model available and no network allowed: embedding the new symbols must fail.
    delete process.env.DEVSARATHI_EMBEDDER;
    delete process.env.BRAIN_EMBEDDER;
    process.env.DEVSARATHI_OFFLINE = '1';
    process.env.BRAIN_OFFLINE = '1';
    process.env.BRAIN_MODEL_DIR = mk(tmpDir('ds-nomodel-'));
    await expect(client.build({})).rejects.toThrow(/graph build failed/);
    delete process.env.BRAIN_OFFLINE;
    process.env.BRAIN_EMBEDDER = 'fake';

    const after = client.lastBuild()!;
    expect(after.commit).toBe(first.commit);
    expect(after.builtAt).toBe(first.builtAt);
    expect(fs.existsSync(path.join(repoPaths(repo).state, 'last-build-failure.json'))).toBe(true);
    expect(fs.readFileSync(path.join(repoPaths(repo).state, 'notices.jsonl'), 'utf8')).toMatch(/previous graph is still in use/);
    expect(fs.existsSync(`${repoPaths(repo).graph}.next`)).toBe(false);
    // and the old graph still answers queries
    const h = client.open();
    try {
      expect(h.store.countSymbols()).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  }, 120000);
});

describe('overlay: uncommitted and unpushed changes on top of the baseline (D-09)', () => {
  it('flags a changed function whose callers live in files the change does not touch', async () => {
    const repo = mk(fixtureRepo('python-fastapi'));
    const client = new DrishtiClient(repo);
    await client.build({ full: true });
    const before = client.lastBuild()!;

    // change the signature of get_user (uncommitted) without touching its callers
    write(repo, 'app/services.py', 'def get_user(user_id, tenant):\n    return {"id": user_id, "tenant": tenant}\n\n\ndef format_name(name):\n    return name.strip().upper()\n\n\ndef newly_added():\n    return 1\n');

    const overlay = await computeOverlay(repo, client);
    expect(overlay.files.map((f) => f.path)).toContain('app/services.py');
    const byName = Object.fromEntries(overlay.symbols.map((s) => [s.name, s.change]));
    expect(byName['get_user']).toBe('modified');
    expect(byName['newly_added']).toBe('added');
    expect(byName['format_name']).toBeUndefined(); // unchanged

    const impacts = overlayImpact(client, overlay);
    const gu = impacts.find((i) => i.changed.name === 'get_user')!;
    expect(gu.untouchedCallers.map((c) => c.name).sort()).toEqual(expect.arrayContaining(['invoice_owner', 'read_user']));

    // the overlay never rebuilds the graph (I-6)
    expect(client.lastBuild()!.builtAt).toBe(before.builtAt);
  }, 120000);

  it('treats deletions and committed-but-unmerged work as changes too', async () => {
    const repo = mk(fixtureRepo('python-fastapi'));
    const client = new DrishtiClient(repo);
    await client.build({ full: true });
    git(repo, 'checkout', '-q', '-b', 'feature/z');
    write(repo, 'app/branch_only.py', 'def b():\n    return 1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'branch work');
    fs.rmSync(path.join(repo, 'app', 'billing.py'));

    const overlay = await computeOverlay(repo, client);
    const files = Object.fromEntries(overlay.files.map((f) => [f.path, f]));
    expect(files['app/branch_only.py'].source).toBe('unpushed');
    expect(files['app/billing.py'].status).toBe('deleted');
    expect(overlay.symbols.filter((s) => s.path === 'app/billing.py').map((s) => s.change)).toEqual(expect.arrayContaining(['removed']));
  }, 120000);

  it('never reads a secret file, even to diff it', async () => {
    const repo = mk(fixtureRepo('angular-app'));
    const client = new DrishtiClient(repo);
    await client.build({ full: true });
    write(repo, '.env', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nNEW=1\n');
    const overlay = await computeOverlay(repo, client);
    expect(overlay.files.map((f) => f.path)).toContain('.env'); // reported as changed...
    expect(overlay.symbols.filter((s) => s.path === '.env')).toEqual([]); // ...but never parsed
    expect(JSON.stringify(overlay)).not.toContain('AKIA');
  }, 120000);
});

describe('whole-tree integrity', () => {
  it('building the graph leaves every tracked file byte-identical (I-5)', async () => {
    const repo = mk(fixtureRepo('java-spring'));
    const before = treeHash(repo, (rel) => rel.startsWith('.git/') || rel.startsWith('.claude/'));
    await new DrishtiClient(repo).build({ full: true });
    expect(treeHash(repo, (rel) => rel.startsWith('.git/') || rel.startsWith('.claude/'))).toBe(before);
  }, 120000);
});
