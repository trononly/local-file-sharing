export const MAX_HEADER_BYTES = 8 * 1024;

export interface FileHeader {
  name: string;
  size: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeHeader(h: FileHeader): Uint8Array {
  return enc.encode(JSON.stringify({ name: h.name, size: h.size }) + "\n");
}

export function encodeReply(accepted: boolean): Uint8Array {
  return enc.encode(accepted ? "ok\n" : "no\n");
}

/** null = line still incomplete, keep buffering. Throws on garbage. */
export function tryDecodeHeader(
  buf: Uint8Array,
): { header: FileHeader; rest: Uint8Array } | null {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) {
    if (buf.length > MAX_HEADER_BYTES) throw new Error("header too large");
    return null;
  }
  const h = JSON.parse(dec.decode(buf.subarray(0, nl))) as FileHeader;
  if (typeof h.name !== "string" || typeof h.size !== "number" || h.size < 0) {
    throw new Error("bad header");
  }
  return { header: h, rest: buf.subarray(nl + 1) }; // note: view into buf, not a copy
}

/** null = reply line still incomplete. */
export function decodeReply(buf: Uint8Array): "ok" | "no" | null {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return null;
  return dec.decode(buf.subarray(0, nl)).trim() === "ok" ? "ok" : "no";
}
