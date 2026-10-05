import TcpSocket from "react-native-tcp-socket";
import UdpSocket from "react-native-udp";
import { toByteArray } from "base64-js";

export interface Peer {
  host: string;
  port: number;
  name?: string;
}

const DISCOVER_LINE = new TextEncoder().encode(
  JSON.stringify({ discover: true }) + "\n",
);

/** Derive /24 candidates from e.g. 192.168.1.42 -> 192.168.1.1..254 */
export function subnetCandidates(localIp: string): string[] {
  const m = localIp.trim().match(/^(\d+\.\d+\.\d+)\.\d+$/);
  if (!m) return [];
  const base = m[1];
  const self = localIp.trim();
  const out: string[] = [];
  for (let i = 1; i <= 254; i++) {
    const h = `${base}.${i}`;
    if (h !== self) out.push(h);
  }
  return out;
}

function toBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return toByteArray(data);
  return data as Uint8Array;
}

/**
 * Verified probe: connect, send {"discover":true}, expect a
 * {"localdrop":"recv",...} line back. Bare-TCP-open hosts (routers,
 * dev servers, printers on :5000) stay silent and are NOT listed —
 * previously they were, which caused "found but send times out".
 */
function probe(host: string, port: number, timeoutMs: number): Promise<Peer | null> {
  return new Promise((resolve) => {
    let settled = false;
    let acc = new Uint8Array(0);
    const done = (v: Peer | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        resolve(v);
      }
    };
    const socket = TcpSocket.createConnection({ host, port }, () => {});
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.once("connect", () => {
      try {
        socket.write(DISCOVER_LINE, undefined, () => {});
      } catch {
        done(null);
      }
    });
    socket.on("data", (d: unknown) => {
      try {
        const b = toBytes(d);
        const next = new Uint8Array(acc.length + b.length);
        next.set(acc, 0);
        next.set(b, acc.length);
        acc = next;
        const nl = acc.indexOf(0x0a);
        if (nl === -1) {
          if (acc.length > 1024) done(null); // garbage, not a peer
          return;
        }
        const line = JSON.parse(new TextDecoder().decode(acc.subarray(0, nl))) as {
          localdrop?: string;
          tcp?: number;
        };
        if (line && typeof line.localdrop === "string") {
          done({ host, port: line.tcp ?? port, name: line.localdrop });
        } else {
          done(null);
        }
      } catch {
        done(null);
      }
    });
    socket.once("error", () => done(null));
    socket.once("close", () => done(null));
  });
}

/**
 * Sweep for verified LocalDrop receivers on `port`.
 * No UDP in react-native-tcp-socket, so a TCP handshake sweep is the
 * dependency-free option.
 *
 * Deliberately gentle: a fast 253-SYN burst looks like a port scan and
 * trips flood/DoS protection on many consumer routers, which then
 * throttles the phone — the exact "scan works, send times out right
 * after" symptom. Low concurrency + pauses between batches + nearest
 * hosts first (DHCP neighbors like your laptop are usually adjacent).
 */
export async function scanSubnet(
  localIp: string,
  port: number,
  opts: { timeoutMs?: number; concurrency?: number; batchDelayMs?: number; onProgress?: (checked: number, total: number) => void } = {},
): Promise<Peer[]> {
  const { timeoutMs = 1500, concurrency = 6, batchDelayMs = 200, onProgress } = opts;
  const hosts = nearestFirst(localIp);
  const found: Peer[] = [];
  let checked = 0;
  for (let i = 0; i < hosts.length; i += concurrency) {
    const batch = hosts.slice(i, i + concurrency);
    const res = await Promise.all(batch.map((h) => probe(h, port, timeoutMs)));
    for (const p of res) if (p) found.push(p);
    checked += batch.length;
    onProgress?.(checked, hosts.length);
    if (i + concurrency < hosts.length) {
      await new Promise((r) => setTimeout(r, batchDelayMs));
    }
  }
  return found;
}

/** Same /24 as subnetCandidates but ordered by distance from own address. */
function nearestFirst(localIp: string): string[] {  const hosts = subnetCandidates(localIp);
  const self = Number(localIp.trim().split(".")[3]);
  return hosts.sort(
    (a, b) =>
      Math.abs(Number(a.split(".")[3]) - self) - Math.abs(Number(b.split(".")[3]) - self),
  );
}

export function isLocalhost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Subnet broadcast for a /24, e.g. 192.168.100.42 -> 192.168.100.255. */
export function subnetBroadcast(localIp: string): string | null {
  const m = localIp.trim().match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return m ? `${m[1]}.255` : null;
}

