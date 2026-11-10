import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DevSarathiConfig } from '@devsarathi/shared';
import { Plan } from '../generate/plan';
import { parseRenderedRules, ParsedRuleLine } from './engine';
import { repoPaths } from '../lib/paths';
import { readJson, writeJson, sha256, normalizeEol, writeFileAtomic } from '../lib/fsutil';
import { saveConfig } from '../lib/config';
import { recordEvent } from '../lib/events';

/**
 * Rule drift after a baseline pull (MASTER 9.4, D-05): low-risk changes auto-apply and are logged;
 * high-risk changes wait for the developer. Only graph-derived rules ever change here: template changes
 * belong to `migrate`, and developer lines are never touched (I-10).
 */
export type ChangeOp = 'add' | 'change' | 'remove';

export interface RuleChange {
  id: string;
  file: string; // repo-relative, posix
  op: ChangeOp;
  risk: 'low' | 'high';
  topic?: string;
  /** Full rendered line (with its source/confidence/evidence comment) for add and change. */
  newLine?: string;
  /** Exact current line for change and remove. */
  oldLine?: string;
  reason: string;
  createdAt: string;
}

const AUTO_TOPICS = new Set(['structure', 'naming-observed', 'routes-observed', 'di-observed', 'test-location']);

function lineOf(content: string, p: ParsedRuleLine): string {
  return normalizeEol(content).split('\n')[p.line - 1];
}

export function diffGraphRules(root: string, cfg: DevSarathiConfig, plan: Plan, now = new Date()): RuleChange[] {
  const changes: RuleChange[] = [];
  const stamp = now.toISOString();
  for (const f of plan.files.filter((x) => x.kind === 'rule')) {
    const abs = path.join(root, ...f.path.split('/'));
    if (!fs.existsSync(abs) || f.status === 'skipped-clash') continue;
    const disk = normalizeEol(fs.readFileSync(abs, 'utf8'));
    const cur = parseRenderedRules(disk).filter((r) => r.source?.startsWith('graph@'));
    const next = parseRenderedRules(f.content).filter((r) => r.source?.startsWith('graph@'));
    const matched = new Set<ParsedRuleLine>();

    for (const n of next) {
      const exact = cur.find((c) => c.text === n.text && !matched.has(c));
      if (exact) {
        matched.add(exact);
        continue;
      }
      const sameTopic = cur.find((c) => c.topic && c.topic === n.topic && !matched.has(c));
      const newLine = lineOf(f.content, n);
      const lowTopic = !!n.topic && AUTO_TOPICS.has(n.topic) && n.confidence !== 'low';
      if (sameTopic) {
        matched.add(sameTopic);
        changes.push({ id: newId(f.path, 'change', n.text), file: f.path, op: 'change', risk: lowTopic ? 'low' : 'high', topic: n.topic, oldLine: lineOf(disk, sameTopic), newLine, reason: `The repo changed: the "${n.topic}" convention now reads differently.`, createdAt: stamp });
      } else {
        changes.push({ id: newId(f.path, 'add', n.text), file: f.path, op: 'add', risk: lowTopic ? 'low' : 'high', topic: n.topic, newLine, reason: `New convention found in the graph (${n.topic ?? 'unnamed'}).`, createdAt: stamp });
      }
    }
    for (const c of cur) {
      if (matched.has(c)) continue;
      // Pruning (evidence gone) is always high risk and needs approval.
      changes.push({ id: newId(f.path, 'remove', c.text), file: f.path, op: 'remove', risk: 'high', topic: c.topic, oldLine: lineOf(disk, c), reason: 'The evidence for this rule no longer exists in the graph.', createdAt: stamp });
    }
  }
  // A change touching many lines is high risk by definition.
  if (changes.length > 5) for (const c of changes) c.risk = 'high';
  return changes;
}

function newId(file: string, op: string, text: string): string {
  return crypto.createHash('sha1').update(`${file}|${op}|${text}`).digest('hex').slice(0, 8);
}

/** Ids of proposals the developer rejected: they are not proposed again (until the underlying rule text changes). */
export function readRejected(root: string): string[] {
  return readJson<string[]>(path.join(repoPaths(root).state, 'rejected-rules.json')) ?? [];
}

export function addRejected(root: string, ids: string[]): void {
  writeJson(path.join(repoPaths(root).state, 'rejected-rules.json'), [...new Set([...readRejected(root), ...ids])]);
}

export function readPending(root: string): RuleChange[] {
  return readJson<RuleChange[]>(repoPaths(root).pendingRules) ?? [];
}

export function writePending(root: string, list: RuleChange[]): void {
  writeJson(repoPaths(root).pendingRules, list);
}

/** Apply one change as a line edit on the file on disk. Returns false when the target line is gone. */
export function applyChange(root: string, cfg: DevSarathiConfig, change: RuleChange): boolean {
  const abs = path.join(root, ...change.file.split('/'));
  if (!fs.existsSync(abs)) return false;
  const original = normalizeEol(fs.readFileSync(abs, 'utf8'));
  const managed = cfg.managedFiles.find((m) => m.path === change.file);
  const wasUnedited = !!managed && sha256(original) === managed.hash;
  const lines = original.split('\n');
  let ok = true;
  if (change.op === 'add' && change.newLine) {
    let last = -1;
    lines.forEach((l, i) => {
      if (/^\s*-\s+/.test(l)) last = i;
    });
    lines.splice(last >= 0 ? last + 1 : lines.length, 0, change.newLine);
  } else if (change.op === 'change' && change.oldLine && change.newLine) {
    const i = lines.indexOf(change.oldLine);
    if (i < 0) ok = false;
    else lines[i] = change.newLine;
  } else if (change.op === 'remove' && change.oldLine) {
    const i = lines.indexOf(change.oldLine);
    if (i < 0) ok = false;
    else lines.splice(i, 1);
  }
  if (!ok) return false;
  const updated = lines.join('\n');
  writeFileAtomic(abs, updated);
  // Only keep tracking the file as "ours, unedited" when it was unedited before: otherwise the developer's
  // own lines would be mistaken for generated ones and regenerated away later (I-10).
  if (wasUnedited && managed) {
    managed.hash = sha256(updated);
    writeFileAtomic(path.join(repoPaths(root).state, 'generated', ...change.file.split('/')), updated);
    saveConfig(root, cfg);
  }
  return true;
}

export function logChange(root: string, change: RuleChange, how: 'auto-applied' | 'approved' | 'rejected'): void {
  recordEvent(root, { type: 'rule-change', data: { how, risk: change.risk, op: change.op } });
  const p = repoPaths(root).changelog;
  const entry = `- ${new Date().toISOString()} ${how} (${change.risk} risk) ${change.op} in ${change.file}: ${change.reason}${change.newLine ? `\n  + ${change.newLine}` : ''}${change.oldLine ? `\n  - ${change.oldLine}` : ''}\n`;
  const head = fs.existsSync(p) ? '' : '# DevSarathi rule changelog\n\nEvery automatic or approved rule change, with its reason and source.\n\n';
  writeFileAtomic(p, (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : head) + entry);
}
