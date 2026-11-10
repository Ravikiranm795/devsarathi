import * as path from 'path';
import { NPM_PACKAGE } from '@devsarathi/shared';
import { userHome } from './paths';
import { readJson, writeJson } from './fsutil';

/**
 * The one-line "new version available" notice (D-28). It asks the npm registry for package METADATA only (the latest
 * version number): no repo data, no identifiers. It can be turned off with `versionCheck: false` in the config, it is
 * cached for a day, and there is no auto-update.
 */
export interface VersionCache {
  latest?: string;
  checkedAt: string;
  error?: string;
}

const DAY = 24 * 60 * 60 * 1000;

export const versionCachePath = () => path.join(userHome(), 'version-check.json');

export function readVersionCache(): VersionCache | undefined {
  return readJson<VersionCache>(versionCachePath());
}

export function versionCheckDue(now = Date.now()): boolean {
  const c = readVersionCache();
  return !c || now - Date.parse(c.checkedAt) > DAY;
}

export async function fetchLatestVersion(timeoutMs = 5000): Promise<VersionCache> {
  const url = `https://registry.npmjs.org/${NPM_PACKAGE.replace('/', '%2f')}/latest`;
  const checkedAt = new Date().toISOString();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) return { checkedAt, error: `registry answered ${res.status}` };
    const body = (await res.json()) as { version?: string };
    return { checkedAt, latest: body.version };
  } catch (err) {
    return { checkedAt, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function refreshVersionCache(): Promise<VersionCache> {
  const c = await fetchLatestVersion();
  writeJson(versionCachePath(), c);
  return c;
}
