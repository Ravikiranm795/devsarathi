import * as crypto from 'crypto';

/**
 * Hybrid rule layers (MASTER 9.1). Precedence when two rules share a topic:
 *   developer > template-strict > graph > template-default
 */
export type RuleLayer = 'developer' | 'template-strict' | 'graph' | 'template-default';

export const PRECEDENCE: Record<RuleLayer, number> = {
  developer: 4,
  'template-strict': 3,
  graph: 2,
  'template-default': 1
};

export type RuleFileKey = 'core' | 'architecture' | 'naming-style' | 'testing' | `stack-${string}`;

export interface Rule {
  id: string;
  text: string;
  layer: RuleLayer;
  topic?: string;
  /** template@<ver> | graph@<build-commit> | developer (MASTER 9.3) */
  source: string;
  /** graph-derived rules only */
  confidence?: 'high' | 'medium' | 'low';
  /** graph-derived rules only: paths or symbols that justify the rule */
  evidence?: string[];
  file: RuleFileKey;
}

export function ruleId(text: string): string {
  return crypto.createHash('sha1').update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 8);
}

const ATTR_RE = /<!--\s*([^>]*?)\s*-->\s*$/;

/** Parse the `- text <!-- strict topic:x -->` lines of a template rule body. */
export function parseTemplateRules(body: string, file: RuleFileKey, templateVersion: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of body.split('\n')) {
    const m = /^\s*-\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    let text = m[1];
    let layer: RuleLayer = 'template-strict';
    let topic: string | undefined;
    const a = ATTR_RE.exec(text);
    if (a) {
      text = text.replace(ATTR_RE, '').trim();
      for (const tok of a[1].split(/\s+/)) {
        if (tok === 'default') layer = 'template-default';
        else if (tok === 'strict') layer = 'template-strict';
        else if (tok.startsWith('topic:')) topic = tok.slice(6);
      }
    }
    rules.push({ id: ruleId(text), text, layer, topic, source: `template@${templateVersion}`, file });
  }
  return rules;
}

export interface Dropped {
  rule: Rule;
  reason: string;
  by: Rule;
}

/** Keep the highest-precedence rule per topic; rules without a topic always survive. */
export function resolveRules(rules: Rule[]): { kept: Rule[]; dropped: Dropped[] } {
  const byTopic = new Map<string, Rule[]>();
  const kept: Rule[] = [];
  const dropped: Dropped[] = [];
  const seenText = new Set<string>();
  for (const r of rules) {
    if (seenText.has(r.id)) {
      continue; // exact duplicate text
    }
    seenText.add(r.id);
    if (!r.topic) {
      kept.push(r);
      continue;
    }
    byTopic.set(r.topic, [...(byTopic.get(r.topic) ?? []), r]);
  }
  for (const [topic, list] of byTopic) {
    const sorted = [...list].sort((a, b) => PRECEDENCE[b.layer] - PRECEDENCE[a.layer]);
    const winner = sorted[0];
    // Rules of the same layer on one topic do not contradict each other; only lower layers lose.
    for (const r of sorted) {
      if (PRECEDENCE[r.layer] === PRECEDENCE[winner.layer]) kept.push(r);
      else dropped.push({ rule: r, by: winner, reason: `topic "${topic}": ${winner.layer} outranks ${r.layer}` });
    }
  }
  return { kept, dropped };
}

export function renderRuleLine(r: Rule): string {
  const attrs: string[] = [`source:${r.source}`];
  if (r.topic) attrs.push(`topic:${r.topic}`);
  if (r.confidence) attrs.push(`confidence:${r.confidence}`);
  if (r.evidence?.length) attrs.push(`evidence:${r.evidence.map((e) => e.replace(/ /g, '%20').replace(/-->/g, '--%3E')).join(',')}`);
  return `- ${r.text} <!-- ${attrs.join(' ')} -->`;
}

/** Order: strict template, then graph (highest confidence first), then defaults. Stable and deterministic. */
export function orderRules(rules: Rule[]): Rule[] {
  const conf = { high: 0, medium: 1, low: 2 } as const;
  const rank = (r: Rule) => (r.layer === 'developer' ? 0 : r.layer === 'template-strict' ? 1 : r.layer === 'graph' ? 2 : 3);
  return [...rules].sort((a, b) => rank(a) - rank(b) || (conf[a.confidence ?? 'high'] - conf[b.confidence ?? 'high']) || a.text.localeCompare(b.text));
}

export interface ParsedRuleLine {
  text: string;
  source?: string;
  topic?: string;
  confidence?: string;
  evidence: string[];
  line: number;
}

/** Read the rule lines back out of a generated file (for the auditor and for pruning). */
export function parseRenderedRules(content: string): ParsedRuleLine[] {
  const out: ParsedRuleLine[] = [];
  content.split('\n').forEach((raw, i) => {
    const m = /^\s*-\s+(.*\S)\s*$/.exec(raw);
    if (!m) return;
    let text = m[1];
    const attrs: Record<string, string> = {};
    const a = ATTR_RE.exec(text);
    if (a) {
      text = text.replace(ATTR_RE, '').trim();
      for (const tok of a[1].split(/\s+/)) {
        const idx = tok.indexOf(':');
        if (idx > 0) attrs[tok.slice(0, idx)] = tok.slice(idx + 1);
      }
    }
    out.push({
      text,
      source: attrs.source,
      topic: attrs.topic,
      confidence: attrs.confidence,
      evidence: attrs.evidence ? attrs.evidence.split(',').filter(Boolean).map((e) => e.replace(/%20/g, ' ').replace(/--%3E/g, '-->')) : [],
      line: i + 1
    });
  });
  return out;
}
