// GraphQL surface: a small hand-written parser and executor covering the
// query/mutation shapes the forge's clients use (viewer, repository, node,
// connections, introspection of the forge's own types, and the issue /
// pull-request mutations).
//
// Global ids are opaque base64 encodings of "<Type>:<database id>" — stable
// across reads and never equal to the bare database id. Unknown fields
// produce a GraphQL error naming the field, with partial data preserved,
// matching the real API's behaviour.

import { assessMerge, changedFiles, squashMerge } from './merge.ts';
import {
  VIEWER_LOGIN,
  type Forge,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';

// --- lexer ------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:$!@=|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j++;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (!match) throw new Error(`invalid number at ${i}`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_0-9A-Za-z]+/.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// --- parser -----------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'scalar'; value: unknown }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<[string, Value]> };

type Selection =
  | {
      kind: 'field';
      name: string;
      alias?: string;
      args: Map<string, Value>;
      selections: Selection[];
    }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition?: string; selections: Selection[] };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selections: Selection[];
}

interface GqlDocument {
  operations: Operation[];
  fragments: Map<string, { typeCondition?: string; selections: Selection[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}"`);
    }
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): GqlDocument {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition?: string; selections: Selection[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        this.skipBalancedParens(); // variable definitions
        this.skipDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unsupported definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    if (!this.skipPunct('(')) return;
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.kind === 'punct' && token.value === '(') depth++;
      if (token.kind === 'punct' && token.value === ')') depth--;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      this.skipBalancedParens();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.expectName();
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, Value>();
    if (this.skipPunct('(')) {
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.next();
    }
    this.skipDirectives();
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'scalar', value: token.value };
    if (token.kind === 'number') return { kind: 'scalar', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'scalar', value: true };
      if (token.value === 'false') return { kind: 'scalar', value: false };
      if (token.value === 'null') return { kind: 'scalar', value: null };
      return { kind: 'scalar', value: token.value }; // enum
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        items.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<[string, Value]> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push([fieldName, this.parseValue()]);
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value token');
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'scalar':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, variables);
      return out;
    }
  }
}

// --- schema -----------------------------------------------------------------

interface GqlObj {
  __gqlType: string;
  [key: string]: unknown;
}

function gid(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

function parseGid(raw: unknown): { type: string; id: number } | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!match) return undefined;
    return { type: match[1], id: Number(match[2]) };
  } catch {
    return undefined;
  }
}

function cursorFor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function offsetOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

const TYPE_FIELDS: Record<string, string[]> = {
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'isPrivate',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt'],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state',
    'merged', 'files', 'title', 'body', 'createdAt',
  ],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION'],
};

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Resolver = (ctx: Ctx, source: GqlObj, args: Record<string, unknown>) => unknown;

function repoObj(repo: Repo): GqlObj {
  return { __gqlType: 'Repository', repo };
}
function issueObj(repo: Repo, issue: IssueRec): GqlObj {
  return { __gqlType: 'Issue', repo, issue };
}
function pullObj(repo: Repo, pull: PullRec): GqlObj {
  return { __gqlType: 'PullRequest', repo, pull };
}
function userObj(login: string): GqlObj {
  return { __gqlType: 'User', login };
}

function connection(
  type: string,
  items: GqlObj[],
  args: Record<string, unknown>,
): GqlObj {
  const start = offsetOfCursor(args.after);
  const first = typeof args.first === 'number' ? args.first : items.length;
  const slice = items.slice(start, start + Math.max(0, first));
  return {
    __gqlType: type,
    items: slice,
    endCursor: cursorFor(start + slice.length),
    hasNextPage: start + slice.length < items.length,
  };
}

function findRepoByDbId(forge: Forge, dbId: number): Repo | undefined {
  return forge.listRepos().find((repo) => repo.id === dbId);
}

function findIssue(forge: Forge, globalId: number): { repo: Repo; issue: IssueRec } | undefined {
  for (const repo of forge.listRepos()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === globalId) return { repo, issue };
    }
  }
  return undefined;
}

function findPull(forge: Forge, globalId: number): { repo: Repo; pull: PullRec } | undefined {
  for (const repo of forge.listRepos()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === globalId) return { repo, pull };
    }
  }
  return undefined;
}

