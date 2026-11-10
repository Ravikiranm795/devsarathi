'use strict';

/**
 * Secret handling for the graph (DevSarathi invariant I-8): secret VALUES never enter
 * graph.sqlite, the vector index, viewer snapshots or logs. Two layers:
 *   1. isSecretFile(): env/key/credential files are never read; only their path is recorded.
 *   2. redactSecrets(): anything shaped like a credential inside ordinary source is masked
 *      before it is stored as a chunk, signature or doc comment.
 * The pattern list mirrors packages/core/src/security/secretPatterns.ts (a parity test keeps them aligned).
 */
const SECRET_PATTERNS = [
  { type: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'stripe-key', re: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/g },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { type: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { type: 'azure-storage-key', re: /AccountKey=[A-Za-z0-9+/=]{40,}/g },
  { type: 'gcp-service-account', re: /"private_key_id"\s*:\s*"[0-9a-f]{32,}"/g },
  {
    type: 'credential-assignment',
    re: /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["'])[^"'\s]{8,}(["'])/gi,
    keepGroups: true
  }
];

function isSecretFile(relPath) {
  const base = String(relPath).split('/').pop() || '';
  if (/^\.env(\..*)?$/i.test(base)) return !/\.(example|sample|template)$/i.test(base);
  if (/\.env$/i.test(base)) return true; // foo.env
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk)$/i.test(base)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) return true;
  if (/^(credentials|secrets?)(\..*)?\.(json|ya?ml|xml|properties|ini|toml)$/i.test(base)) return true;
  if (/^service[-_]?account.*\.json$/i.test(base)) return true;
  if (base === '.npmrc' || base === '.pypirc' || base === '.netrc') return true;
  return false;
}

function redactSecrets(text) {
  if (!text) return text;
  let out = String(text);
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (...m) => (p.keepGroups ? `${m[1]}[redacted:${p.type}]${m[2]}` : `[redacted:${p.type}]`));
  }
  return out;
}

module.exports = { SECRET_PATTERNS, isSecretFile, redactSecrets };
