// REST surface under /api/v3: repositories, contents, git refs, branches,
// commits, labels, issues, comments and pull requests.
//
// Conventions mirrored from the real API: JSON error bodies always carry a
// `message` string; a repository addressed under a foreign owner is a 404,
// never a 403; duplicate repository names fail 422 with "already exists";
// issue and pull-request numbers come from one shared per-repo sequence.

import {
  commitMessage,
  flattenTree,
  parseCommitHead,
  parseTree,
  storeObject,
  storeTreeFromFlat,
} from './gitobjects.ts';
import { assessMerge, changedFiles, squashMerge } from './merge.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  forgeIdentity,
  touchRepo,
  type Forge,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';

export interface RestReply {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): RestReply {
  return { status, body: JSON.stringify(value), headers };
}

function fail(status: number, message: string): RestReply {
  return json(status, { message });
}

const notFound = (): RestReply => fail(404, 'Not Found');

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  host: string;
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: VIEWER_LOGIN, id: VIEWER_ID },
  };
}

function issueView(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({
      name,
      color: repo.labels.get(name)?.color ?? 'ededed',
    })),
    user: { login: VIEWER_LOGIN },
    comments: issue.comments.length,
  };
}

function pullView(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN },
  };
}

function parseAuthorLine(data: Buffer, kind: 'author' | 'committer'): { name: string; email: string; date: string } {
  const text = data.toString('latin1');
  const line = text.split('\n').find((l) => l.startsWith(`${kind} `)) ?? '';
  const match = /^(?:author|committer) (.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: '', email: '', date: '' };
  return {
    name: match[1],
    email: match[2],
    date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function commitView(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const data = obj?.data ?? Buffer.alloc(0);
  return {
    sha: oid,
    commit: {
      message: commitMessage(data),
      author: parseAuthorLine(data, 'author'),
      committer: parseAuthorLine(data, 'committer'),
    },
  };
}

/** Resolve a ref parameter (branch name or commit oid) to a commit oid. */
function resolveCommit(repo: Repo, ref: string | undefined): string | undefined {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const byBranch = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (byBranch) return byBranch;
  const obj = repo.objects.get(ref);
  return obj?.type === 'commit' ? ref : undefined;
}

function rootTreeOf(repo: Repo, commitOid: string): string | undefined {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return undefined;
  return parseCommitHead(obj.data).tree;
}

/** Walk a tree to the entry at `path` ('' addresses the root directory). */
function entryAt(
  repo: Repo,
  rootTree: string,
  path: string,
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; tree: string } | undefined {
  if (path === '') return { kind: 'dir', tree: rootTree };
  const parts = path.split('/');
  let tree = rootTree;
  for (let i = 0; i < parts.length; i++) {
    const obj = repo.objects.get(tree);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    const child = repo.objects.get(entry.oid);
    if (i === parts.length - 1) {
      return child?.type === 'tree'
        ? { kind: 'dir', tree: entry.oid }
        : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (child?.type !== 'tree') return undefined;
    tree = entry.oid;
  }
  return undefined;
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => {
    const child = repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path: prefix + entry.name,
      sha: entry.oid,
      type: child?.type === 'tree' ? 'dir' : 'file',
    };
  });
}

/** Create a commit on `branch` from a flattened tree; returns its oid. */
function commitFlat(
  forge: Forge,
  repo: Repo,
  branch: string,
  flat: Map<string, { oid: string; mode: string }>,
  parent: string | undefined,
  message: string,
): string {
  const treeOid = storeTreeFromFlat(repo.objects, flat);
  const timestamp = forge.nextTimestamp();
  const identity = forgeIdentity(timestamp);
  const parentLine = parent ? `parent ${parent}\n` : '';
  const data = Buffer.from(
    `tree ${treeOid}\n${parentLine}author ${identity}\ncommitter ${identity}\n\n${message}\n`,
    'utf8',
  );
  const oid = storeObject(repo.objects, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  touchRepo(repo);
  return oid;
}

export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const { method, segments, query, body } = req;
  const base = `http://${req.host}`;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return json(
      200,
      {
        current_user_url: `${base}/api/v3/user`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
        repository_url: `${base}/api/v3/repos/${VIEWER_LOGIN}/{repo}`,
      },
      { 'X-OAuth-Scopes': 'repo, user' },
    );
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return json(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
    });
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'POST') return createRepo(forge, body);
    if (method === 'GET') return listUserRepos(forge, query, base);
    return notFound();
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    if (owner !== VIEWER_LOGIN) return notFound();
    const repo = forge.getRepo(name);
    if (!repo) return notFound();
    return handleRepo(forge, repo, method, segments.slice(3), query, body);
  }
  return notFound();
}

function createRepo(forge: Forge, body: Record<string, unknown>): RestReply {
  const name = body.name;
  if (typeof name !== 'string' || name.length === 0) {
    return fail(422, 'Validation Failed: name is required');
  }
  if (forge.getRepo(name)) {
    return fail(422, 'Validation Failed: name already exists on this account');
  }
  const repo = forge.createRepo(
    name,
    body.private === true,
    typeof body.description === 'string' ? body.description : '',
  );
  return json(201, repoView(repo));
}

