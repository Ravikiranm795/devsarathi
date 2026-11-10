import * as path from 'path';
import { Finding } from '@devsarathi/shared';
import { ChangeSet } from '../lib/diff';
import { SECRET_PATTERNS, maskSecret, shannonEntropy } from './secretPatterns';
import { SecurityPattern } from '../generate/templates';

export interface ScanOptions {
  /** Stack-specific risky patterns from the profiles' security.json. */
  stackPatterns: SecurityPattern[];
  /** Paths git reports as already tracked: a tracked env file is a leak, not just a change. */
  trackedSecretFiles?: Set<string>;
}

const MANIFEST_RE = /(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|requirements[^/]*\.txt|pyproject\.toml|Pipfile|composer\.json|go\.mod|Cargo\.toml)$/;
const NAME_HINT = /(secret|token|api[_-]?key|passwd|password|pwd|credential|auth[_-]?key|private[_-]?key)[\w-]*["']?\s*[:=]\s*["']([A-Za-z0-9+/=_-]{20,})["']/i;
const MAX_FINDINGS = 200;

let seq = 0;
const nextId = () => `SEC-${String(++seq).padStart(3, '0')}`;

/**
 * Deterministic security scan of the ADDED lines of a change (MASTER 10.3, 15). Values are never stored or
 * printed: findings carry file, line, type and a masked preview only (I-8). Secret files (.env, keys,
 * credential configs) are never read: touching one is itself the finding.
 */
export function scanChanges(changes: ChangeSet, opts: ScanOptions): Finding[] {
  seq = 0;
  const out: Finding[] = [];
  const push = (f: Omit<Finding, 'id' | 'agent'>) => {
    if (out.length < MAX_FINDINGS) out.push({ id: nextId(), agent: 'security', ...f });
  };

  const patterns = opts.stackPatterns.map((p) => {
    try {
      return { p, re: new RegExp(p.re) };
    } catch {
      return undefined; // a broken profile pattern must not break the review
    }
  });

  for (const f of changes.files) {
    if (f.secret) {
      const tracked = opts.trackedSecretFiles?.has(f.path) || f.status === 'added';
      push({
        severity: tracked ? 'high' : 'medium',
        title: f.status === 'added' ? 'Secret or environment file added' : 'Secret or environment file changed',
        file: f.path,
        detail: 'Contents were not read. Make sure this file is git-ignored and was never pushed; rotate anything that was.',
        suggestion: 'Keep secrets out of the repository: use your secret manager or an untracked local file.',
        redFlag: true
      });
      continue;
    }
    if (f.binary) continue;
    const ext = path.extname(f.path);

    for (const l of f.added) {
      if (l.text.length > 2000) continue; // minified or generated: not worth scanning line by line
      let matched = false;
      for (const sp of SECRET_PATTERNS) {
        sp.re.lastIndex = 0;
        const m = sp.re.exec(l.text);
        if (m) {
          matched = true;
          push({
            severity: sp.severity,
            title: `Possible ${sp.type.replace(/-/g, ' ')}`,
            file: f.path,
            line: l.line,
            detail: `Matches the ${sp.type} pattern. Masked preview: ${maskSecret(m[0])}`,
            suggestion: 'Remove it from the code, load it from the environment or a secret manager, and rotate it if it was ever pushed.',
            redFlag: true
          });
          break;
        }
      }
      if (!matched) {
        const m = NAME_HINT.exec(l.text);
        if (m && shannonEntropy(m[2]) >= 3.5) {
          push({
            severity: 'medium',
            title: 'High-entropy string assigned to a credential-like name',
            file: f.path,
            line: l.line,
            detail: `Masked preview: ${maskSecret(m[2])}`,
            suggestion: 'If this is a real credential, move it out of the code.',
            redFlag: true
          });
        }
      }
      for (const sp of patterns) {
        if (!sp || !sp.p.ext.includes(ext)) continue;
        if (sp.re.test(l.text)) {
          push({ severity: sp.p.severity, title: sp.p.message, file: f.path, line: l.line, detail: `Pattern ${sp.p.id}`, suggestion: undefined, redFlag: false });
        }
      }
    }

    if (MANIFEST_RE.test(f.path) && f.added.length > 0) {
      const names = f.added
        .map((a) => a.text.trim())
        .filter((t) => t && !t.startsWith('//') && !/^[{}\[\],]*$/.test(t))
        .slice(0, 5);
      push({
        severity: 'low',
        title: 'Dependency change',
        file: f.path,
        line: f.added[0].line,
        detail: `${f.added.length} added line(s), for example: ${names.join(' | ').slice(0, 300)}`,
        suggestion: 'Check each new or upgraded package: maintained, licensed, and needed.',
        redFlag: false
      });
    }
  }
  return out;
}
