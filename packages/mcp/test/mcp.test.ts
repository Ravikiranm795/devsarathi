import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runCommand, createLogger } from '../../core/src';
import { tmpDir, rmrf, fixtureRepo } from '../../core/test/helpers';

const BIN = path.resolve(__dirname, '../../../bin/devsarathi-mcp.js');
const dirs: string[] = [];
const savedEnv = { ...process.env };

beforeAll(() => {
  process.env.DEVSARATHI_EMBEDDER = 'fake';
  process.env.DEVSARATHI_HOME = tmpDir('ds-home-');
  dirs.push(process.env.DEVSARATHI_HOME);
});
afterAll(() => {
  process.env = { ...savedEnv };
  while (dirs.length) rmrf(dirs.pop() as string);
});

describe('MCP adapter (MASTER 4.1)', () => {
  it('exposes the same commands as tools, runs them through the shared core, and hides internal ones', async () => {
    const repo = fixtureRepo('python-fastapi', { configure: false });
    dirs.push(repo);
    const init = await runCommand('init', { yes: true, persona: 'Asha', skipHooks: true }, { repoRoot: repo, log: createLogger(undefined), progress: () => undefined });
    expect(init.ok, init.message).toBe(true);

    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { ...process.env } as Record<string, string> });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['ds_status', 'ds_impact', 'ds_review', 'ds_enhance', 'ds_init', 'ds_graph_build', 'ds_rules_pending', 'ds_disable', 'ds_enable']));
      for (const hidden of ['ds_dashboard', 'ds_hook', 'ds_selftest']) expect(tools).not.toContain(hidden);

      const status = await client.callTool({ name: 'ds_status', arguments: { path: repo } });
      const statusText = (status.content as { text: string }[])[0].text;
      expect(JSON.parse(statusText).message).toMatch(/graph .* old @ [0-9a-f]{7} \(baseline\)/);

      const impact = await client.callTool({ name: 'ds_impact', arguments: { path: repo, symbol: 'get_user' } });
      const body = JSON.parse((impact.content as { text: string }[])[0].text);
      expect(body.ok).toBe(true);
      expect(body.message).toMatch(/Callers \(2\)/);

      const bad = await client.callTool({ name: 'ds_impact', arguments: { path: repo, symbol: 'does_not_exist' } });
      expect(bad.isError).toBe(true); // a failure is an error result, never a quiet success
    } finally {
      await client.close();
    }
  }, 240000);
});
