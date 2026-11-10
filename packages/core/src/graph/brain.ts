import * as path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Drishti (brain/) is plain CommonJS JavaScript. This is the ONLY place core reaches into it, so the brain
 * can evolve independently behind `DrishtiClient` (MASTER 7.1). The path is relative to this file, which
 * works in a checkout (packages/core/{src,dist}/graph -> brain/src) and in the published package alike.
 */
const BRAIN_SRC = path.resolve(__dirname, '..', '..', '..', '..', 'brain', 'src');

function load<T = any>(name: string): T {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(BRAIN_SRC, name)) as T;
}

export const brain = {
  buildBrain: () => load('buildBrain').buildBrain as (root: string, opts: Record<string, unknown>) => Promise<any>,
  GraphStore: () => load('graphStore').GraphStore as new (dir: string) => any,
  VectorIndex: () => load('vectorIndex').VectorIndex as new (dir: string) => any,
  parseFile: () => load('parser').parseFile as (abs: string, ext: string, source?: string) => any,
  query: () => load('query') as any,
  context: () => load('context') as any,
  config: () => load('config') as any,
  secrets: () => load('secrets') as { redactSecrets(t: string): string; isSecretFile(p: string): boolean },
  embedder: () => load('embedder') as { prefetchModel(): Promise<unknown>; MODEL_ID: string },
  frameworkImpact: (): any | undefined => {
    try {
      return load('frameworkImpact');
    } catch {
      return undefined;
    }
  }
};