function listUserRepos(forge: Forge, query: URLSearchParams, base: string): RestReply {
  const all = forge.listRepos();
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  if (page < lastPage) {
    const url = (p: number) => `<${base}/api/v3/user/repos?per_page=${perPage}&page=${p}>`;
    headers.Link = `${url(page + 1)}; rel="next", ${url(lastPage)}; rel="last"`;
  }
  return json(200, slice.map(repoView), headers);
}

function handleRepo(
  forge: Forge,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): RestReply {
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoView(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return json(200, repoView(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return { status: 204, body: '', headers: {} };
    }
    return notFound();
  }
  const [head, ...tail] = rest;
  switch (head) {
    case 'contents':
      return handleContents(forge, repo, method, tail.join('/'), query, body);
    case 'git':
      return handleGitRefs(repo, method, tail, body);
    case 'branches':
      return handleBranches(repo, method, tail);
    case 'commits':
      if (method !== 'GET' || tail.length > 0) return notFound();
      return listCommits(repo, query);
    case 'labels':
      return handleLabels(repo, method, tail, body);
    case 'issues':
      return handleIssues(forge, repo, method, tail, query, body);
    case 'pulls':
      return handlePulls(forge, repo, method, tail, query, body);
    default:
      return notFound();
  }
}

// --- contents ---------------------------------------------------------------

function handleContents(
  forge: Forge,
  repo: Repo,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
): RestReply {
  const cleanPath = path.replace(/^\/+|\/+$/g, '');
  if (method === 'GET') {
    const commit = resolveCommit(repo, query.get('ref') ?? undefined);
    if (!commit) return notFound();
    const root = rootTreeOf(repo, commit);
    if (!root) return notFound();
    const entry = entryAt(repo, root, cleanPath);
    if (!entry) return notFound();
    if (entry.kind === 'dir') {
      return json(200, dirListing(repo, entry.tree, cleanPath === '' ? '' : `${cleanPath}/`));
    }
    const blob = repo.objects.get(entry.oid);
    if (!blob) return notFound();
    const name = cleanPath.split('/').pop() ?? cleanPath;
    return json(200, {
      type: 'file',
      name,
      path: cleanPath,
      sha: entry.oid,
      size: blob.data.length,
      encoding: 'base64',
      content: blob.data.toString('base64'),
    });
  }
  if (method === 'PUT') {
    const content = typeof body.content === 'string' ? body.content : '';
    const message = typeof body.message === 'string' ? body.message : `Update ${cleanPath}`;
    const branch =
      typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) {
      // A write to a missing branch starts from the default branch tip (or
      // from nothing on an unborn repository, where this is the first commit).
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const flat = tip ? flattenTree(repo.objects, rootTreeOf(repo, tip) as string) : new Map();
    const existing = flat.get(cleanPath);
    if (existing) {
      if (typeof body.sha !== 'string') return fail(422, 'Validation Failed: sha is required');
      if (body.sha !== existing.oid) return fail(409, 'Conflict: the sha does not match');
    }
    const blobOid = storeObject(repo.objects, 'blob', Buffer.from(content, 'base64'));
    flat.set(cleanPath, { oid: blobOid, mode: '100644' });
    const commitOid = commitFlat(forge, repo, branch, flat, tip, message);
    const blob = repo.objects.get(blobOid);
    return json(existing ? 200 : 201, {
      content: {
        name: cleanPath.split('/').pop() ?? cleanPath,
        path: cleanPath,
        sha: blobOid,
        size: blob?.data.length ?? 0,
        encoding: 'base64',
      },
      commit: { sha: commitOid },
    });
  }
  if (method === 'DELETE') {
    const message = typeof body.message === 'string' ? body.message : `Delete ${cleanPath}`;
    const branch =
      typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return notFound();
    const flat = flattenTree(repo.objects, rootTreeOf(repo, tip) as string);
    const existing = flat.get(cleanPath);
    if (!existing) return notFound();
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      return fail(409, 'Conflict: the sha does not match');
    }
    flat.delete(cleanPath);
    const commitOid = commitFlat(forge, repo, branch, flat, tip, message);
    return json(200, { content: null, commit: { sha: commitOid } });
  }
  return notFound();
}

// --- git refs & branches ------------------------------------------------------

function handleGitRefs(
  repo: Repo,
  method: string,
  tail: string[],
  body: Record<string, unknown>,
): RestReply {
  if (tail.length === 1 && tail[0] === 'refs' && method === 'POST') {
    const ref = body.ref;
    const sha = body.sha;
    if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
      return fail(422, 'Validation Failed: ref is invalid');
    }
    if (typeof sha !== 'string' || repo.objects.get(sha)?.type !== 'commit') {
      return fail(422, 'Validation Failed: object does not exist');
    }
    repo.refs.set(ref, sha);
    touchRepo(repo);
    return json(201, { ref, object: { sha, type: 'commit' } });
  }
  if (tail[0] === 'refs' && method === 'GET') {
    const ref = tail.slice(1).join('/');
    const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    const sha = repo.refs.get(full);
    if (!sha) return notFound();
    return json(200, { ref: full, object: { sha, type: 'commit' } });
  }
  return notFound();
}

