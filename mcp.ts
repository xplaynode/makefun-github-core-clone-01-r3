// MCP surface (JSON-RPC 2.0 over POST /mcp): server discovery, the legacy
// initialize handshake, and exactly six tools backed by the same store the
// REST and GraphQL surfaces use — an object created over MCP is the same
// object over REST, with the same ids.
//
// The tool list is a frozen constant so repeated tools/list calls are
// byte-identical. Unknown tools fail with JSON-RPC -32602; a known tool
// called with missing arguments fails as an isError tool result.

import { squashMerge } from './merge.ts';
import {
  VIEWER_LOGIN,
  type Forge,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';

export const MCP_SERVER_NAME = 'lucky-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const prop = (type: string, description: string): { type: string; description: string } => ({
  type,
  description,
});

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: prop('string', 'Repository name.'),
        description: prop('string', 'Short description of the repository.'),
        private: prop('boolean', 'Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
        title: prop('string', 'Issue title.'),
        body: prop('string', 'Issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
        state: prop('string', 'Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request proposing changes from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
        title: prop('string', 'Pull request title.'),
        head: prop('string', 'Head branch name.'),
        base: prop('string', 'Base branch name.'),
        body: prop('string', 'Pull request body.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: prop('string', 'Repository owner login.'),
        repo: prop('string', 'Repository name.'),
        pull_number: prop('number', 'Pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpReply {
  status: number;
  body: string;
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: VIEWER_LOGIN },
  };
}

function issueView(issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER_LOGIN },
  };
}

function pullView(repo: Repo, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha,
    },
    base: {
      ref: pull.baseRef,
      sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha,
    },
    user: { login: VIEWER_LOGIN },
  };
}

function toolResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }],
    structuredContent: value,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ message }, true);
}

function lookupRepo(
  forge: Forge,
  args: Record<string, unknown>,
): { repo: Repo } | { error: Record<string, unknown> } {
  const owner = args.owner;
  const name = args.repo;
  if (owner !== VIEWER_LOGIN || typeof name !== 'string') {
    return { error: toolError('repository not found') };
  }
  const repo = forge.getRepo(name);
  if (!repo) return { error: toolError('repository not found') };
  return { repo };
}

function callTool(
  forge: Forge,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const existing = forge.getRepo(repoName);
      if (existing) return toolResult(repoView(existing));
      const repo = forge.createRepo(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const found = lookupRepo(forge, args);
      if ('error' in found) return found.error;
      return toolResult(repoView(found.repo));
    }
    case 'create_issue': {
      const found = lookupRepo(forge, args);
      if ('error' in found) return found.error;
      const issue: IssueRec = {
        number: found.repo.nextNumber++,
        id: forge.nextContentId(),
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        rev: 0,
      };
      found.repo.issues.set(issue.number, issue);
      return toolResult(issueView(issue));
    }
    case 'list_issues': {
      const found = lookupRepo(forge, args);
      if ('error' in found) return found.error;
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...found.repo.issues.values()];
      if (state === 'open' || state === 'closed') {
        list = list.filter((issue) => issue.state === state);
      }
      list.sort((a, b) => a.number - b.number);
      return toolResult(list.map(issueView));
    }
    case 'create_pull_request': {
      const found = lookupRepo(forge, args);
      if ('error' in found) return found.error;
      const repo = found.repo;
      const head = args.head as string;
      const base = args.base as string;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return toolError(`head branch "${head}" does not exist`);
      if (!baseSha) return toolError(`base branch "${base}" does not exist`);
      const pull: PullRec = {
        number: repo.nextNumber++,
        id: forge.nextContentId(),
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const found = lookupRepo(forge, args);
      if ('error' in found) return found.error;
      const repo = found.repo;
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolError('pull request not found');
      if (pull.merged) return toolResult(pullView(repo, pull));
      const sha = squashMerge(forge, repo, pull);
      if (!sha) return toolError('pull request is not mergeable');
      return toolResult(pullView(repo, pull));
    }
    default:
      return toolError(`unhandled tool ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

function handleOne(forge: Forge, message: Record<string, unknown>): McpReply | undefined {
  const method = message.method;
  const id = message.id;
  if (typeof method !== 'string') {
    return rpcError(id ?? null, -32600, 'Invalid request');
  }
  if (id === undefined) return undefined; // notification: nothing to answer
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': {
            name: MCP_SERVER_NAME,
            version: MCP_SERVER_VERSION,
          },
        },
      });
    case 'initialize': {
      const requested = params.protocolVersion;
      const version =
        typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested)
          ? requested
          : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !name) {
        return rpcError(id, -32602, 'Missing tool name');
      }
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null) {
          return rpcResult(id, toolError(`Missing required argument: ${required}`));
        }
      }
      return rpcResult(id, callTool(forge, name, args));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one POST /mcp request. `authed` is the shell's auth verdict. */
export function handleMcp(forge: Forge, rawBody: Buffer, authed: boolean): McpReply {
  if (!authed) {
    return rpcError(null, -32603, 'Unauthorized', 401);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const item of parsed) {
      const reply = handleOne(forge, (item ?? {}) as Record<string, unknown>);
      if (reply) replies.push(JSON.parse(reply.body) as unknown);
    }
    return { status: 200, body: JSON.stringify(replies) };
  }
  const reply = handleOne(forge, (parsed ?? {}) as Record<string, unknown>);
  if (!reply) return { status: 202, body: '' };
  return reply;
}
