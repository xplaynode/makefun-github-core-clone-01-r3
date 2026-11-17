// HTTP shell: routing, auth and body handling for the forge's four
// surfaces (REST, GraphQL, MCP, git smart-HTTP) plus /healthz.
//
// Auth rule: when MAKEFUN_SHOP_TOKEN is set, REST, GraphQL and MCP requests
// must carry `Authorization: Bearer <token>`; anything else is a 401 with a
// JSON error body. Every API response carries a non-empty
// X-GitHub-Request-Id header. Bodies are read with a single-chunk fast path
// so the common small request never pays for a concat.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphql } from './graphql.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge, VIEWER_LOGIN } from './store.ts';

function isAuthed(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (!expected) return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // Single-chunk fast path: most requests arrive in one piece.
      resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function sendJson(
  forge: Forge,
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `req-${++forge.requestSeq}`,
    ...extraHeaders,
  });
  res.end(body);
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function route(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/healthz' && method === 'GET') {
    sendJson(forge, res, 200, '{"ok":true}');
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthed(req)) {
      sendJson(forge, res, 401, JSON.stringify({ message: 'Bad credentials' }));
      return;
    }
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('body must be a JSON object');
        }
        body = parsed as Record<string, unknown>;
      } catch {
        sendJson(forge, res, 400, JSON.stringify({ message: 'Problems parsing JSON' }));
        return;
      }
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
    const reply = handleRest(forge, {
      method,
      segments,
      query: url.searchParams,
      body,
      host: req.headers.host ?? 'localhost',
    });
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': `req-${++forge.requestSeq}` });
      res.end();
      return;
    }
    sendJson(forge, res, reply.status, reply.body, reply.headers);
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    if (!isAuthed(req)) {
      sendJson(forge, res, 401, JSON.stringify({ message: 'Bad credentials' }));
      return;
    }
    const raw = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(forge, res, 400, JSON.stringify({ message: 'Problems parsing JSON' }));
      return;
    }
    const reply = executeGraphql(forge, payload);
    sendJson(forge, res, reply.status, reply.body);
    return;
  }

  if (path === '/mcp') {
    const raw = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
    if (method === 'DELETE') {
      sendJson(forge, res, 200, '{}');
      return;
    }
    const reply = handleMcp(forge, raw, isAuthed(req));
    if (reply.status === 202) {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end();
      return;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
    return;
  }

  const gitMatch = GIT_ROUTE.exec(path);
  if (gitMatch) {
    const [, owner, repoName, endpoint] = gitMatch;
    const repo = owner === VIEWER_LOGIN ? forge.getRepo(decodeURIComponent(repoName)) : undefined;
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('repository not found');
      return;
    }
    try {
      if (endpoint === 'info/refs' && method === 'GET') {
        const service = url.searchParams.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('unknown service');
          return;
        }
        const protocol = req.headers['git-protocol'];
        const v2 = typeof protocol === 'string' && protocol.includes('version=2');
        const reply = infoRefs(repo, service, v2);
        res.writeHead(reply.status, { 'content-type': reply.contentType });
        res.end(reply.body);
        return;
      }
      if (endpoint === 'git-upload-pack' && method === 'POST') {
        const reply = uploadPack(repo, await readBody(req));
        res.writeHead(reply.status, { 'content-type': reply.contentType });
        res.end(reply.body);
        return;
      }
      if (endpoint === 'git-receive-pack' && method === 'POST') {
        const reply = receivePack(repo, await readBody(req));
        res.writeHead(reply.status, { 'content-type': reply.contentType });
        res.end(reply.body);
        return;
      }
    } catch {
      // Malformed protocol bytes: a 400, and the server stays healthy.
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  sendJson(forge, res, 404, JSON.stringify({ message: 'Not Found' }));
}

/** Build the forge's HTTP server (not yet listening). */
export function createApp(forge: Forge = new Forge()): Server {
  return createServer((req, res) => {
    route(forge, req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ message: 'Internal Server Error' }));
    });
  });
}
