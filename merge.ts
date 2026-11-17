// Pull-request diffs and merges.
//
// Mergeability is a three-way question: compare the pull request's head
// tree and the *current* base tree against the base tree captured when the
// pull request was opened. A path conflicts only when both sides changed
// it since then and changed it differently — so two pull requests that
// touch the same file from the same base cannot both merge.
//
// A squash merge applies the head's changes onto the current base tree and
// records the result as a single-parent commit on the base branch.

import {
  commitTree,
  flattenTree,
  storeObject,
  storeTreeFromFlat,
} from './gitobjects.ts';
import { forgeIdentity, touchRepo, type PullRec, type Repo } from './store.ts';

export interface ChangedFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line difference: lines added and removed going a → b. */
function lineDiff(a: Buffer, b: Buffer): { additions: number; deletions: number } {
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  const counts = new Map<string, number>();
  for (const line of aLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of bLines) {
    const available = counts.get(line) ?? 0;
    if (available > 0) counts.set(line, available - 1);
    else additions++;
  }
  let deletions = 0;
  for (const count of counts.values()) deletions += count;
  return { additions, deletions };
}

type FlatTree = Map<string, { oid: string; mode: string }>;

function flatAt(repo: Repo, commitOid: string | undefined): FlatTree {
  if (!commitOid) return new Map();
  const tree = commitTree(repo.objects, commitOid);
  if (!tree) return new Map();
  return flattenTree(repo.objects, tree);
}

/** Files changed between two commits, as a REST-shaped list. */
export function changedFiles(repo: Repo, baseSha: string, headSha: string): ChangedFile[] {
  const base = flatAt(repo, baseSha);
  const head = flatAt(repo, headSha);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const files: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before && !after) {
      const deletions = splitLines(repo.objects.get(before.oid)?.data ?? Buffer.alloc(0)).length;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!before && after) {
      const additions = splitLines(repo.objects.get(after.oid)?.data ?? Buffer.alloc(0)).length;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before && after && before.oid !== after.oid) {
      const { additions, deletions } = lineDiff(
        repo.objects.get(before.oid)?.data ?? Buffer.alloc(0),
        repo.objects.get(after.oid)?.data ?? Buffer.alloc(0),
      );
      files.push({
        filename: path,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
  }
  return files;
}

/**
 * Three-way mergeability of a pull request against the current base tip.
 * Returns the current base tip alongside the verdict.
 */
export function assessMerge(
  repo: Repo,
  pull: PullRec,
): { mergeable: boolean; currentBaseTip: string | undefined } {
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!currentBaseTip) return { mergeable: false, currentBaseTip: undefined };
  const original = flatAt(repo, pull.baseSha);
  const current = flatAt(repo, currentBaseTip);
  const head = flatAt(repo, pull.headSha);
  const paths = new Set<string>([...original.keys(), ...current.keys(), ...head.keys()]);
  for (const path of paths) {
    const before = original.get(path)?.oid;
    const baseNow = current.get(path)?.oid;
    const headNow = head.get(path)?.oid;
    const headChanged = headNow !== before;
    const baseChanged = baseNow !== before;
    if (headChanged && baseChanged && headNow !== baseNow) {
      return { mergeable: false, currentBaseTip };
    }
  }
  return { mergeable: true, currentBaseTip };
}

/**
 * Perform the squash merge: apply the head's changes (relative to the
 * original base) onto the current base tree, commit the result on the base
 * branch with the base tip as sole parent, and mark the pull request
 * merged. Returns the merge commit oid, or undefined when not mergeable.
 */
export function squashMerge(
  forge: { nextTimestamp(): number; isoOf(ts: number): string },
  repo: Repo,
  pull: PullRec,
): string | undefined {
  const { mergeable, currentBaseTip } = assessMerge(repo, pull);
  if (!mergeable || !currentBaseTip) return undefined;
  const original = flatAt(repo, pull.baseSha);
  const merged = flatAt(repo, currentBaseTip);
  const head = flatAt(repo, pull.headSha);
  const paths = new Set<string>([...original.keys(), ...head.keys()]);
  for (const path of paths) {
    const before = original.get(path)?.oid;
    const headNow = head.get(path);
    if ((headNow?.oid ?? undefined) === before) continue; // head did not touch it
    if (headNow) merged.set(path, headNow);
    else merged.delete(path);
  }
  const treeOid = storeTreeFromFlat(repo.objects, merged);
  const timestamp = forge.nextTimestamp();
  const identity = forgeIdentity(timestamp);
  const message = pull.body ? `${pull.title}\n\n${pull.body}` : pull.title;
  const commitData = Buffer.from(
    `tree ${treeOid}\nparent ${currentBaseTip}\nauthor ${identity}\ncommitter ${identity}\n\n${message}\n`,
    'utf8',
  );
  const commitOid = storeObject(repo.objects, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  touchRepo(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.isoOf(timestamp);
  pull.mergeCommitSha = commitOid;
  pull.rev++;
  return commitOid;
}