function orderItems<T extends { number: number }>(
  items: T[],
  args: Record<string, unknown>,
): T[] {
  const orderBy = args.orderBy as { direction?: string } | undefined;
  const direction = orderBy?.direction ?? 'ASC';
  const sorted = [...items].sort((a, b) => a.number - b.number);
  return direction === 'DESC' ? sorted.reverse() : sorted;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(VIEWER_LOGIN),
    repository: (ctx, _s, args) => {
      if (args.owner !== VIEWER_LOGIN || typeof args.name !== 'string') return null;
      const repo = ctx.forge.getRepo(args.name);
      return repo ? repoObj(repo) : null;
    },
    node: (ctx, _s, args) => {
      const parsed = parseGid(args.id);
      if (!parsed) return null;
      if (parsed.type === 'Repository') {
        const repo = findRepoByDbId(ctx.forge, parsed.id);
        return repo ? repoObj(repo) : null;
      }
      if (parsed.type === 'Issue') {
        const found = findIssue(ctx.forge, parsed.id);
        return found ? issueObj(found.repo, found.issue) : null;
      }
      if (parsed.type === 'PullRequest') {
        const found = findPull(ctx.forge, parsed.id);
        return found ? pullObj(found.repo, found.pull) : null;
      }
      return null;
    },
    __type: (_ctx, _s, args) => {
      const name = args.name;
      if (typeof name !== 'string') return null;
      if (TYPE_FIELDS[name]) {
        return {
          __gqlType: '__Type',
          name,
          fieldsList: [...TYPE_FIELDS[name]].sort(),
          enumList: null,
        };
      }
      if (ENUM_VALUES[name]) {
        return {
          __gqlType: '__Type',
          name,
          fieldsList: null,
          enumList: [...ENUM_VALUES[name]].sort(),
        };
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(input.repositoryId);
      const repo = parsed ? findRepoByDbId(ctx.forge, parsed.id) : undefined;
      if (!repo) throw new Error('repository not found');
      const issue: IssueRec = {
        number: repo.nextNumber++,
        id: ctx.forge.nextContentId(),
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        rev: 0,
      };
      repo.issues.set(issue.number, issue);
      return {
        __gqlType: 'CreateIssuePayload',
        issue: issueObj(repo, issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(input.issueId);
      const found = parsed ? findIssue(ctx.forge, parsed.id) : undefined;
      if (!found) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.rev++;
      return {
        __gqlType: 'CloseIssuePayload',
        issue: issueObj(found.repo, found.issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(input.repositoryId);
      const repo = parsed ? findRepoByDbId(ctx.forge, parsed.id) : undefined;
      if (!repo) throw new Error('repository not found');
      const headRefName = String(input.headRefName ?? '');
      const baseRefName = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRefName}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRefName}`);
      if (!headSha) throw new Error(`head branch ${headRefName} does not exist`);
      if (!baseSha) throw new Error(`base branch ${baseRefName} does not exist`);
      const pull: PullRec = {
        number: repo.nextNumber++,
        id: ctx.forge.nextContentId(),
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: headRefName,
        baseRef: baseRefName,
        headSha,
        baseSha,
        rev: 0,
      };
      repo.pulls.set(pull.number, pull);
      return {
        __gqlType: 'CreatePullRequestPayload',
        pullRequest: pullObj(repo, pull),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(input.pullRequestId);
      const found = parsed ? findPull(ctx.forge, parsed.id) : undefined;
      if (!found) throw new Error('pull request not found');
      const sha = squashMerge(ctx.forge, found.repo, found.pull);
      if (!sha) throw new Error('pull request is not mergeable');
      return {
        __gqlType: 'MergePullRequestPayload',
        pullRequest: pullObj(found.repo, found.pull),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
    addComment: (ctx, _s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGid(input.subjectId);
      const found = parsed ? findIssue(ctx.forge, parsed.id) : undefined;
      if (!found) throw new Error('subject not found');
      const comment = {
        id: ctx.forge.nextContentId(),
        body: typeof input.body === 'string' ? input.body : '',
      };
      found.issue.comments.push(comment);
      const node: GqlObj = {
        __gqlType: 'IssueComment',
        id: gid('IssueComment', comment.id),
        body: comment.body,
      };
      return {
        __gqlType: 'AddCommentPayload',
        commentEdge: { __gqlType: 'IssueCommentEdge', node },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    login: (_ctx, source) => source.login,
  },
  Repository: {
    id: (_ctx, s) => gid('Repository', (s.repo as Repo).id),
    databaseId: (_ctx, s) => (s.repo as Repo).id,
    name: (_ctx, s) => (s.repo as Repo).name,
    nameWithOwner: (_ctx, s) => `${VIEWER_LOGIN}/${(s.repo as Repo).name}`,
    description: (_ctx, s) => (s.repo as Repo).description,
    isPrivate: (_ctx, s) => (s.repo as Repo).isPrivate,
    owner: () => userObj(VIEWER_LOGIN),
    defaultBranchRef: (_ctx, s) => {
      const repo = s.repo as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      return { __gqlType: 'Ref', name: repo.defaultBranch, target: tip };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (_ctx, s, args) => {
      const repo = s.repo as Repo;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (_ctx, s, args) => {
      const repo = s.repo as Repo;
      let list = [...repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states as string[]);
        list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
      }
      const ordered = orderItems(list, args);
      return connection('IssueConnection', ordered.map((i) => issueObj(repo, i)), args);
    },
    pullRequest: (_ctx, s, args) => {
      const repo = s.repo as Repo;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull ? pullObj(repo, pull) : null;
    },
    pullRequests: (_ctx, s, args) => {
      const repo = s.repo as Repo;
      let list = [...repo.pulls.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set(args.states as string[]);
        list = list.filter((pull) => {
          if (pull.merged) return wanted.has('MERGED');
          return wanted.has(pull.state.toUpperCase());
        });
      }
      const ordered = orderItems(list, args);
      return connection('PullRequestConnection', ordered.map((p) => pullObj(repo, p)), args);
    },
  },
  Ref: {
    name: (_ctx, s) => s.name,
    target: (_ctx, s) => ({ __gqlType: 'GitObject', oid: s.target }),
  },
  Issue: {
    id: (_ctx, s) => gid('Issue', (s.issue as IssueRec).id),
    number: (_ctx, s) => (s.issue as IssueRec).number,
    title: (_ctx, s) => (s.issue as IssueRec).title,
    body: (_ctx, s) => (s.issue as IssueRec).body,
    state: (_ctx, s) => (s.issue as IssueRec).state.toUpperCase(),
    createdAt: (ctx, s) => ctx.forge.isoOf(1735689600 + (s.issue as IssueRec).id),
  },
  PullRequest: {
    id: (_ctx, s) => gid('PullRequest', (s.pull as PullRec).id),
    number: (_ctx, s) => (s.pull as PullRec).number,
    title: (_ctx, s) => (s.pull as PullRec).title,
    body: (_ctx, s) => (s.pull as PullRec).body,
    state: (_ctx, s) => {
      const pull = s.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_ctx, s) => (s.pull as PullRec).merged,
    mergeable: (_ctx, s) => {
      const repo = s.repo as Repo;
      const pull = s.pull as PullRec;
      if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
      return assessMerge(repo, pull).mergeable ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (_ctx, s) => (s.pull as PullRec).headRef,
    baseRefName: (_ctx, s) => (s.pull as PullRec).baseRef,
    createdAt: (ctx, s) => ctx.forge.isoOf(1735689600 + (s.pull as PullRec).id),
    files: (_ctx, s, args) => {
      const repo = s.repo as Repo;
      const pull = s.pull as PullRec;
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const nodes: GqlObj[] = changedFiles(repo, pull.baseSha, headSha).map((file) => ({
        __gqlType: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
      }));
      return connection('PullRequestChangedFileConnection', nodes, args);
    },
  },
  PullRequestChangedFile: {
    path: (_ctx, s) => s.path,
    additions: (_ctx, s) => s.additions,
    deletions: (_ctx, s) => s.deletions,
  },
  IssueComment: {
    id: (_ctx, s) => s.id,
    body: (_ctx, s) => s.body,
  },
  IssueCommentEdge: {
    node: (_ctx, s) => s.node,
  },
  CreateIssuePayload: {
    issue: (_ctx, s) => s.issue,
    clientMutationId: (_ctx, s) => s.clientMutationId ?? null,
  },
  CloseIssuePayload: {
    issue: (_ctx, s) => s.issue,
    clientMutationId: (_ctx, s) => s.clientMutationId ?? null,
  },
  CreatePullRequestPayload: {
    pullRequest: (_ctx, s) => s.pullRequest,
    clientMutationId: (_ctx, s) => s.clientMutationId ?? null,
  },
  MergePullRequestPayload: {
    pullRequest: (_ctx, s) => s.pullRequest,
    clientMutationId: (_ctx, s) => s.clientMutationId ?? null,
  },
  AddCommentPayload: {
    commentEdge: (_ctx, s) => s.commentEdge,
    clientMutationId: (_ctx, s) => s.clientMutationId ?? null,
  },
  IssueConnection: {
    nodes: (_ctx, s) => s.items,
    pageInfo: (_ctx, s) => ({
      __gqlType: 'PageInfo',
      hasNextPage: s.hasNextPage,
      endCursor: s.endCursor,
    }),
  },
  PullRequestConnection: {
    nodes: (_ctx, s) => s.items,
    pageInfo: (_ctx, s) => ({
      __gqlType: 'PageInfo',
      hasNextPage: s.hasNextPage,
      endCursor: s.endCursor,
    }),
  },
  PullRequestChangedFileConnection: {
    nodes: (_ctx, s) => s.items,
    pageInfo: (_ctx, s) => ({
      __gqlType: 'PageInfo',
      hasNextPage: s.hasNextPage,
      endCursor: s.endCursor,
    }),
  },
  PageInfo: {
    hasNextPage: (_ctx, s) => s.hasNextPage,
    endCursor: (_ctx, s) => s.endCursor,
  },
  __Type: {
    name: (_ctx, s) => s.name,
    fields: (_ctx, s) =>
      Array.isArray(s.fieldsList)
        ? (s.fieldsList as string[]).map((name) => ({ __gqlType: '__Field', name }))
        : null,
    enumValues: (_ctx, s) =>
      Array.isArray(s.enumList)
        ? (s.enumList as string[]).map((name) => ({ __gqlType: '__EnumValue', name }))
        : null,
  },
  __Field: {
    name: (_ctx, s) => s.name,
  },
  __EnumValue: {
    name: (_ctx, s) => s.name,
  },
};

// --- executor ---------------------------------------------------------------

function isGqlObj(value: unknown): value is GqlObj {
  return typeof value === 'object' && value !== null && '__gqlType' in value;
}

function executeValue(
  ctx: Ctx,
  doc: GqlDocument,
  typeName: string,
  value: unknown,
  selections: Selection[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => executeValue(ctx, doc, typeName, item, selections));
  }
  if (isGqlObj(value)) {
    return executeSelections(ctx, doc, value.__gqlType, value, selections);
  }
  return value;
}

function executeSelections(
  ctx: Ctx,
  doc: GqlDocument,
  typeName: string,
  source: GqlObj,
  selections: Selection[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}"` });
        continue;
      }
      if (fragment.typeCondition && fragment.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(ctx, doc, typeName, source, fragment.selections));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(ctx, doc, typeName, source, selection.selections));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[selection.name];
    if (!resolver) {
      ctx.errors.push({
        message: `Field '${selection.name}' doesn't exist on type '${typeName}'`,
      });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of selection.args) {
      args[argName] = resolveValue(argValue, ctx.variables);
    }
    let value: unknown;
    try {
      value = resolver(ctx, source, args);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] =
      selection.selections.length > 0
        ? executeValue(ctx, doc, typeName, value, selection.selections)
        : value;
  }
  return out;
}

