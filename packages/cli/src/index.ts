import * as path from 'path';
import { Command } from 'commander';
import { MIN_NODE_MAJOR, CLI_NAME } from '@devsarathi/shared';
import {
  listCommands,
  runCommand,
  CommandDef,
  CommandContext,
  TOOL_VERSION,
  repoRoot,
  repoPaths,
  createLogger
} from '@devsarathi/core';
import { createTerminalAsk } from './prompt';

function checkNode(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    console.error(`${CLI_NAME} needs Node ${MIN_NODE_MAJOR} or newer (this is ${process.versions.node}). Install a current LTS from https://nodejs.org and try again.`);
    process.exit(1);
  }
}

async function resolveRoot(explicit?: string): Promise<string> {
  const start = path.resolve(explicit || process.cwd());
  try {
    return await repoRoot(start);
  } catch {
    return start; // not a git repo: commands that need one will say so
  }
}

function addCommand(program: Command, groups: Map<string, Command>, def: CommandDef): void {
  const words = def.name.split(' ');
  let parent = program;
  for (let i = 0; i < words.length - 1; i++) {
    const key = words.slice(0, i + 1).join(' ');
    let g = groups.get(key);
    if (!g) {
      g = parent.command(words[i]).description(`${words[i]} commands`);
      groups.set(key, g);
    }
    parent = g;
  }
  const leaf = parent.command(words[words.length - 1]).description(def.description);
  for (const a of def.args) {
    if (a.positional) {
      leaf.argument(a.required ? `<${a.name}>` : `[${a.name}]`, a.description);
    } else {
      const flag = `${a.alias ? `-${a.alias}, ` : ''}--${a.name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      leaf.option(a.type === 'boolean' ? flag : `${flag} <${a.type === 'number' ? 'n' : 'value'}>`, a.description);
    }
  }
  leaf.option('-C, --path <dir>', 'repo root (default: current git repo)');
  leaf.option('--json', 'print the result as JSON');
  leaf.action(async (...actionArgs: unknown[]) => {
    const cmd = actionArgs[actionArgs.length - 1] as Command;
    const opts = cmd.opts() as Record<string, unknown>;
    const positionals = def.args.filter((a) => a.positional);
    const raw: Record<string, unknown> = { ...opts };
    positionals.forEach((a, i) => {
      raw[a.name] = actionArgs[i];
    });
    const root = await resolveRoot(opts.path as string | undefined);
    const log = createLogger(repoPaths(root).logs, def.name);
    const ask = process.stdin.isTTY ? createTerminalAsk() : undefined;
    const ctx: CommandContext = {
      repoRoot: root,
      log,
      ask,
      progress: (stage, message) => process.stderr.write(`[${stage}]${message ? ' ' + message : ''}\n`)
    };
    try {
      const res = await runCommand(def.name, raw, ctx);
      if (opts.json) console.log(JSON.stringify(res, null, 2));
      else if (res.message) console.log(res.message);
      process.exitCode = res.ok ? 0 : (res.exitCode ?? 1);
    } catch (err) {
      console.error(`${CLI_NAME} ${def.name}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    } finally {
      (ask as unknown as { close?: () => void } | undefined)?.close?.();
    }
  });
}

export async function main(argv: string[]): Promise<void> {
  checkNode();
  const program = new Command();
  program.name(CLI_NAME).description('DevSarathi: steers the developer and Claude with the right context').version(TOOL_VERSION);
  const groups = new Map<string, Command>();
  for (const def of listCommands()) addCommand(program, groups, def);
  await program.parseAsync(argv);
}
