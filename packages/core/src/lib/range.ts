import { git } from './git';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbd53b8f';
const ZERO = /^0+$/;

export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** git feeds pre-push one line per ref: `<local ref> <local sha> <remote ref> <remote sha>`. */
export function parsePushRefs(stdin: string): PushRef[] {
  return stdin
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

/** The commits a push would add, as `A..B`. Undefined for a branch deletion. */
export async function pushRange(root: string, ref: PushRef, baselineRef?: string): Promise<string | undefined> {
  if (ZERO.test(ref.localSha)) return undefined;
  if (!ZERO.test(ref.remoteSha)) {
    const have = await git(['cat-file', '-e', `${ref.remoteSha}^{commit}`], root);
    if (have.ok) return `${ref.remoteSha}..${ref.localSha}`;
  }
  if (baselineRef) {
    const mb = await git(['merge-base', ref.localSha, baselineRef], root);
    if (mb.ok && mb.stdout.trim()) return `${mb.stdout.trim()}..${ref.localSha}`;
  }
  return `${EMPTY_TREE}..${ref.localSha}`;
}
