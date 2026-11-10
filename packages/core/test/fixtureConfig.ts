import { ConfigSchema } from '@devsarathi/shared';
import { saveConfig } from '../src';

export { ConfigSchema };

export function saveConfigFor(root: string, baselineBranch: string, over: Record<string, unknown> = {}): void {
  saveConfig(
    root,
    ConfigSchema.parse({ toolVersion: '0.1.0', baselineBranch, persona: { name: 'Asha', title: 'Developer' }, ...over })
  );
}