export interface GraphqlReply {
  status: number;
  body: string;
}

/** Execute one GraphQL request body (already JSON-parsed) against the forge. */
export function executeGraphql(forge: Forge, payload: unknown): GraphqlReply {
  if (Array.isArray(payload)) {
    const parts = payload.map((item) => {
      const reply = executeGraphql(forge, item);
      return JSON.parse(reply.body) as unknown;
    });
    return { status: 200, body: JSON.stringify(parts) };
  }
  const request = (payload ?? {}) as {
    query?: unknown;
    variables?: Record<string, unknown>;
    operationName?: string;
  };
  if (typeof request.query !== 'string') {
    return { status: 200, body: JSON.stringify({ errors: [{ message: 'query must be a string' }] }) };
  }
  let doc: GqlDocument;
  try {
    doc = new Parser(lex(request.query)).parseDocument();
  } catch (error) {
    return {
      status: 200,
      body: JSON.stringify({
        errors: [{ message: error instanceof Error ? error.message : 'parse error' }],
      }),
    };
  }
  const operation =
    doc.operations.find((op) => op.name === request.operationName) ?? doc.operations[0];
  if (!operation) {
    return { status: 200, body: JSON.stringify({ errors: [{ message: 'no operation found' }] }) };
  }
  const ctx: Ctx = { forge, variables: request.variables ?? {}, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObj = { __gqlType: rootType };
  const data = executeSelections(ctx, doc, rootType, root, operation.selections);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return { status: 200, body: JSON.stringify(envelope) };
}
