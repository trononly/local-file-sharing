import TcpSocket from "react-native-tcp-socket";
type Socket = InstanceType<typeof TcpSocket.Socket>;
type Server = InstanceType<typeof TcpSocket.Server>;
import { toByteArray } from "base64-js";
import { File, Paths } from "expo-file-system";
import {
  encodeHeader,
  encodeReply,
  tryDecodeHeader,
  decodeReply,
  type FileHeader,
} from "./protocol";

const CHUNK = 32 * 1024;

function toBytes(data: unknown): Uint8Array<ArrayBuffer> {
  if (typeof data === "string") {
    // No encoding set on socket -> native sends base64 string.
    return toByteArray(data) as Uint8Array<ArrayBuffer>;
  }
  return (data as Uint8Array) as Uint8Array<ArrayBuffer>;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function writeAsync(
  socket: Socket,
  data: Uint8Array,
  onLog?: (m: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      // Uint8Array passes binary through the native bridge.
      const t0 = Date.now();
      socket.write(data, undefined, (err?: Error) => {
        if (err) {
          onLog?.(`write cb error after ${Date.now() - t0}ms: ${err.message}`);
          reject(err);
        } else {
          onLog?.(`write cb ok ${data.length}B after ${Date.now() - t0}ms`);
          resolve();
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** Wait for a single "\n"-terminated reply line. Resolves "ok"/"no". */
function waitReply(
  socket: Socket,
  onLog?: (m: string) => void,
  timeoutMs = 15_000,
): Promise<"ok" | "no"> {
  return new Promise((resolve, reject) => {
    let buf = new Uint8Array(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for reply"));
    }, timeoutMs);
    const onData = (d: unknown) => {
      try {
        onLog?.(`reply chunk ${toBytes(d).length}B`);
        buf = concat(buf, toBytes(d));
        const r = decodeReply(buf);
        if (r) {
          cleanup();
          resolve(r);
        }
      } catch (e) {
        cleanup();
        reject(e);
      }
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("connection closed before reply"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

export interface SendProgress {
  sent: number;
  total: number;
}

export async function sendFile(
  host: string,
  port: number,
  file: File,
  onProgress?: (p: SendProgress) => void,
  onLog?: (m: string) => void,
): Promise<number> {
  const log = (m: string) => onLog?.(`[tx] ${m}`);
  const bytes = await file.bytes();
  log(`file ${file.name} ${bytes.length}B`);
  const header = encodeHeader({ name: file.name, size: bytes.length });

  const socket = TcpSocket.createConnection({ host, port }, () => {});
  log(`connecting…`);
  const t0 = Date.now();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      log(`no connect/error/close event after ${Date.now() - t0}ms — bridge stall?`);
      reject(
        new Error(
          `connect to ${host}:${port} timed out — same Wi-Fi? recv running? firewall?`,
        ),
      );
    }, 10_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      log(`connect event after ${Date.now() - t0}ms`);
      resolve();
    });
    socket.once("error", (e: Error) => {
      clearTimeout(timer);
      log(`error event: ${e?.message ?? e}`);
      reject(e);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      log(`close event before connect`);
      reject(new Error(`connection to ${host}:${port} closed before connect`));
    });
    // Belt and braces: some paths emit data without connect
    socket.once("data", () => {
      clearTimeout(timer);
      log(`data before connect — treating as connected`);
      resolve();
    });
  });

  try {
    await writeAsync(socket, header, (m) => log(m));
    log(`header sent, waiting reply…`);
    let reply: "ok" | "no";
    try {
      reply = await waitReply(socket, (m) => log(m));
    } catch {
      throw new Error(
        `no reply from ${host}:${port} — found port but not LocalDrop (stale scan entry? wrong device?). Rescan.`,
      );
    }
    if (reply !== "ok") throw new Error("receiver declined (replied 'no')");

    let sent = 0;
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const slice = bytes.subarray(off, off + CHUNK);
      await writeAsync(socket, slice);
      sent += slice.length;
      onProgress?.({ sent, total: bytes.length });
    }
    return sent;
  } finally {
    socket.destroy();
  }
}

export interface ReceiverEvents {
  onOffer?: (
    header: FileHeader,
  ) => boolean | Promise<boolean> /* false = decline */;
  onProgress?: (got: number, total: number) => void;
  onFile?: (file: File, header: FileHeader) => void;
  onError?: (err: Error) => void;
}

/**
 * Mirrors tools/recv/main.go: one header line `{"name","size"}\n`,
 * reply "ok\n"/"no\n", then exactly `size` body bytes.
 * Single bufio-style accumulator keeps bytes that arrived past the newline.
 */
export function startReceiver(port: number, events: ReceiverEvents = {}): Server {
  const server = TcpSocket.createServer((socket: Socket) => {
    let buf = new Uint8Array(0);
    let header: FileHeader | null = null;
    let body = new Uint8Array(0);
    let done = false;

    const fail = (msg: string) => {
      try {
        socket.write(encodeReply(false));
      } catch {
        /* ignore */
      }
      events.onError?.(new Error(msg));
      socket.destroy();
    };

    socket.on("data", (d: unknown) => {
      (async () => {
        if (done) return;
        buf = concat(buf, toBytes(d));

        if (!header) {
          // Discovery probe? {"discover":true}\n -> advertise, no file.
          const nl = buf.indexOf(0x0a);
          if (nl !== -1) {
            try {
              const line = JSON.parse(
                new TextDecoder().decode(buf.subarray(0, nl)),
              ) as { discover?: boolean };
              if (line && line.discover === true) {
                done = true;
                try {
                  socket.write(
                    new TextEncoder().encode(
                      JSON.stringify({ localdrop: "recv", tcp: port }) + "\n",
                    ),
                  );
                } catch {
                  /* ignore */
                }
                setTimeout(() => socket.destroy(), 300);
                return;
              }
            } catch {
              /* not a discover probe — fall through to file header */
            }
          }
          let parsed;
          try {
            parsed = tryDecodeHeader(buf);
          } catch {
            fail("bad header");
            return;
          }
          if (!parsed) return; // need more bytes
          const base = parsed.header.name.split(/[\\/]/).pop() || "file";
          header = { name: base, size: parsed.header.size };
          buf = Uint8Array.from(parsed.rest); // copy: rest is a view into buf
          if (!header.name || header.size < 0) {
            fail("bad header");
            return;
          }
          const accept = (await events.onOffer?.(header)) ?? true;
          try {
            socket.write(encodeReply(accept));
          } catch {
            /* ignore */
          }
          if (!accept) {
            done = true;
            socket.destroy();
            return;
          }
          if (header.size === 0) {
            await save(new Uint8Array(0));
            return;
          }
        }

        // Body: buf holds bytes after the header newline (+ any earlier over-read).
        body = concat(body, buf);
        buf = new Uint8Array(0);
        events.onProgress?.(body.length, header!.size);
        if (body.length >= header!.size) {
          await save(body.subarray(0, header!.size));
        }
      })().catch((e) => fail(e instanceof Error ? e.message : String(e)));
    });

    const save = async (data: Uint8Array) => {
      if (done) return;
      done = true;
      try {
        const dest = new File(Paths.cache, header!.name);
        if (dest.exists) dest.delete();
        // File.write is sync; wrap for consistency.
        dest.write(data);
        events.onFile?.(dest, header!);
      } catch (e) {
        events.onError?.(e instanceof Error ? e : new Error(String(e)));
      } finally {
        socket.destroy();
      }
    };

    socket.on("error", (e: Error) => events.onError?.(e));
  });

  server.listen({ port, host: "0.0.0.0" });
  return server;
}
