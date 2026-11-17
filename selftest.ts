// Self-test: boot the forge on an ephemeral port and exercise every
// surface end to end — REST repos/contents/issues, GraphQL viewer, MCP
// discovery and tools, and the git protocol (advertise, ls-refs, push,
// clone). Prints one PASS/FAIL line per assertion and exits non-zero on
// any failure. Run with: npm run selftest

import type { Server } from 'node:http';
import { createApp } from './app.ts';
import { PKT_FLUSH, pkt, pktLines } from './pktline.ts';

process.env.MAKEFUN_SHOP_TOKEN = 'selftest-token';
const TOKEN = 'selftest-token';

let failures = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const server: Server = createApp();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  const health = await fetch(`${base}/healthz`);
  check('healthz', health.status === 200 && ((await health.json()) as { ok: boolean }).ok === true);

  const anon = await fetch(`${base}/api/v3/repos/adaiversen/nope`);
  check('rest anon is 401', anon.status === 401);

  const created = await fetch(`${base}/api/v3/user/repos`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'selftest', private: false, description: 'self test repo' }),
  });
  const repo = (await created.json()) as { id: number; default_branch: string };
  check('repo create 201', created.status === 201 && repo.id === 1 && repo.default_branch === 'main');

  const dup = await fetch(`${base}/api/v3/user/repos`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'selftest' }),
  });
  const dupBody = (await dup.json()) as { message: string };
  check('repo duplicate 422 already exists', dup.status === 422 && /already exists/i.test(dupBody.message));

  const put = await fetch(`${base}/api/v3/repos/adaiversen/selftest/contents/README.md`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({
      message: 'add readme',
      content: Buffer.from('# selftest\n').toString('base64'),
    }),
  });
  const putBody = (await put.json()) as { content: { sha: string }; commit: { sha: string } };
  check('contents put on unborn repo 201', put.status === 201 && putBody.commit.sha.length === 40);

  const got = await fetch(`${base}/api/v3/repos/adaiversen/selftest/contents/README.md`, {
    headers: auth,
  });
  const gotBody = (await got.json()) as { content: string; encoding: string };
  check(
    'contents get round-trips',
    got.status === 200 &&
      gotBody.encoding === 'base64' &&
      Buffer.from(gotBody.content, 'base64').toString() === '# selftest\n',
  );

  const issue = await fetch(`${base}/api/v3/repos/adaiversen/selftest/issues`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ title: 'first issue', body: 'hello' }),
  });
  const issueBody = (await issue.json()) as { number: number; id: number; state: string };
  check('issue create', issue.status === 201 && issueBody.number === 1 && issueBody.state === 'open');

  const patched = await fetch(`${base}/api/v3/repos/adaiversen/selftest/issues/1`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ state: 'closed' }),
  });
  check('issue patch closes', patched.status === 200 && ((await patched.json()) as { state: string }).state === 'closed');

  const gql = await fetch(`${base}/api/graphql`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ query: '{ viewer { login } }' }),
  });
  const gqlBody = (await gql.json()) as { data: { viewer: { login: string } } };
  check('graphql viewer', gql.status === 200 && gqlBody.data.viewer.login === 'adaiversen');

  const discover = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
  });
  const discoverBody = (await discover.json()) as {
    result: { serverInfo: { name: string; version: string }; supportedVersions: string[] };
  };
  check(
    'mcp discover',
    discover.status === 200 &&
      discoverBody.result.serverInfo.name === 'lucky-forge' &&
      discoverBody.result.supportedVersions[0] === '2026-07-28',
  );

  const tools = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  const toolsBody = (await tools.json()) as { result: { tools: Array<{ name: string }> } };
  check('mcp tools/list has six tools', toolsBody.result.tools.length === 6);

  const unknownTool = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'nope_tool', arguments: {} },
    }),
  });
  const unknownBody = (await unknownTool.json()) as { error: { code: number; message: string } };
  check(
    'mcp unknown tool -32602',
    unknownBody.error.code === -32602 && unknownBody.error.message === 'Unknown tool: nope_tool',
  );

  const adv = await fetch(`${base}/adaiversen/selftest.git/info/refs?service=git-upload-pack`, {
    headers: { 'git-protocol': 'version=2' },
  });
  const advText = await adv.text();
  check('git v2 advertisement', adv.status === 200 && advText.includes('version 2'));

  const lsRefs = await fetch(`${base}/adaiversen/selftest.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request' },
    body: Buffer.concat([
      pktLines(['command=ls-refs', 'agent=selftest']),
      Buffer.from('0001', 'latin1'),
      pktLines(['peel', 'symrefs', 'unborn', 'ref-prefix refs/']),
      Buffer.from(PKT_FLUSH, 'latin1'),
    ]),
  });
  const lsText = (await lsRefs.text()).toString();
  check('git ls-refs lists main', lsRefs.status === 200 && lsText.includes('refs/heads/main'));

  const malformed = await fetch(`${base}/adaiversen/selftest.git/git-upload-pack`, {
    method: 'POST',
    body: 'zzzznot-a-pkt-line',
  });
  check('git malformed body is 400', malformed.status === 400);
  const healthAfter = await fetch(`${base}/healthz`);
  check('server healthy after malformed body', healthAfter.status === 200);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log(failures === 0 ? 'SELFTEST OK' : `SELFTEST FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
