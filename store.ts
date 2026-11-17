// In-memory forge state: repositories, issues, pull requests, comments.
//
// Two counters give the forge its deterministic identity scheme:
//   - one global repository id sequence, and
//   - one global "content" id sequence shared by issues, pull requests and
//     comments, mirroring how a real forge hands out database ids.
// Each repository additionally owns a per-repo number sequence shared by its
// issues and pull requests. Failed creations never consume an id.
//
// A logical clock (fixed epoch + sequence) stamps commits and merges so
// server-generated state never depends on wall time. Every mutation of a
// repository's git data flows through touchRepo(), the single funnel that
// invalidates the per-repo git answer cache.

import type { GitObject, ObjectStore } from './gitobjects.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

export interface Label {
  name: string;
  color: string;
}

export interface CommentRec {
  /** Global content id. */
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  /** Global content id. */
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  /** Bumped on every mutation; validates the serialised-view cache. */
  rev: number;
}

export interface PullRec {
  number: number;
  /** Global content id. */
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** Tips captured when the pull request was opened. */
  headSha: string;
  baseSha: string;
  rev: number;
}

export interface Repo {
  id: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Shared per-repo issue/PR number sequence. */
  nextNumber: number;
  /** Cached git protocol answers, keyed per request; cleared by touchRepo. */
  gitCache: Map<string, Buffer>;
  /** Serialised single-issue views, validated by IssueRec.rev. */
  issueViewCache: Map<number, { rev: number; comments: number; text: string }>;
}

const CLOCK_EPOCH = 1735689600; // 2025-01-01T00:00:00Z

export class Forge {
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private contentSeq = 0;
  private clockSeq = 0;
  private isoCache = new Map<number, string>();
  requestSeq = 0;

  /** Next global repository id. */
  nextRepoId(): number {
    return ++this.repoSeq;
  }

  /** Next global content id (issues, pull requests and comments share it). */
  nextContentId(): number {
    return ++this.contentSeq;
  }

  /** Next logical timestamp (seconds since the epoch). */
  nextTimestamp(): number {
    return CLOCK_EPOCH + this.clockSeq++;
  }

  /** Memoised ISO-8601 rendering of a logical timestamp. */
  isoOf(timestamp: number): string {
    let iso = this.isoCache.get(timestamp);
    if (!iso) {
      iso = new Date(timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      this.isoCache.set(timestamp, iso);
    }
    return iso;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId(),
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: new Map<number, IssueRec>(),
      pulls: new Map<number, PullRec>(),
      nextNumber: 1,
      gitCache: new Map<string, Buffer>(),
      issueViewCache: new Map<number, { rev: number; comments: number; text: string }>(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  /** All repositories in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }
}

/**
 * The single mutation funnel for a repository's git data: any change to
 * refs or objects invalidates every cached protocol answer for the repo.
 */
export function touchRepo(repo: Repo): void {
  repo.gitCache.clear();
}

/** Author/committer identity the forge stamps on commits it creates. */
export function forgeIdentity(timestamp: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestamp} +0000`;
}
