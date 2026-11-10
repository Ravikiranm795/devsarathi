/**
 * Known secret shapes. Used by the security scanner and by the logger's redaction (I-8):
 * secret VALUES are never stored; only file, line, type and a masked preview.
 */
export interface SecretPattern {
  type: string;
  re: RegExp;
  severity: 'critical' | 'high' | 'medium';
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { type: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: 'critical' },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, severity: 'critical' },
  { type: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, severity: 'critical' },
  { type: 'stripe-key', re: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/g, severity: 'critical' },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, severity: 'high' },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, severity: 'high' },
  { type: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, severity: 'critical' },
  { type: 'azure-storage-key', re: /AccountKey=[A-Za-z0-9+/=]{40,}/g, severity: 'critical' },
  { type: 'gcp-service-account', re: /"private_key_id"\s*:\s*"[0-9a-f]{32,}"/g, severity: 'critical' },
  {
    type: 'credential-assignment',
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{8,}["']/gi,
    severity: 'high'
  }
];

/** Files whose content must never be read into the graph (I-8, MASTER 7.2). */
export function isSecretFile(relPath: string): boolean {
  const base = relPath.split('/').pop() || relPath;
  if (/^\.env(\..*)?$/i.test(base)) return !/\.(example|sample|template)$/i.test(base);
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk)$/i.test(base)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) return true;
  if (/^(credentials|secrets?)(\..*)?\.(json|ya?ml|xml|properties|ini|toml)$/i.test(base)) return true;
  if (/^service[-_]?account.*\.json$/i.test(base)) return true;
  if (base === '.npmrc' || base === '.pypirc' || base === '.netrc') return true;
  return false;
}

export function maskSecret(value: string): string {
  if (value.length <= 6) return '***';
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}

/** Replace anything that looks like a secret with a masked form. */
export function redact(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (m) => `[redacted:${p.type}:${maskSecret(m).slice(0, 4)}]`);
  }
  return out;
}

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
