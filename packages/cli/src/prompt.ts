import * as readline from 'readline';
import type { AskFn } from '@devsarathi/core';

/** Terminal prompts. Used by `init` and other interactive commands (D-25). */
export function createTerminalAsk(): AskFn {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const q = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve));
  const ask: AskFn & { close(): void } = {
    async text(question, def) {
      const a = (await q(`${question}${def ? ` [${def}]` : ''}: `)).trim();
      return a || def || '';
    },
    async confirm(question, def = true) {
      const a = (await q(`${question} ${def ? '[Y/n]' : '[y/N]'}: `)).trim().toLowerCase();
      if (!a) return def;
      return a === 'y' || a === 'yes';
    },
    async choose(question, options, def) {
      const list = options.map((o, i) => `${i + 1}) ${o}${o === def ? ' (default)' : ''}`).join('  ');
      for (;;) {
        const a = (await q(`${question}\n  ${list}\n  choice: `)).trim();
        if (!a && def) return def;
        const n = Number(a);
        if (n >= 1 && n <= options.length) return options[n - 1];
        const hit = options.find((o) => o.toLowerCase() === a.toLowerCase());
        if (hit) return hit;
      }
    },
    async multi(question, options) {
      process.stderr.write(`${question}\n`);
      options.forEach((o, i) => process.stderr.write(`  ${i + 1}) [${o.checked ? 'x' : ' '}] ${o.label}\n`));
      const a = (await q('  numbers to toggle, comma separated (Enter keeps defaults): ')).trim();
      const chosen = new Set(options.filter((o) => o.checked).map((o) => o.value));
      if (a) {
        for (const tok of a.split(',')) {
          const n = Number(tok.trim());
          if (n >= 1 && n <= options.length) {
            const v = options[n - 1].value;
            if (chosen.has(v)) chosen.delete(v);
            else chosen.add(v);
          }
        }
      }
      return [...chosen];
    },
    close() {
      rl.close();
    }
  };
  return ask;
}
