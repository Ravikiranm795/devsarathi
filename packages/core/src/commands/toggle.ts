import { registerCommand, CommandDef } from '../registry';
import { updateConfig, loadConfig } from '../lib/config';

function make(name: 'disable' | 'enable'): CommandDef {
  const turnOff = name === 'disable';
  return {
    name,
    description: turnOff
      ? 'Kill switch: turn OFF all hooks and automatic behavior'
      : 'Turn ON all hooks and automatic behavior again',
    args: [],
    needsInit: true,
    async run(ctx) {
      const cfg = loadConfig(ctx.repoRoot);
      if (!cfg) return { ok: false, message: 'DevSarathi is not initialized in this repo.', exitCode: 1 };
      if (cfg.disabled === turnOff) {
        return { ok: true, message: `Already ${turnOff ? 'disabled' : 'enabled'}.` };
      }
      updateConfig(ctx.repoRoot, (c) => {
        c.disabled = turnOff;
      });
      return {
        ok: true,
        message: turnOff
          ? 'DevSarathi disabled: hooks and automatic behavior are off. Manual commands still work. Re-enable with: devsarathi enable'
          : 'DevSarathi enabled: hooks and automatic behavior are on.'
      };
    }
  };
}

registerCommand(make('disable'));
registerCommand(make('enable'));
