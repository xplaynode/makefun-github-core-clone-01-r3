// Git object layer: hashing, trees, commits, packfiles and reachability.
//
// Objects live in a plain Map keyed by hex oid. Everything here works on
// Buffers; commit headers are scanned at the byte level so the reachability
// walks never pay for a full string conversion of the commit message.
//
// writePack memoises the framed (header + deflated) bytes of each object in
// a bounded FIFO cache: the same history is packed over and over by clone
// and fetch workloads, and deflate dominates their handler CPU.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export type ObjectStore = Map<string, GitObject>;

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The oid an object would have, without storing it. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'latin1');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object and return its oid. Storing is idempotent. */
export function storeObject(store: ObjectStore, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

/**
 * Scan a commit's header block at the byte level: returns the tree oid and
 * the parent oids. Only the lines up to the blank separator are examined,
 * and scanning stops at the first line that is neither `tree` nor `parent`.
 */
export function parseCommitHead(data: Buffer): { tree: string; parents: string[] } {
  let tree = '';
  const parents: string[] = [];
  let pos = 0;
  while (pos < data.length) {
    const nl = data.indexOf(0x0a, pos);
    const end = nl === -1 ? data.length : nl;
    if (end === pos) break;
    if (end - pos >= 5 && data.toString('latin1', pos, pos + 5) === 'tree ') {
      tree = data.toString('latin1', pos + 5, end);
    } else if (end - pos >= 7 && data.toString('latin1', pos, pos + 7) === 'parent ') {
      parents.push(data.toString('latin1', pos + 7, end));
    } else {
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return { tree, parents };
}

/** Extract the commit message (everything after the blank header line). */
export function commitMessage(data: Buffer): string {
  const split = data.indexOf('\n\n');
  return split === -1 ? '' : data.toString('utf8', split + 2).replace(/\n$/, '');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('latin1', pos, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return entries;
}

/** Serialise tree entries, sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Add a tree and everything under it to `into`. */
export function treeClosureInto(store: ObjectStore, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    const child = store.get(entry.oid);
    if (!child) continue;
    if (child.type === 'tree') treeClosureInto(store, entry.oid, into);
    else into.add(entry.oid);
  }
}

/**
 * Full object closure from a set of tips: commits contribute their parents
 * and their trees; trees contribute their entries recursively. Commits in
 * `stopAt` are included but their parents are not followed (a shallow
 * boundary the peer already has).
 */
export function closure(
  store: ObjectStore,
  tips: Iterable<string>,
  stopAt?: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const tip of tips) queue.push(tip);
  let head = 0; // index-pointer queue: no Array.shift() rescans
  while (head < queue.length) {
    const oid = queue[head++];
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const { tree, parents } = parseCommitHead(obj.data);
      treeClosureInto(store, tree, seen);
      if (!stopAt || !stopAt.has(oid)) {
        for (const parent of parents) if (!seen.has(parent)) queue.push(parent);
      }
    } else if (obj.type === 'tree') {
      treeClosureInto(store, oid, seen);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('latin1'));
      if (match && !seen.has(match[1])) queue.push(match[1]);
    }
  }
  return seen;
}

/**
 * Breadth-first generations of commits from `wants` (wants are generation
 * 1). Traversal is limited to `depth` generations when given. Parents of
 * commits in `shallow` are not followed unless `deepen` is set (a deepen
 * request explicitly walks through the old boundary). Returns the included
 * commit set and the boundary: included commits that have at least one
 * parent which was not included.
 */
export function commitGenerations(
  store: ObjectStore,
  wants: string[],
  opts: { depth?: number; shallow?: ReadonlySet<string>; deepen?: boolean },
): { included: Set<string>; boundary: Set<string> } {
  const gen = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    if (store.get(want)?.type === 'commit' && !gen.has(want)) {
      gen.set(want, 1);
      queue.push(want);
    }
  }
  const boundary = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const myGen = gen.get(oid) as number;
    const { parents } = parseCommitHead(obj.data);
    const blockedByShallow =
      opts.shallow !== undefined && opts.shallow.has(oid) && !opts.deepen;
    for (const parent of parents) {
      const parentGen = myGen + 1;
      const withinDepth = opts.depth === undefined || parentGen <= opts.depth;
      if (!blockedByShallow && withinDepth && store.get(parent)?.type === 'commit') {
        if (!gen.has(parent)) {
          gen.set(parent, parentGen);
          queue.push(parent);
        }
      } else {
        boundary.add(oid);
      }
    }
  }
  return { included: new Set(gen.keys()), boundary };
}