/**
 * One-shout discovery, the way LocalSend/AirDrop-style apps do it: a single
 * UDP broadcast datagram that every receiver answers with a unicast ad.
 * 1–2 packets total — nothing for router flood protection to trip on,
 * unlike the TCP sweep below.
 */
export function discoverUdp(
  localIp: string,
  port: number,
  onLog: (m: string) => void = () => {},
  listenMs = 2500,
): Promise<Peer[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Peer>();
    // Structural type: the lib's .d.ts extends node "events" and tsc
    // can't see .on through it, so we type the surface we use.
    interface Udp {
      close(): void;
      bind(...args: unknown[]): void;
      setBroadcast(flag: boolean): void;
      send(...args: unknown[]): void;
      on(event: string, cb: (...args: never[]) => void): void;
    }
    let socket: Udp | null = null;
    const finish = (why: string) => {
      onLog(`[udp] ${why}, ${found.size} peer(s)`);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve([...found.values()]);
    };
    try {
      socket = UdpSocket.createSocket({ type: "udp4" }) as unknown as Udp;
    } catch (e) {
      onLog(`[udp] create failed: ${e instanceof Error ? e.message : e}`);
      resolve([]);
      return;
    }
    const timer = setTimeout(() => finish("listen window over"), listenMs);
    const msg = JSON.stringify({ discover: true });
    const targets = ["255.255.255.255", subnetBroadcast(localIp)].filter(
      (t): t is string => !!t,
    );
    socket.on("message", (data: unknown, rinfo: { address?: string }) => {
      try {
        const text =
          typeof data === "string"
            ? data
            : new TextDecoder().decode(data as Uint8Array);
        const ad = JSON.parse(text) as { localdrop?: string; tcp?: number };
        const host = rinfo?.address ?? "";
        if (ad && typeof ad.localdrop === "string" && host && !found.has(host)) {
          onLog(`[udp] ad from ${host} (${ad.localdrop})`);
          found.set(host, { host, port: ad.tcp ?? port, name: ad.localdrop });
        }
      } catch {
        /* ignore garbage */
      }
    });
    socket.on("error", (e: unknown) => {
      clearTimeout(timer);
      onLog(`[udp] socket error: ${e instanceof Error ? e.message : String(e)}`);
      finish("error");
    });
    socket.bind(0, undefined, () => {
      try {
        socket?.setBroadcast(true);
        for (const t of targets) {
          onLog(`[udp] shout to ${t}:${port}`);
          socket?.send(msg, undefined, undefined, port, t, (err?: Error) => {
            if (err) onLog(`[udp] send to ${t} failed: ${err.message}`);
          });
        }
      } catch (e) {
        clearTimeout(timer);
        finish(`broadcast failed: ${e instanceof Error ? e.message : e}`);
      }
    });
  });
}

/** Single verified probe with step logging — the "is it the network or the app" test. */
export function testHost(
  host: string,
  port: number,
  onLog: (m: string) => void,
  timeoutMs = 8_000,
): Promise<Peer | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let acc = new Uint8Array(0);
    const done = (v: Peer | null, why: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        onLog(`[test] ${why} after ${Date.now() - t0}ms`);
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        resolve(v);
      }
    };
    onLog(`[test] connecting to ${host}:${port}…`);
    const socket = TcpSocket.createConnection({ host, port }, () => {});
    const timer = setTimeout(() => done(null, "timeout, no reply"), timeoutMs);
    socket.once("connect", () => {
      onLog(`[test] connect event after ${Date.now() - t0}ms, sending discover…`);
      try {
        socket.write(DISCOVER_LINE, undefined, () => {
          onLog(`[test] discover written`);
        });
      } catch (e) {
        done(null, `write threw: ${e instanceof Error ? e.message : e}`);
      }
    });
    socket.on("data", (d: unknown) => {
      try {
        const b = toBytes(d);
        onLog(`[test] data chunk ${b.length}B`);
        const next = new Uint8Array(acc.length + b.length);
        next.set(acc, 0);
        next.set(b, acc.length);
        acc = next;
        const nl = acc.indexOf(0x0a);
        if (nl === -1) return;
        const line = JSON.parse(new TextDecoder().decode(acc.subarray(0, nl))) as {
          localdrop?: string;
          tcp?: number;
        };
        if (line && typeof line.localdrop === "string") {
          done({ host, port: line.tcp ?? port, name: line.localdrop }, `verified peer (${line.localdrop})`);
        } else {
          done(null, "reply wasn't a LocalDrop ad");
        }
      } catch (e) {
        done(null, `parse error: ${e instanceof Error ? e.message : e}`);
      }
    });
    socket.once("error", (e: Error) => done(null, `error: ${e?.message ?? e}`));
    socket.once("close", () => done(null, "closed"));
  });
}
