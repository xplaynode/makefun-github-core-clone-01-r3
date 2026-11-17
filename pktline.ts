// pkt-line framing for the git smart-HTTP protocol.
//
// A pkt-line is a 4-hex-digit length prefix (counting the prefix itself)
// followed by the payload. Length 0 is the flush packet, length 1 the
// delimiter packet and length 2 the response-end packet. Payloads in this
// module are Buffers so the hot paths never round-trip through strings.
//
// The writers are allocation-lean: the 4-byte header is written in place into
// the head of a single output buffer, and sideband frames are produced with
// one allocation per frame instead of a concat of three pieces.

export const PKT_FLUSH = '0000';
export const PKT_DELIM = '0001';

const HEX = '0123456789abcdef';

/** Largest payload one pkt-line may carry (length field caps at 0xffff). */
export const MAX_PKT_PAYLOAD = 0xffff - 4;

/** Frame one payload as a pkt-line. Strings are encoded as UTF-8. */
export function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const total = payload.length + 4;
  if (total > 0xffff) throw new Error(`pkt-line payload too large: ${payload.length}`);
  const out = Buffer.allocUnsafe(total);
  out[0] = HEX.charCodeAt((total >>> 12) & 0xf);
  out[1] = HEX.charCodeAt((total >>> 8) & 0xf);
  out[2] = HEX.charCodeAt((total >>> 4) & 0xf);
  out[3] = HEX.charCodeAt(total & 0xf);
  payload.copy(out, 4);
  return out;
}

/** Frame a sequence of payloads and concatenate them into one buffer. */
export function pktLines(parts: Array<string | Buffer>): Buffer {
  return Buffer.concat(parts.map((part) => pkt(part)));
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30; // 0-9
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10; // a-f
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10; // A-F
  return -1;
}

/**
 * Parse the pkt-lines at the front of `buf`. Stops at the first flush or
 * delimiter packet (consuming it) or at the end of the buffer. Returns the
 * decoded payloads plus the number of bytes consumed; `stop` records which
 * terminator ended the run ('flush' | 'delim' | 'eof'). Throws on malformed
 * framing so callers can answer 400.
 */
export function unpktPrefix(
  buf: Buffer,
  offset = 0,
): { packets: Buffer[]; consumed: number; stop: 'flush' | 'delim' | 'eof' } {
  const packets: Buffer[] = [];
  let pos = offset;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const value = hexValue(buf[pos + i]);
      if (value < 0) throw new Error('invalid pkt-line length');
      len = (len << 4) | value;
    }
    if (len === 0) return { packets, consumed: pos + 4 - offset, stop: 'flush' };
    if (len === 1) return { packets, consumed: pos + 4 - offset, stop: 'delim' };
    if (len === 2) return { packets, consumed: pos + 4 - offset, stop: 'delim' };
    if (len < 4) throw new Error(`invalid pkt-line length ${len}`);
    if (pos + len > buf.length) throw new Error('truncated pkt-line payload');
    packets.push(buf.subarray(pos + 4, pos + len));
    pos += len;
  }
  return { packets, consumed: pos - offset, stop: 'eof' };
}

/** Parse a buffer that must consist entirely of pkt-lines. */
export function unpkt(buf: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const part = unpktPrefix(buf, offset);
    packets.push(...part.packets);
    offset += part.consumed;
    if (part.stop === 'eof' || offset >= buf.length) return packets;
    // A flush/delim inside a "whole buffer" parse is a section boundary; the
    // remaining bytes are parsed as further pkt-lines by looping.
  }
}

/**
 * Wrap a payload in sideband framing: the payload is split into chunks, each
 * emitted as one pkt-line whose first payload byte is the band number. Chunk
 * sizes keep the whole pkt-line inside the protocol's 65520-byte maximum
 * (4 header bytes + 1 band byte + at most 65515 data bytes).
 */
export function sidebandWrap(band: number, data: Buffer): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const maxChunk = 65515;
  const frames: Buffer[] = [];
  for (let off = 0; off < data.length; off += maxChunk) {
    const chunk = data.subarray(off, Math.min(data.length, off + maxChunk));
    const total = chunk.length + 1 + 4;
    const frame = Buffer.allocUnsafe(total);
    frame[0] = HEX.charCodeAt((total >>> 12) & 0xf);
    frame[1] = HEX.charCodeAt((total >>> 8) & 0xf);
    frame[2] = HEX.charCodeAt((total >>> 4) & 0xf);
    frame[3] = HEX.charCodeAt(total & 0xf);
    frame[4] = band;
    chunk.copy(frame, 5);
    frames.push(frame);
  }
  return frames.length === 1 ? frames[0] : Buffer.concat(frames);
}

/** First whitespace-separated token of a pkt-line payload, as a string. */
export function pktHead(packet: Buffer): string {
  const space = packet.indexOf(0x20);
  const end = space === -1 ? packet.length : space;
  return packet.toString('latin1', 0, end);
}

/** Strip one trailing LF from a pkt-line payload, if present. */
export function stripLf(packet: Buffer): Buffer {
  return packet.length > 0 && packet[packet.length - 1] === 0x0a
    ? packet.subarray(0, packet.length - 1)
    : packet;
}