function handleBranches(repo: Repo, method: string, tail: string[]): RestReply {
  if (method !== 'GET') return notFound();
  if (tail.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return json(200, branches);
  }
  const name = tail.join('/');
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (!sha) return notFound();
  return json(200, { name, commit: { sha } });
}

function listCommits(repo: Repo, query: URLSearchParams): RestReply {
  const start = resolveCommit(repo, query.get('sha') ?? undefined);
  if (!start) return json(200, []);
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0 && out.length < 1000) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(commitView(repo, oid));
    queue.push(...parseCommitHead(obj.data).parents);
  }
  return json(200, out);
}

// --- labels -----------------------------------------------------------------

function handleLabels(
  repo: Repo,
  method: string,
  tail: string[],
  body: Record<string, unknown>,
): RestReply {
  if (tail.length > 0) return notFound();
  if (method === 'GET') {
    return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
  }
  if (method === 'POST') {
    const name = body.name;
    if (typeof name !== 'string' || !name) return fail(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return fail(422, 'Validation Failed: label already exists');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    repo.labels.set(name, { name, color });
    return json(201, { name, color });
  }
  return notFound();
}

// --- issues -----------------------------------------------------------------

function handleIssues(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): RestReply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = body.title;
      if (typeof title !== 'string' || !title) {
        return fail(422, 'Validation Failed: title is required');
      }
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const raw of body.labels) {
          const name = typeof raw === 'string' ? raw : (raw as { name?: string })?.name;
          if (typeof name !== 'string') continue;
          if (!repo.labels.has(name)) {
            return fail(422, `Validation Failed: label "${name}" does not exist`);
          }
          labelNames.push(name);
        }
      }
      const issue: IssueRec = {
        number: repo.nextNumber++,
        id: forge.nextContentId(),
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: labelNames,
        comments: [],
        rev: 0,
      };
      repo.issues.set(issue.number, issue);
      return json(201, issueView(repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      const perPage = Math.max(1, Number(query.get('per_page') ?? '30') || 30);
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') {
        list = list.filter((issue) => issue.state === state);
      }
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return json(200, slice.map((issue) => issueView(repo, issue)));
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (tail.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') {
      // Serialised-view cache: the exact bytes are memoised per issue and
      // revalidated against the issue's revision counter and comment count.
      const cached = repo.issueViewCache.get(issue.number);
      if (cached && cached.rev === issue.rev && cached.comments === issue.comments.length) {
        return { status: 200, body: cached.text, headers: {} };
      }
      const text = JSON.stringify(issueView(repo, issue));
      repo.issueViewCache.set(issue.number, {
        rev: issue.rev,
        comments: issue.comments.length,
        text,
      });
      return { status: 200, body: text, headers: {} };
    }
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.rev++;
      return json(200, issueView(repo, issue));
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'GET') {
      return json(
        200,
        issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN } })),
      );
    }
    if (method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      const comment = { id: forge.nextContentId(), body: text };
      issue.comments.push(comment);
      return json(201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN } });
    }
  }
  return notFound();
}

// --- pull requests ------------------------------------------------------------

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

function handlePulls(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: Record<string, unknown>,
): RestReply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = body.title;
      const head = typeof body.head === 'string' ? stripOwnerPrefix(body.head) : '';
      const base = typeof body.base === 'string' ? stripOwnerPrefix(body.base) : '';
      if (typeof title !== 'string' || !title) {
        return fail(422, 'Validation Failed: title is required');
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return fail(422, `Validation Failed: head branch "${head}" does not exist`);
      if (!baseSha) return fail(422, `Validation Failed: base branch "${base}" does not exist`);
      const duplicate = [...repo.pulls.values()].some(
        (p) => p.state === 'open' && p.headRef === head && p.baseRef === base,
      );
      if (duplicate) {
        return fail(422, 'Validation Failed: a pull request already exists for this branch');
      }
      const pull: PullRec = {
        number: repo.nextNumber++,
        id: forge.nextContentId(),
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        rev: 0,
      };
      repo.pulls.set(pull.number, pull);
      return json(201, pullView(repo, pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return json(200, list.map((p) => pullView(repo, p)));
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (tail.length === 1 && method === 'GET') {
    if (!pull) return notFound();
    return json(200, pullView(repo, pull));
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (!pull) return notFound();
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const files = changedFiles(repo, pull.baseSha, headSha).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
    return json(200, files);
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pull) return notFound();
    if (pull.merged) return fail(405, 'Pull Request is already merged');
    if (typeof body.merge_method === 'string' && body.merge_method !== 'squash') {
      return fail(405, `Merge method ${body.merge_method} is not supported`);
    }
    const { mergeable } = assessMerge(repo, pull);
    if (!mergeable) return fail(405, 'Pull Request is not mergeable');
    const sha = squashMerge(forge, repo, pull);
    if (!sha) return fail(405, 'Pull Request is not mergeable');
    return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return notFound();
}
