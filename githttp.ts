// Git smart-HTTP protocol: ref advertisement, protocol v2 ls-refs/fetch,
// v0 fetch, and receive-pack pushes.
//
// Read answers are cached per repository, keyed by a hash of the exact
// request body (plus service/version for advertisements); the cache is
// invalidated through the store's mutation funnel, so a cached answer is
// always an answer about the repository's current state. Upload-pack
// requests are parsed exactly once and the parsed packets are handed to
// the ls-refs / fetch handlers.

import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  closure,
  commitGenerations,
  isAncestor,
  packOrder,
  parseCommitHead,
  readPack,
  storeObject,
  treeClosureInto,
  writePack,
  type ObjectStore,
} from './gitobjects.ts';
import { PKT_FLUSH, pkt, pktLines, sidebandWrap, stripLf, unpktPrefix } from './pktline.ts';
import { touchRepo, type Repo } from './store.ts';

export const AGENT = 'lucky-forge/1.0.0';

const UPLOAD_CAPS_V0 = (repo: Repo): string =>
  `multi_ack_detailed side-band-64k thin-pack ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Refs sorted by name, tags peeled to their commit where applicable. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** If `oid` is an annotated tag, the commit it points at; else undefined. */
function peeledCommit(store: ObjectStore, oid: string): string | undefined {
  const obj = store.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('latin1'));
  if (!match) return undefined;
  const target = store.get(match[1]);
  return target?.type === 'commit' ? match[1] : undefined;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// --- advertisement ----------------------------------------------------------

export function infoRefs(repo: Repo, service: string, v2: boolean): GitReply {
  const contentType = `application/x-${service}-advertisement`;
  const cacheKey = `adv:${service}:${v2 ? 2 : 0}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached) return { status: 200, contentType, body: cached };

  let body: Buffer;
  if (service === 'git-upload-pack' && v2) {
    body = Buffer.concat([
      pktLines([
        'version 2',
        `agent=${AGENT}`,
        'ls-refs=unborn',
        'fetch=shallow',
        'object-format=sha1',
      ]),
      Buffer.from(PKT_FLUSH, 'latin1'),
    ]);
  } else {
    const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : UPLOAD_CAPS_V0(repo);
    const lines: Buffer[] = [pkt(`# service=${service}\n`), Buffer.from(PKT_FLUSH, 'latin1')];
    const refs = sortedRefs(repo);
    if (refs.length === 0) {
      lines.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}`));
    } else {
      const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
      let first = true;
      const emit = (oid: string, name: string): void => {
        if (first) {
          lines.push(pkt(`${oid} ${name}\0${caps}`));
          first = false;
        } else {
          lines.push(pkt(`${oid} ${name}`));
        }
      };
      emit(headOid, 'HEAD');
      for (const ref of refs) {
        emit(ref.oid, ref.name);
        const peeled = peeledCommit(repo.objects, ref.oid);
        if (peeled) lines.push(pkt(`${peeled} ${ref.name}^{}`));
      }
    }
    lines.push(Buffer.from(PKT_FLUSH, 'latin1'));
    body = Buffer.concat(lines);
  }
  repo.gitCache.set(cacheKey, body);
  return { status: 200, contentType, body };
}

// --- upload-pack ------------------------------------------------------------

export function uploadPack(repo: Repo, body: Buffer): GitReply {
  const contentType = 'application/x-git-upload-pack-result';
  const cacheKey = `up:${sha1Hex(body)}`;
  const cached = repo.gitCache.get(cacheKey);
  if (cached) return { status: 200, contentType, body: cached };

  // Parse once: the first run of pkt-lines decides the dispatch.
  const first = unpktPrefix(body, 0);
  if (first.packets.length === 0) throw new Error('empty upload-pack request');
  const firstLine = stripLf(first.packets[0]).toString('latin1');

  let reply: Buffer;
  if (firstLine.startsWith('command=')) {
    const command = firstLine.slice('command='.length);
    const argsStart = first.consumed;
    const argSection = unpktPrefix(body, argsStart);
    if (command === 'ls-refs') {
      reply = lsRefs(repo, argSection.packets);
    } else if (command === 'fetch') {
      reply = fetchV2(repo, argSection.packets);
    } else {
      throw new Error(`unsupported protocol v2 command ${command}`);
    }
  } else if (firstLine.startsWith('want ')) {
    reply = fetchV0(repo, first.packets, body, first.consumed);
  } else {
    throw new Error('unrecognised upload-pack request');
  }
  repo.gitCache.set(cacheKey, reply);
  return { status: 200, contentType, body: reply };
}

function lsRefs(repo: Repo, argPackets: Buffer[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of argPackets) {
    const line = stripLf(raw).toString('latin1');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${target}`;
      if (peel) {
        const peeled = peeledCommit(repo.objects, headOid);
        if (peeled) line += ` peeled:${peeled}`;
      }
      lines.push(line);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${target}`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledCommit(repo.objects, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([pktLines(lines), Buffer.from(PKT_FLUSH, 'latin1')]);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepen: boolean;
  done: boolean;
}

function parseFetchArgs(packets: Buffer[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: false, done: false };
  for (const raw of packets) {
    const line = stripLf(raw).toString('latin1');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      args.depth = Number.parseInt(line.slice(7).trim(), 10);
      args.deepen = true;
    } else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      args.deepen = true;
    } else if (line === 'done') args.done = true;
  }
  return args;
}

/** Compute the pack for a fetch: objects the client lacks, in pack order. */
function computeFetchPack(
  repo: Repo,
  args: FetchArgs,
): { pack: Buffer; boundary: string[]; unshallow: string[]; commonHaves: string[] } {
  const store = repo.objects;
  const shallowSet = new Set(args.shallow);
  const { included, boundary } = commitGenerations(store, args.wants, {
    depth: args.depth,
    shallow: shallowSet,
    deepen: args.deepen || args.depth !== undefined,
  });
  const wantObjects = new Set<string>();
  for (const oid of included) {
    wantObjects.add(oid);
    const obj = store.get(oid);
    if (obj?.type === 'commit') treeClosureInto(store, parseCommitHead(obj.data).tree, wantObjects);
  }
  // Non-commit wants (tags, trees, blobs) contribute their full closure.
  for (const want of args.wants) {
    if (!included.has(want) && store.has(want)) {
      for (const oid of closure(store, [want])) wantObjects.add(oid);
    }
  }
  const haveObjects = closure(store, args.haves, shallowSet);
  const send = new Set<string>();
  for (const oid of wantObjects) if (!haveObjects.has(oid)) send.add(oid);
  const order = packOrder(store, args.wants, send);
  const pack = writePack(store, order);
  const unshallow = args.shallow.filter((oid) => included.has(oid) && !boundary.has(oid));
  const commonHaves = args.haves.filter((oid) => store.has(oid));
  return { pack, boundary: [...boundary].sort(), unshallow: unshallow.sort(), commonHaves };
}

function fetchV2(repo: Repo, argPackets: Buffer[]): Buffer {
  const args = parseFetchArgs(argPackets);
  const { pack, boundary, unshallow, commonHaves } = computeFetchPack(repo, args);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  if (commonHaves.length === 0) {
    parts.push(pkt('NAK'));
  } else {
    parts.push(pkt(`ACK ${commonHaves[commonHaves.length - 1]}`));
    if (args.done) parts.push(pkt('ready'));
  }
  parts.push(Buffer.from('0001', 'latin1'));
  if (boundary.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of boundary) parts.push(pkt(`shallow ${oid}`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}`));
    parts.push(Buffer.from('0001', 'latin1'));
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandWrap(1, pack));
  parts.push(Buffer.from(PKT_FLUSH, 'latin1'));
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, wantPackets: Buffer[], body: Buffer, consumed: number): Buffer {
  const wants: string[] = [];
  let sideband = false;
  for (const raw of wantPackets) {
    const text = stripLf(raw).toString('latin1');
    if (!text.startsWith('want ')) continue;
    const rest = text.slice(5);
    const nul = rest.indexOf('\0');
    wants.push((nul === -1 ? rest : rest.slice(0, nul)).trim());
    if (nul !== -1 && rest.slice(nul + 1).includes('side-band-64k')) sideband = true;
  }
  const haves: string[] = [];
  if (consumed < body.length) {
    const second = unpktPrefix(body, consumed);
    for (const raw of second.packets) {
      const text = stripLf(raw).toString('latin1');
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  const store = repo.objects;
  const wantObjects = closure(store, wants);
  const haveObjects = closure(store, haves);
  const send = new Set<string>();
  for (const oid of wantObjects) if (!haveObjects.has(oid)) send.add(oid);
  const pack = writePack(store, packOrder(store, wants, send));
  const parts: Buffer[] = [pkt('NAK\n')];
  parts.push(sideband ? sidebandWrap(1, pack) : pack);
  parts.push(Buffer.from(PKT_FLUSH, 'latin1'));
  return Buffer.concat(parts);
}

// --- receive-pack -----------------------------------------------------------

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): GitReply {
  const contentType = 'application/x-git-receive-pack-result';
  const first = unpktPrefix(body, 0); // throws on malformed framing → 400
  const commands: RefCommand[] = [];
  let capabilities = '';
  for (const raw of first.packets) {
    let text = stripLf(raw).toString('latin1');
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length !== 3) throw new Error('malformed ref command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const rest = body.subarray(first.consumed);
  let unpackLine = 'unpack ok';
  if (rest.length > 0) {
    try {
      readPack(repo.objects, rest);
    } catch (error) {
      unpackLine = `unpack ${error instanceof Error ? error.message : 'error'}`;
    }
  }

  const report: string[] = [unpackLine];
  let applied = false;
  for (const command of commands) {
    const failure = applyRefCommand(repo, command);
    if (failure) {
      report.push(`ng ${command.ref} ${failure}`);
    } else {
      report.push(`ok ${command.ref}`);
      applied = true;
    }
  }
  if (applied) touchRepo(repo);
  else if (rest.length > 0 && unpackLine === 'unpack ok') touchRepo(repo);

  const reportBytes = pktLines(report.map((line) => `${line}\n`));
  const framed = capabilities.includes('side-band-64k')
    ? sidebandWrap(1, reportBytes)
    : reportBytes;
  return {
    status: 200,
    contentType,
    body: Buffer.concat([framed, Buffer.from(PKT_FLUSH, 'latin1')]),
  };
}

/** Validate and apply one ref update; returns a failure reason or undefined. */
function applyRefCommand(repo: Repo, command: RefCommand): string | undefined {
  const store = repo.objects;
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete: the ref must be where the client believes it is.
    if (current !== undefined && current !== command.oldOid) return 'stale ref';
    repo.refs.delete(command.ref);
    return undefined;
  }
  const target = store.get(command.newOid);
  if (!target || (target.type !== 'commit' && target.type !== 'tag')) return 'invalid target';
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return 'already exists';
    repo.refs.set(command.ref, command.newOid);
    return undefined;
  }
  if (current !== command.oldOid) return 'stale ref';
  const newTip = target.type === 'tag' ? peeledCommit(store, command.newOid) : command.newOid;
  const currentObj = store.get(command.oldOid);
  const oldTip =
    currentObj?.type === 'tag' ? peeledCommit(store, command.oldOid) : command.oldOid;
  if (!newTip || !oldTip || !isAncestor(store, oldTip, newTip)) return 'non-fast-forward';
  repo.refs.set(command.ref, command.newOid);
  return undefined;
}

/** Ensure an object exists (used by tests and internal seeding). */
export function ensureObject(repo: Repo, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  return storeObject(repo.objects, type, data);
}
