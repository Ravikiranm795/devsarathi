import * as fs from 'fs';
import * as path from 'path';
import { Finding, DevSarathiConfig } from '@devsarathi/shared';
import { parseRenderedRules, ParsedRuleLine } from '../rules/engine';
import { estimateTokens } from '../generate/plan';
import { normalizeEol } from '../lib/fsutil';
import { importedByBlock } from '../hooks/claudemd';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AuditReport {
  status: 'pass' | 'fix';
  findings: Finding[];
  checked: { files: number; rules: number };
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'is', 'be', 'by', 'with', 'as', 'at', 'this', 'that', 'any', 'all', 'your', 'you', 'we', 'do', 'not', 'never', 'always', 'must', 'should', 'use', 'using', 'prefer', 'avoid', 'dont', 'without', 'when', 'new', 'code']);
/** A rule's direction is decided by how it opens: "Never ..." forbids; anything else asks for something. */
const NEGATIVE_START = /^(never|do not|don't|dont|avoid|must not|should not|no)\b/i;
export const polarity = (text: string): 'neg' | 'pos' => (NEGATIVE_START.test(text.trim()) ? 'neg' : 'pos');
const VAGUE = /\b(be careful|try to|as appropriate|when possible|if possible|best practices?|good code|clean code|properly|as needed|if needed|where sensible|reasonable|etc\.?)\b/i;

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/`/g, '')
      .split(/[^a-z0-9_*.$@-]+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

interface Entry extends ParsedRuleLine {
  file: string;
}

let counter = 0;
const fid = () => `AUD-${String(++counter).padStart(3, '0')}`;

function add(list: Finding[], f: Omit<Finding, 'id' | 'agent' | 'redFlag'>): void {
  list.push({ id: fid(), agent: 'auditor', redFlag: false, ...f });
}

/**
 * Deterministic audit of the generated workspace (MASTER 10.5). It never edits anything: it returns a pass,
 * or a fix list the developer decides on. `store` enables the hard evidence check against the graph.
 */
export function auditWorkspace(root: string, cfg: DevSarathiConfig, store?: any): AuditReport {
  counter = 0;
  const findings: Finding[] = [];
  const rulesDir = path.join(root, '.claude', 'rules');
  const agentsDir = path.join(root, '.claude', 'agents');
  const commandsDir = path.join(root, '.claude', 'commands');

  const list = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }
  };
  const ruleFiles = list(rulesDir).filter((f) => f.startsWith('ds-'));
  const agentFiles = new Set(list(agentsDir).map((f) => f.replace(/\.md$/, '')));
  const commandFiles = new Set(list(commandsDir).map((f) => f.replace(/\.md$/, '')));

  const entries: Entry[] = [];
  const contents = new Map<string, string>();
  for (const f of ruleFiles) {
    const text = normalizeEol(fs.readFileSync(path.join(rulesDir, f), 'utf8'));
    contents.set(f, text);
    for (const r of parseRenderedRules(text)) entries.push({ ...r, file: f });
  }

  if (!ruleFiles.includes('ds-core.md')) {
    add(findings, { severity: 'critical', title: 'ds-core.md is missing', detail: 'The always-loaded core rules file does not exist.', suggestion: 'Run: devsarathi migrate' });
  }

  // contradictions and duplicates -----------------------------------------------------------------------------
  const prepared = entries.map((e) => ({ e, tok: tokens(e.text), pol: polarity(e.text) }));
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i];
      const b = prepared[j];
      const sim = jaccard(a.tok, b.tok);
      if (sim >= 0.6 && a.pol !== b.pol) {
        add(findings, {
          severity: 'high',
          title: 'Contradicting rules',
          file: `.claude/rules/${b.e.file}`,
          line: b.e.line,
          detail: `"${a.e.text}" (${a.e.file}:${a.e.line}) and "${b.e.text}" (${b.e.file}:${b.e.line}) say opposite things about the same subject.`,
          suggestion: 'Decide which one is right and remove or reword the other.'
        });
      } else if (sim >= 0.9) {
        add(findings, { severity: 'low', title: 'Duplicate rule', file: `.claude/rules/${b.e.file}`, line: b.e.line, detail: `"${b.e.text}" duplicates a rule in ${a.e.file}:${a.e.line}.`, suggestion: 'Remove one of them.' });
      } else if (a.e.topic && a.e.topic === b.e.topic && a.e.source !== b.e.source && sim < 0.6) {
        add(findings, { severity: 'medium', title: 'Two rules on one topic', file: `.claude/rules/${b.e.file}`, line: b.e.line, detail: `Both ${a.e.file}:${a.e.line} and ${b.e.file}:${b.e.line} set rules for topic "${a.e.topic}" from different sources.`, suggestion: 'Keep the one that matches the repo and drop the other.' });
      }
    }
  }

  // vague rules -----------------------------------------------------------------------------------------------
  for (const e of entries) {
    if (VAGUE.test(e.text) || e.text.split(/\s+/).length < 4) {
      add(findings, { severity: 'low', title: 'Vague rule', file: `.claude/rules/${e.file}`, line: e.line, detail: `"${e.text}" is not specific enough to check.`, suggestion: 'Name the concrete thing to do or avoid, or remove it.' });
    }
  }

  // evidence must exist in the graph (hard check) ---------------------------------------------------------------
  if (store) {
    for (const e of entries) {
      for (const ev of e.evidence) {
        let ok = false;
        try {
          ok = ev.includes('/') || ev.includes('.')
            ? !!store.getFileByPath(ev)
            : !!store.db.prepare('SELECT 1 FROM symbols WHERE name = ? LIMIT 1').get(ev);
        } catch {
          ok = true; // cannot check: do not invent a failure
        }
        if (!ok) {
          add(findings, { severity: 'high', title: 'Rule evidence not found in the graph', file: `.claude/rules/${e.file}`, line: e.line, detail: `"${e.text}" cites ${ev}, which is not in the current graph.`, suggestion: 'Propose removing the rule (a high-risk change that needs your approval) or rebuild the graph.' });
        }
      }
    }
  }

  // the CLAUDE.md import block must point at files that exist
  if (cfg.claudeMd) {
    for (const imp of importedByBlock(root, cfg.claudeMd.file)) {
      if (!fs.existsSync(path.join(root, ...imp.split('/')))) {
        add(findings, { severity: 'high', title: 'CLAUDE.md imports a missing file', file: cfg.claudeMd.file, detail: `The DevSarathi block imports @${imp}, which does not exist, so Claude will not load it.`, suggestion: 'Run: devsarathi migrate' });
      }
    }
  }

  // size ------------------------------------------------------------------------------------------------------
  const core = contents.get('ds-core.md');
  if (core && estimateTokens(core) > 1500) {
    add(findings, { severity: 'medium', title: 'Always-loaded content is too large', file: '.claude/rules/ds-core.md', detail: `ds-core.md is about ${estimateTokens(core)} tokens and is loaded in every session.`, suggestion: 'Move detail into an on-demand rule file.' });
  }
  for (const [f, text] of contents) {
    const n = parseRenderedRules(text).length;
    if (f !== 'ds-core.md' && n > cfg.thresholds.ruleCapPerFile) {
      add(findings, { severity: 'medium', title: 'Rule file over the soft cap', file: `.claude/rules/${f}`, detail: `${n} rules, cap is ${cfg.thresholds.ruleCapPerFile}.`, suggestion: 'Consolidate; DevSarathi will ask for approval before pruning.' });
    }
  }

  // broken references between agents, commands and rule files -------------------------------------------------
  const scan: { file: string; text: string }[] = [];
  for (const f of ruleFiles) scan.push({ file: `.claude/rules/${f}`, text: contents.get(f) ?? '' });
  for (const f of agentFiles) {
    if (f.startsWith('ds-')) scan.push({ file: `.claude/agents/${f}.md`, text: fs.readFileSync(path.join(agentsDir, `${f}.md`), 'utf8') });
  }
  for (const f of commandFiles) {
    if (f.startsWith('ds-')) scan.push({ file: `.claude/commands/${f}.md`, text: fs.readFileSync(path.join(commandsDir, `${f}.md`), 'utf8') });
  }
  const ruleNames = new Set(ruleFiles.map((f) => f.replace(/\.md$/, '')));
  for (const { file, text } of scan) {
    for (const m of text.matchAll(/(?<![\w/-])\/(ds-[a-z-]+)/g)) {
      if (!commandFiles.has(m[1])) add(findings, { severity: 'medium', title: 'Reference to a missing command', file, detail: `Refers to /${m[1]}, which is not in .claude/commands/.`, suggestion: 'Regenerate with: devsarathi migrate' });
    }
    for (const m of text.matchAll(/`(ds-(?:developer|tester|security|peer-review|auditor))`/g)) {
      if (!agentFiles.has(m[1])) add(findings, { severity: 'medium', title: 'Reference to a missing agent', file, detail: `Refers to the ${m[1]} agent, which does not exist (it may have been turned off at init).`, suggestion: `Re-enable it or remove the reference.` });
    }
    for (const m of text.matchAll(/ds-stack-[a-z]+\.md/g)) {
      if (!ruleNames.has(m[0].replace(/\.md$/, ''))) add(findings, { severity: 'medium', title: 'Reference to a missing rule file', file, detail: `Refers to ${m[0]}, which does not exist.`, suggestion: 'Regenerate with: devsarathi migrate' });
    }
  }

  // de-duplicate identical findings (same title/file/line)
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const k = `${f.title}|${f.file}|${f.line}|${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { status: unique.length === 0 ? 'pass' : 'fix', findings: unique, checked: { files: ruleFiles.length + agentFiles.size + commandFiles.size, rules: entries.length } };
}

export function formatAudit(r: AuditReport): string {
  if (r.status === 'pass') return `Audit PASS (${r.checked.rules} rules in ${r.checked.files} files checked).`;
  const lines = r.findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}\n   ${f.detail ?? ''}${f.suggestion ? `\n   Fix: ${f.suggestion}` : ''}`);
  return `Audit found ${r.findings.length} item(s) to fix. Nothing was changed.\n${lines.join('\n')}`;
}
