# makefun-github-core-clone-01-r3

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xplaynode/makefun-github-core-clone-01-r3/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xplaynode/makefun-github-core-clone-01-r3/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process, written from
scratch in TypeScript with no dependencies beyond the Node standard library.
It implements the surfaces a GitHub client actually touches:

- **Git smart-HTTP** — protocol v2 (`ls-refs`, `fetch` with shallow/deepen
  support) and v0 ref advertisement and fetch, plus `receive-pack` pushes
  with fast-forward enforcement and sideband report-status.
- **REST API** (`/api/v3`) — repositories, contents (read/write/delete with
  sha conflict checks), git refs, branches, commits, labels, issues,
  comments and pull requests with squash merges and three-way mergeability.
- **GraphQL** (`/api/graphql`) — a hand-written parser and executor covering
  viewer/repository/node queries, issue and pull-request connections with
  cursor pagination, introspection of the forge's own types, batched
  requests, and the issue/pull-request/comment mutations.
- **MCP** (`/mcp`) — JSON-RPC 2.0 with server discovery, the initialize
  handshake, and six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) backed by the
  same store as REST and GraphQL, so an object created on one surface is the
  same object — same ids — on every other.

All state is in memory. Repository ids come from one global sequence, and
issues, pull requests and comments share one global content-id sequence,
mirroring a real forge's database ids; each repository additionally owns the
shared issue/PR number sequence GitHub users see. Server-generated commits
and timestamps come from a logical clock, so behaviour is deterministic.

## Layout

| File | Role |
| --- | --- |
| `main.ts` | Thin entrypoint: bind, print the listening line, harness lifecycle |
| `app.ts` | HTTP shell: routing, bearer auth, body handling |
| `store.ts` | In-memory forge state, id sequences, logical clock, mutation funnel |
| `gitobjects.ts` | Content-addressed object store, pack read/write, reachability |
| `pktline.ts` | pkt-line framing and sideband wrapping |
| `githttp.ts` | Smart-HTTP: advertisement, ls-refs, fetch, receive-pack |
| `rest.ts` | The `/api/v3` surface |
| `graphql.ts` | GraphQL parser and executor |
| `mcp.ts` | The MCP tool surface |
| `merge.ts` | Tree diffs, three-way mergeability, squash merges |
| `selftest.ts` | End-to-end smoke test over every surface |

## Optimisations

Six deliberate optimisations keep the hot paths cheap; all measurements are
from this machine (bench = the kit's conformance + workload runner).

1. **Per-repo git answer cache.** Ref advertisements, ls-refs and fetch
   bodies are cached per repository, keyed by a hash of the exact request
   body. Every mutation — receive-pack, contents commits, ref creation,
   pull merges — flows through a single funnel that clears the repo's
   cache, so a cached answer always describes current state. Effect: the
   clone workload's repeated identical fetches are served from memory;
   a cached advertisement costs ~0.02 ms to answer.
2. **Framed pack-entry cache.** Pack writing memoises each object's framed
   bytes (varint header + deflated payload) by object id in a bounded FIFO
   cache (8,192 entries), so repeat fetches skip zlib entirely. The default
   zlib level is kept on purpose: pack bytes are part of the forge's
   observable behaviour and must not drift.
3. **Parse-once upload-pack dispatch.** The pkt-line request body is parsed
   exactly once at dispatch; the parsed packets are handed to the ls-refs
   and fetch handlers instead of being re-parsed per handler.
4. **Buffer-level commit-head parsing.** Reachability walks scan commit
   buffers directly for `tree`/`parent` lines (no full object
   materialisation, no message decoding), and walk queues use an index
   pointer instead of `Array.shift()`, keeping walks linear.
5. **Serialised issue-view cache.** The single-issue GET response is cached
   as pre-serialised JSON, validated by a per-issue revision counter
   (bumped by REST PATCH and by GraphQL closeIssue alike) plus the issue's
   comment count; on a hit the shell sends the stored bytes verbatim.
   Effect: the read workload (2,000 sequential single-issue GETs) runs at
   ~1,100 ms against ~1,149 ms for a plain serialise-every-time design.
6. **Allocation-lean framing.** pkt-line headers are written in place into
   a single output buffer, sideband frames are one allocation each, request
   bodies take a single-chunk fast path, and ISO timestamps and request-id
   headers are memoised/counter-based rather than recomputed.

Overall, the bench scores this build at 144–152 perf points across runs
(clone ~111–184 ms, read ~1,102–1,190 ms, write ~162–187 ms per workload),
with all 120 conformance checks passing on every run.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The server binds an ephemeral port and prints `[entry] listening on port N`.
When `MAKEFUN_ENV_URL` is set it additionally registers that port with the
harness and serves until the harness signals completion. Clients
authenticate with `Authorization: Bearer <token>` on the REST, GraphQL and
MCP surfaces; `GET /healthz` answers `{"ok":true}` without auth.

Smoke-test a checkout with:

```sh
npm run selftest
```
