import * as path from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { listCommands, runCommand, CommandDef, repoPaths, createLogger, repoRoot, TOOL_VERSION } from '@devsarathi/core';

function shapeFor(def: CommandDef): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {
    path: z.string().optional().describe('Repo root (default: current directory)')
  };
  for (const a of def.args) {
    let t: z.ZodTypeAny = a.type === 'number' ? z.number() : a.type === 'boolean' ? z.boolean() : z.string();
    t = t.describe(a.description);
    shape[a.name] = a.required ? t : t.optional();
  }
  return shape;
}

export function toolName(command: string): string {
  return `ds_${command.replace(/[^a-z0-9]+/gi, '_')}`;
}

/** The MCP server is a thin adapter: every tool just runs the same command the CLI runs. */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'devsarathi', version: TOOL_VERSION });
  const NOT_FOR_MCP = new Set(['dashboard', 'hook', 'selftest']);
  for (const def of listCommands().filter((c) => !NOT_FOR_MCP.has(c.name))) {
    server.registerTool(
      toolName(def.name),
      { title: `devsarathi ${def.name}`, description: def.description, inputSchema: shapeFor(def) },
      async (input: Record<string, unknown>) => {
        const { path: p, ...rest } = input;
        const start = path.resolve((p as string | undefined) || process.cwd());
        let root = start;
        try {
          root = await repoRoot(start);
        } catch {
          /* not a git repo */
        }
        try {
          const res = await runCommand(def.name, rest, {
            repoRoot: root,
            log: createLogger(repoPaths(root).logs, `mcp:${def.name}`),
            progress: () => undefined
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }], isError: !res.ok };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `devsarathi ${def.name} failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      }
    );
  }
  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