/**
 * Order objects for a pack: commits first, in walk order from the wants
 * (each commit followed through its parents), then the tree closure of
 * each commit in that same order — trees depth-first, entries in stored
 * order, blobs as encountered. Only objects in `include` are emitted,
 * each exactly once.
 */
export function packOrder(
  store: ObjectStore,
  wants: string[],
  include: ReadonlySet<string>,
): string[] {
  const order: string[] = [];
  const emitted = new Set<string>();
  const emit = (oid: string): void => {
    if (!emitted.has(oid) && include.has(oid)) {
      emitted.add(oid);
      order.push(oid);
    }
  };
  const emitTree = (treeOid: string): void => {
    if (emitted.has(treeOid) || !include.has(treeOid)) return;
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    emit(treeOid);
    for (const entry of parseTree(obj.data)) {
      const child = store.get(entry.oid);
      if (!child) continue;
      if (child.type === 'tree') emitTree(entry.oid);
      else emit(entry.oid);
    }
  };
  const commitsInOrder: string[] = [];
  const visitCommit = (oid: string): void => {
    if (emitted.has(oid) || !include.has(oid)) return;
    const obj = store.get(oid);
    if (!obj) return;
    if (obj.type === 'tag') {
      emit(oid);
      const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('latin1'));
      if (match) visitCommit(match[1]);
      return;
    }
    if (obj.type !== 'commit') return;
    emit(oid);
    commitsInOrder.push(oid);
    const { parents } = parseCommitHead(obj.data);
    for (const parent of parents) visitCommit(parent);
  };
  for (const want of wants) visitCommit(want);
  for (const commit of commitsInOrder) {
    const obj = store.get(commit);
    if (obj?.type === 'commit') emitTree(parseCommitHead(obj.data).tree);
  }
  // Anything included but not reached above (a directly wanted tree or
  // blob, say) is appended so no object is ever dropped silently.
  for (const oid of include) {
    if (emitted.has(oid)) continue;
    const obj = store.get(oid);
    if (obj?.type === 'tree') emitTree(oid);
    else emit(oid);
  }
  return order;
}

// --- pack writing -----------------------------------------------------------

const framedEntryCache = new Map<string, Buffer>();
const FRAMED_CACHE_LIMIT = 8192;

function packEntryHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = TYPE_CODES[type] << 4;
  let rest = size;
  first |= rest & 0x0f;
  rest = Math.floor(rest / 16);
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function framedEntry(store: ObjectStore, oid: string): Buffer {
  const cached = framedEntryCache.get(oid);
  if (cached) return cached;
  const obj = store.get(oid);
  if (!obj) throw new Error(`object ${oid} missing from store`);
  const framed = Buffer.concat([packEntryHeader(obj.type, obj.data.length), deflateSync(obj.data)]);
  if (framedEntryCache.size >= FRAMED_CACHE_LIMIT) {
    // FIFO eviction: Maps iterate in insertion order.
    const oldest = framedEntryCache.keys().next().value;
    if (oldest !== undefined) framedEntryCache.delete(oldest);
  }
  framedEntryCache.set(oid, framed);
  return framed;
}

/** Serialise the given objects (in the given order) as a packfile. */
export function writePack(store: ObjectStore, oids: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of oids) parts.push(framedEntry(store, oid));
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// --- pack reading -----------------------------------------------------------

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  readVarint(); // base size (informational)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) offset = offset + delta[pos++] * 2 ** (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) size = size + delta[pos++] * 2 ** (8 * i);
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  void produced;
  return result;
}

interface RawEntry {
  type: ObjType;
  data?: Buffer;
  baseOid?: string;
  baseIndex?: number;
}

/**
 * Parse a packfile and store every object it carries. Delta bases may live
 * earlier in the same pack or already in the store. Returns the number of
 * objects read. Throws on any framing problem.
 */
