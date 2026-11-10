import type { Logger } from './lib/logger';
import { recordEvent } from './lib/events';

export type ArgType = 'string' | 'number' | 'boolean';

export interface ArgSpec {
  name: string;
  type: ArgType;
  description: string;
  required?: boolean;
  /** Takes the next bare CLI word (e.g. `enhance "<request>"`). */
  positional?: boolean;
  /** Single-letter CLI alias, e.g. `f` for `--full`. */
  alias?: string;
}

export interface CommandContext {
  repoRoot: string;
  log: Logger;
  /** Staged progress (Scanning -> Building graph -> ...). Adapters decide how to show it. */
  progress(stage: string, message?: string): void;
  /** Interactive prompt hook, supplied by the CLI/extension. Absent in MCP and hooks. */
  ask?: AskFn;
}

export interface AskFn {
  text(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  choose<T extends string>(question: string, options: T[], defaultValue?: T): Promise<T>;
  multi(question: string, options: { value: string; label: string; checked: boolean }[]): Promise<string[]>;
}

export interface CommandResult {
  ok: boolean;
  /** Human-readable summary lines. */
  message: string;
  data?: unknown;
  /** Process exit code for CLI; hooks always override to 0. */
  exitCode?: number;
}

export interface CommandDef {
  name: string;
  description: string;
  args: ArgSpec[];
  /** True when the command needs an initialized repo (config.json present). */
  needsInit?: boolean;
  run(ctx: CommandContext, args: Record<string, unknown>): Promise<CommandResult>;
}

const commands = new Map<string, CommandDef>();

export function registerCommand(def: CommandDef): void {
  if (commands.has(def.name)) throw new Error(`command already registered: ${def.name}`);
  commands.set(def.name, def);
}

export function getCommand(name: string): CommandDef | undefined {
  return commands.get(name);
}

export function listCommands(): CommandDef[] {
  return [...commands.values()];
}

/** Coerce and validate raw args (strings from a CLI, JSON from MCP) against a command's specs. */
export function normalizeArgs(def: CommandDef, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of def.args) {
    let v = raw[spec.name];
    if (v === undefined || v === null || v === '') {
      if (spec.required) throw new Error(`missing required argument: ${spec.name}`);
      if (spec.type === 'boolean') out[spec.name] = false;
      continue;
    }
    if (spec.type === 'number') {
      const n = Number(v);
      if (Number.isNaN(n)) throw new Error(`argument ${spec.name} must be a number`);
      v = n;
    } else if (spec.type === 'boolean') {
      v = v === true || v === 'true' || v === '1';
    } else {
      v = String(v);
    }
    out[spec.name] = v;
  }
  return out;
}

export async function runCommand(name: string, raw: Record<string, unknown>, ctx: CommandContext): Promise<CommandResult> {
  const def = getCommand(name);
  if (!def) return { ok: false, message: `unknown command: ${name}`, exitCode: 2 };
  const args = normalizeArgs(def, raw);
  // Tool usage by command (MASTER 16): the name only, never the arguments. Hooks are automatic, not usage.
  if (def.name !== 'hook') recordEvent(ctx.repoRoot, { type: 'command', data: { name: def.name } });
  return def.run(ctx, args);
}
