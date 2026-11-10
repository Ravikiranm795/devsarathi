import * as fs from 'fs';
import * as path from 'path';
import { ensureDir } from './fsutil';
import { redact } from '../security/secretPatterns';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** JSON-lines file logger. Everything is redacted (I-8) and logging can never throw. */
export function createLogger(logDir: string | undefined, scope = 'core'): Logger {
  const file = logDir ? path.join(logDir, 'devsarathi.log') : undefined;
  const write = (level: LogLevel, msg: string, data?: unknown) => {
    if (!file) return;
    try {
      ensureDir(logDir as string);
      try {
        if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no log yet */
      }
      const line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, data });
      fs.appendFileSync(file, redact(line) + '\n');
    } catch {
      /* logging must never break a command or a hook */
    }
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d)
  };
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
