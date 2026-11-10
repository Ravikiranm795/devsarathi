import { registerCommand, CommandDef } from '../registry';
import { refreshVersionCache } from '../lib/version';
import { loadConfig, TOOL_VERSION } from '../lib/config';
import { isNewer } from './status';

const versionCheck: CommandDef = {
  name: 'version-check',
  description: 'Check npm for a newer DevSarathi (package metadata only; can be turned off with versionCheck: false)',
  args: [],
  async run(ctx) {
    const cfg = loadConfig(ctx.repoRoot);
    if (cfg && !cfg.versionCheck) return { ok: true, message: 'Version check is turned off in this repo.' };
    const c = await refreshVersionCache();
    if (c.error) return { ok: true, message: `Could not check for a new version (${c.error}). Nothing is wrong: this is only a notice.` };
    if (c.latest && isNewer(c.latest, TOOL_VERSION)) return { ok: true, message: `A newer version is available: ${c.latest} (you have ${TOOL_VERSION}). Update with: npm i -g @ravikiranm795/dev-sarathi@latest, then run: devsarathi migrate` };
    return { ok: true, message: `You have the latest version (${TOOL_VERSION}).` };
  }
};

registerCommand(versionCheck);
