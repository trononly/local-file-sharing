# local-file-sharing (LocalDrop)

Send files between devices on the local network — phone to phone, or phone to PC.

An Expo / React Native app (`localdrop` on screen) plus two small Go helpers for testing against a known-good peer. The app can both send and receive, so two phones running it can share files directly — the Go tools are only needed when a PC is one of the sides. Everything speaks the same tiny TCP protocol, with UDP-broadcast discovery so the sender finds receivers without typing IPs.

## How it works

- **Receiver** listens on TCP `:5000` (configurable in `src/config.ts`).
- **Sender** connects, sends one header line `{"name":"<base>","size":<bytes>}\n`, waits for `ok\n` / `no\n`, then streams exactly `size` body bytes.
- **Discovery** has two layers:
  1. UDP broadcast `{"discover":true}` → receivers answer with a unicast `{"localdrop":"recv","tcp":<port>}` ad (1–2 packets, router-friendly).
  2. Verified TCP probe: connect, send `{"discover":true}`, expect a LocalDrop ad back. Bare-open ports (routers, printers, dev servers) stay silent and are never listed.
- The app also has a **Test** button: a single verified probe with step logging, so you can tell "network problem" from "app problem".
- The Go receiver auto-registers a LAN-scoped Windows Firewall rule (TCP+UDP) on first run (one UAC prompt, bypass with `-no-firewall`).

## Repo layout

| Path | What |
|---|---|
| `App.tsx` | Whole UI: Receive card (listen/stop + CLI hint) and Send card (pick file, host/port, discovered + recent peers, scan/test, progress) |
| `src/config.ts` | Default port (`PORT = 5000`) |
| `src/theme.ts` | Material 3 dark theme (zinc surfaces, white primary) |
| `src/lib/protocol.ts` | Header/reply encode + decode (shared wire format) |
| `src/lib/transfer.ts` | `sendFile()` and `startReceiver()` (TCP, 32 KB chunks, over-read-safe) |
| `src/lib/discover.ts` | UDP discovery, verified TCP probe, subnet sweep, `isLocalhost` guard |
| `src/lib/format.ts` | `fmtSize()` |
| `tools/recv/main.go` | Reference receiver + UDP discovery responder + firewall setup; saves to `tools/received/` |
| `tools/send/main.go` | One-shot sender (test rig for either receiver) |
| `tools/test.txt` | Tiny fixture for send tests |

## Requirements

- Same Wi-Fi / LAN for both devices (localhost on the sender is the sender itself, not the peer — the UI warns about this).
- Node 20+ and npm.
- Android Studio / SDK for on-device builds (the app uses native TCP + UDP modules, so it needs a [development build](https://docs.expo.dev/develop/development-builds/introduction/)).
- Go 1.27+ only if you want the `tools/` helpers.

## Quickstart

### 1. Phone app

```bash
npm install
npx expo start
```

Then build to a device on the same LAN:

```bash
npx expo run:android
```

In the app (phone to phone: start the receiver on one phone, send from the other):

1. **Receive → listen :5000** on the device you want to send *to*. Note the `IP:port` in the header.
2. On the sender: pick a file, enter the receiver's host (or tap **Scan** and pick a discovered chip), then **Send**.
3. **Test** runs one verified probe against the typed host — use it when a scan entry looks stale.

### 2. Go reference peers

```bash
cd tools

# terminal 1: listen (prints reachable LAN IPs, saves into tools/received/)
go run ./recv

# terminal 2: push a file to a receiver (phone or PC)
go run ./send -addr 192.168.1.42:5000 -file ./test.txt
```

Useful flags:

```bash
go run ./recv -addr :5000 -decline        # test the decline path
go run ./recv -no-firewall               # skip Windows Firewall setup
go run ./send -addr host:port -file <path> -deadline 60s
```

## Configuration

- Port: `src/config.ts` (`PORT`), mirrored by the Go `-addr` flags.
- Received files: app → app cache dir; Go `recv` → `tools/received/` (git-ignored, never overwrites its own directory).
- Filenames are `filepath.Base()`-sanitized on both sides; empty names / negative sizes are rejected with `no\n`.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Scan finds nothing | Receiver not listening, different subnet/VLAN, or AP isolation on guest Wi-Fi. Type the IP manually and hit **Test**. |
| Found but send times out | Stale scan entry or wrong device (bare-open port, not LocalDrop). Rescan, then **Test** — only verified peers are listed. |
| `localhost` doesn't work | Expected: on the sender, localhost is the sender itself. Use the LAN IP shown in the app header / `recv` log. |
| Windows can't be reached | Allow the firewall prompt, or run `recv` once elevated so it can add the LAN-only rule. |
| Scan works, send stalls right after | Router flood protection from aggressive sweeping — this app broadcasts once over UDP instead; wait a few seconds and retry. |

## License

MIT — see [LICENSE](LICENSE). Built with [Expo](https://expo.dev).