export function readPack(store: ObjectStore, pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const entries: RawEntry[] = [];
  const indexByOffset = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const entryOffset = pos;
    let byte = pack[pos++];
    const kind = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    indexByOffset.set(entryOffset, entries.length);
    if (kind === 6) {
      // ofs-delta: base is an earlier entry, addressed by negative offset.
      let back = pack[pos++];
      let offset = back & 0x7f;
      while (back & 0x80) {
        back = pack[pos++];
        offset = (offset + 1) * 128 + (back & 0x7f);
      }
      const baseIndex = indexByOffset.get(entryOffset - offset);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const used = inflatedLength(pack, pos, size);
      const data = inflateSync(pack.subarray(pos, pos + used));
      pos += used;
      if (data.length !== size) throw new Error('pack delta size mismatch');
      entries.push({ type: 'blob', data, baseIndex });
    } else if (kind === 7) {
      // ref-delta: base addressed by oid (earlier in this pack or stored).
      const baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      const used = inflatedLength(pack, pos, size);
      const data = inflateSync(pack.subarray(pos, pos + used));
      pos += used;
      if (data.length !== size) throw new Error('pack delta size mismatch');
      entries.push({ type: 'blob', data, baseOid });
    } else {
      const type = CODE_TYPES[kind];
      if (!type) throw new Error(`unknown pack object type ${kind}`);
      const used = inflatedLength(pack, pos, size);
      const data = inflateSync(pack.subarray(pos, pos + used));
      pos += used;
      if (data.length !== size) throw new Error('pack object size mismatch');
      entries.push({ type, data });
    }
  }
  // Resolve deltas in dependency order.
  const resolved: Array<GitObject | undefined> = new Array(entries.length);
  const byOid = new Map<string, GitObject>();
  const resolve = (index: number): GitObject => {
    const done = resolved[index];
    if (done) return done;
    const entry = entries[index];
    let obj: GitObject;
    if (entry.baseIndex === undefined && entry.baseOid === undefined) {
      obj = { type: entry.type, data: entry.data as Buffer };
    } else {
      let base: GitObject;
      if (entry.baseIndex !== undefined) {
        base = resolve(entry.baseIndex);
      } else {
        const found = byOid.get(entry.baseOid as string) ?? store.get(entry.baseOid as string);
        if (!found) throw new Error(`ref-delta base ${entry.baseOid} not available`);
        base = found;
      }
      obj = { type: base.type, data: applyDelta(base.data, entry.data as Buffer) };
    }
    resolved[index] = obj;
    byOid.set(hashObject(obj.type, obj.data), obj);
    return obj;
  };
  for (let i = 0; i < entries.length; i++) {
    const obj = resolve(i);
    storeObject(store, obj.type, obj.data);
  }
  return entries.length;
}

/**
 * Length of the deflate stream starting at `pos`. inflateSync tolerates a
 * buffer that runs past the end of the stream on some Node builds but not
 * others, so probe with a growing window until the stream decodes.
 */
function inflatedLength(pack: Buffer, pos: number, expectedSize: number): number {
  let span = Math.min(pack.length - pos, Math.max(64, expectedSize + 64));
  for (;;) {
    try {
      inflateSync(pack.subarray(pos, pos + span));
      // The stream may end before the window does; binary-search the exact
      // end so the caller's offset lands on the next entry.
      let lo = 1;
      let hi = span;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        try {
          inflateSync(pack.subarray(pos, pos + mid));
          hi = mid;
        } catch {
          lo = mid + 1;
        }
      }
      return lo;
    } catch {
      if (pos + span >= pack.length) throw new Error('deflate stream does not terminate');
      span = Math.min(pack.length - pos, span * 2);
    }
  }
}

/** Flatten a tree into a path → {oid, mode} map (files only). */
export function flattenTree(
  store: ObjectStore,
  treeOid: string,
  prefix = '',
  out = new Map<string, { oid: string; mode: string }>(),
): Map<string, { oid: string; mode: string }> {
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix + entry.name;
    const child = store.get(entry.oid);
    if (child?.type === 'tree') flattenTree(store, entry.oid, `${path}/`, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flattened path map; returns root oid. */
export function storeTreeFromFlat(
  store: ObjectStore,
  flat: Map<string, { oid: string; mode: string }>,
): string {
  const build = (entries: Array<[string, { oid: string; mode: string }]>): string => {
    const direct: TreeEntry[] = [];
    const dirs = new Map<string, Array<[string, { oid: string; mode: string }]>>();
    for (const [path, value] of entries) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        direct.push({ mode: value.mode, name: path, oid: value.oid });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        const list = dirs.get(dir) ?? [];
        list.push([rest, value]);
        dirs.set(dir, list);
      }
    }
    for (const [dir, list] of dirs) {
      direct.push({ mode: '40000', name: dir, oid: build(list) });
    }
    return storeObject(store, 'tree', buildTree(direct));
  };
  return build([...flat.entries()]);
}

/** The oid a commit points at as its tree, or undefined. */
export function commitTree(store: ObjectStore, commitOid: string): string | undefined {
  const obj = store.get(commitOid);
  if (!obj || obj.type !== 'commit') return undefined;
  return parseCommitHead(obj.data).tree;
}

/** True when `ancestor` is reachable from `descendant` via parent links. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommitHead(obj.data).parents) queue.push(parent);
  }
  return false;
}
