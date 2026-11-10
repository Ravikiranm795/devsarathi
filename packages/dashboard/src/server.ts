import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import { defaultRegistryPath, listRepos, loadRepoEntries, readRepoSummary } from './reader';

export interface DashboardOptions {
  port?: number;
  /** Only 127.0.0.1 is accepted. The option exists so a mistaken config fails loudly instead of exposing the data. */
  host?: string;
  token?: string;
  registryPath?: string;
  focusRepo?: string;
}

export interface DashboardHandle {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const LOOPBACK = '127.0.0.1';
// Resolves from both src/ and dist/: the published package ships packages/dashboard/web next to them.
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const TOKEN_PLACEHOLDER = '{{TOKEN}}';

/**
 * No external origins at all (offline, no CDN, no fonts). frame-ancestors lets the same bundle sit inside the VS Code
 * webview iframe; X-Frame-Options is deliberately not set because it cannot express that.
 */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' vscode-webview:";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const digest = (s: string) => crypto.createHash('sha256').update(s).digest();
/** Hashing first makes both buffers the same length, so timingSafeEqual never throws and length does not leak. */
const tokenMatches = (given: string, expected: string) => crypto.timingSafeEqual(digest(given), digest(expected));

function baseHeaders(type: string): http.OutgoingHttpHeaders {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer'
  };
}

function send(req: http.IncomingMessage, res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: http.OutgoingHttpHeaders = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...baseHeaders(type), 'Content-Length': buf.length, ...extra });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

const sendJson = (req: http.IncomingMessage, res: http.ServerResponse, status: number, value: unknown, extra?: http.OutgoingHttpHeaders) =>
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(value), extra);

const fail = (req: http.IncomingMessage, res: http.ServerResponse, status: number, message: string, extra?: http.OutgoingHttpHeaders) =>
  sendJson(req, res, status, { error: message }, extra);

/** Map a URL path to a file under web/. Returns null for anything that could leave it (traversal, dotfiles, odd bytes). */
function resolveStatic(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (rel.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) return null;
  const abs = path.resolve(WEB_ROOT, rel);
  if (abs !== WEB_ROOT && !abs.startsWith(WEB_ROOT + path.sep)) return null;
  return abs;
}

export async function startDashboard(opts: DashboardOptions = {}): Promise<DashboardHandle> {
  if (opts.host !== undefined && opts.host !== LOOPBACK) {
    throw new Error(`The dashboard only binds to ${LOOPBACK}; refusing host "${opts.host}".`);
  }
  const token = opts.token ?? crypto.randomBytes(16).toString('hex');
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  let port = 0;

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // DNS-rebinding defence: a hostile page can point its own domain at 127.0.0.1, but cannot forge this header.
    const host = String(req.headers.host ?? '').toLowerCase();
    if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) return fail(req, res, 403, 'Forbidden host');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${LOOPBACK}:${port}` && origin !== `http://localhost:${port}`) return fail(req, res, 403, 'Forbidden origin');
    // Read-only by design: the dashboard never runs a command (MASTER 18).
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(req, res, 405, 'Read-only dashboard', { Allow: 'GET, HEAD' });

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${LOOPBACK}:${port}`);
    } catch {
      return fail(req, res, 400, 'Bad request');
    }
    if (url.pathname === '/healthz') return send(req, res, 200, 'text/plain; charset=utf-8', 'ok');

    const header = req.headers['x-ds-token'];
    const given = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token') ?? '';
    if (!given || !tokenMatches(given, token)) return fail(req, res, 401, 'Missing or invalid token. Open the link printed by `devsarathi dashboard`.');

    try {
      if (url.pathname === '/api/repos') return sendJson(req, res, 200, { repos: listRepos(registryPath, opts.focusRepo) });
      const m = /^\/api\/repos\/([0-9a-f]{12})$/.exec(url.pathname);
      if (m) {
        // The id is looked up in the registry: a client can never name a path.
        const entry = loadRepoEntries(registryPath, opts.focusRepo).find((e) => e.id === m[1]);
        if (!entry) return fail(req, res, 404, 'Unknown repo');
        return sendJson(req, res, 200, readRepoSummary(entry.path, { id: entry.id, name: entry.name }));
      }
      if (url.pathname.startsWith('/api/')) return fail(req, res, 404, 'Not found');

      const file = resolveStatic(url.pathname);
      const type = file ? MIME[path.extname(file).toLowerCase()] : undefined;
      if (!file || !type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(req, res, 404, 'Not found');
      let body: string | Buffer = fs.readFileSync(file);
      // Script and stylesheet tags cannot send headers, so the page's own asset URLs carry the token.
      if (path.basename(file) === 'index.html') body = body.toString('utf8').split(TOKEN_PLACEHOLDER).join(token);
      return send(req, res, 200, type, body);
    } catch {
      // Fail closed with a generic message: no paths or stack traces to the browser.
      return fail(req, res, 500, 'Internal error');
    }
  };

  const server = http.createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, LOOPBACK, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://${LOOPBACK}:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}
