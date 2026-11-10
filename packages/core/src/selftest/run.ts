import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCommand } from '../registry';
import { nullLogger } from '../lib/logger';
import { git } from '../lib/git';
import { repoPaths } from '../lib/paths';
import { copyTree } from '../lib/copy';

export interface SelfTestCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface SelfTestResult {
  checks: SelfTestCheck[];
  passed: number;
  total: number;
  dir?: string;
}

const FIXTURE = path.resolve(__dirname, '..', '..', '..', '..', 'test-fixtures', 'selftest');
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE'; // the documented AWS example key: never a real credential

/**
 * Planted-problem self-test (MASTER 23, D-27). It copies a small fixture into a throw-away directory, plants known
 * problems, and confirms the checks actually catch them. A check that cannot run counts as FAILED, never as passed.
 * Nothing here touches the developer's repo or home folder: HOME is redirected and the embedder is the offline one.
 */
export async function runSelfTest(opts: { keep?: boolean; onProgress?: (msg: string) => void } = {}): Promise<SelfTestResult> {
  const say = opts.onProgress ?? (() => undefined);
  const checks: SelfTestCheck[] = [];
  const check = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  const saved = { home: process.env.DEVSARATHI_HOME, emb: process.env.DEVSARATHI_EMBEDDER, bemb: process.env.BRAIN_EMBEDDER };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devsarathi-selftest-'));
  const repo = path.join(work, 'repo');
  const remote = path.join(work, 'remote.git');
  process.env.DEVSARATHI_HOME = path.join(work, 'home');
  process.env.DEVSARATHI_EMBEDDER = 'fake';
  process.env.BRAIN_EMBEDDER = 'fake';

  const ctx = { repoRoot: repo, log: nullLogger, progress: () => undefined };
  const G = async (...a: string[]) => {
    const r = await git(a, repo);
    if (!r.ok) throw new Error(`git ${a.join(' ')}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };

  try {
    say('Preparing the fixture repo');
    if (!fs.existsSync(FIXTURE)) throw new Error(`self-test fixture not found at ${FIXTURE}`);
    copyTree(FIXTURE, repo);
    await G('init', '-q', '-b', 'main');
    await G('config', 'user.email', 'selftest@example.invalid');
    await G('config', 'user.name', 'DevSarathi selftest');
    await G('config', 'commit.gpgsign', 'false');
    await G('config', 'core.autocrlf', 'false');
    await G('add', '-A');
    await G('commit', '-q', '-m', 'fixture');
    fs.mkdirSync(remote, { recursive: true });
    await git(['init', '-q', '--bare'], remote);
    await G('remote', 'add', 'origin', remote);
    await G('push', '-q', 'origin', 'main');

    say('Running init on the fixture');
    const init = await runCommand('init', { yes: true, persona: 'Selftest' }, ctx);
    if (!init.ok) throw new Error(`init failed on the fixture: ${init.message}`);

    say('Planting problems');
    await G('checkout', '-q', '-b', 'selftest/planted');
    const base = await G('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'app', 'keys.py'), `AWS_KEY = "${FAKE_KEY}"\n`);
    fs.appendFileSync(path.join(repo, '.env'), `AWS_ACCESS_KEY_ID=${FAKE_KEY}\n`);
    // a method with many references, changed without updating its callers
    fs.writeFileSync(path.join(repo, 'app', 'pricing.py'), 'def compute_price(base, qty, discount):\n    """Now takes a discount. The callers were NOT updated."""\n    return base * qty * (1 - discount)\n');
    // a new function with no test
    fs.writeFileSync(path.join(repo, 'app', 'loyalty.py'), 'def award_points(total):\n    return int(total // 10)\n');
    await G('add', '-A');
    await G('commit', '-q', '-m', 'planted problems');
    const head = await G('rev-parse', 'HEAD');
    // a rule contradiction in a generated rules file
    fs.appendFileSync(
      path.join(repo, '.claude', 'rules', 'ds-architecture.md'),
      '- Always use constructor injection for dependencies. <!-- source:developer -->\n- Never use constructor injection for dependencies. <!-- source:developer -->\n'
    );

    // 1. ds-security flags the key and the env change
    say('Checking ds-security');
    const sec = await runCommand('review', { range: `${base}..${head}`, only: 'security' }, ctx);
    check('ds-security flags the planted key', /Possible aws access key app\/keys\.py/.test(sec.message), firstLine(sec.message));
    check('ds-security flags the modified .env', /Secret or environment file (changed|added).*\.env/.test(sec.message), firstLine(sec.message));
    check('secret values are never printed (I-8)', !sec.message.includes(FAKE_KEY) && !JSON.stringify(sec.data).includes(FAKE_KEY), 'the review output is masked');

    // 2. ds-peer-review (impact) flags the callers that were not updated
    say('Checking impact on callers');
    const imp = await runCommand('review', { range: `${base}..${head}`, only: 'impact' }, ctx);
    check('ds-peer-review flags the callers that were missed', /Changed the signature of compute_price without touching its [3-9]|4 callers/.test(imp.message), firstLine(imp.message));

    // 3. ds-tester flags the missing test
    say('Checking ds-tester');
    const tst = await runCommand('review', { range: `${base}..${head}`, only: 'tester' }, ctx);
    check('ds-tester flags the function without a test', /No test covers new function award_points/.test(tst.message), firstLine(tst.message));

    // 4. ds-auditor flags the contradiction
    say('Checking ds-auditor');
    const aud = await runCommand('audit', {}, ctx);
    check('ds-auditor flags the rule contradiction', /Contradicting rules/.test(aud.message), firstLine(aud.message));

    // 5. the pre-push hook exits 0 while printing the red flags
    say('Pushing through the pre-push hook');
    const push = spawnSync('git', ['push', '-u', 'origin', 'selftest/planted'], { cwd: repo, encoding: 'utf8' });
    const out = `${push.stdout}${push.stderr}`;
    check('the pre-push hook never blocks (push succeeded)', push.status === 0, `git push exit ${push.status}`);
    check('the pre-push hook printed the red flags', /RED FLAGS/.test(out) && !out.includes(FAKE_KEY), firstLine(out) || 'no output');

    // 6. fail-open: a hook that cannot run says so and still exits 0 (I-3)
    say('Checking fail-open');
    const runtime = path.join(repoPaths(repo).hooks, 'runtime.json');
    fs.writeFileSync(runtime, JSON.stringify({ node: process.execPath, cli: path.join(work, 'missing.js') }));
    const broken = spawnSync(process.execPath, [path.join(repoPaths(repo).hooks, 'ds-hook.js'), 'pre-push'], { cwd: repo, encoding: 'utf8', input: '' });
    check('a broken hook fails open with a visible message', broken.status === 0 && /did not run/.test(broken.stderr), firstLine(broken.stderr));
  } catch (err) {
    check('self-test could run', false, err instanceof Error ? err.message : String(err)); // never passes by crashing quietly
  } finally {
    if (saved.home === undefined) delete process.env.DEVSARATHI_HOME;
    else process.env.DEVSARATHI_HOME = saved.home;
    if (saved.emb === undefined) delete process.env.DEVSARATHI_EMBEDDER;
    else process.env.DEVSARATHI_EMBEDDER = saved.emb;
    if (saved.bemb === undefined) delete process.env.BRAIN_EMBEDDER;
    else process.env.BRAIN_EMBEDDER = saved.bemb;
    if (!opts.keep) fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
  const passed = checks.filter((c) => c.passed).length;
  return { checks, passed, total: checks.length, dir: opts.keep ? work : undefined };
}

const firstLine = (s: string) => (s ?? '').split('\n').find((l) => l.trim()) ?? '';
