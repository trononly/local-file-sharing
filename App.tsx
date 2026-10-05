import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  ActivityIndicator,
  Appbar,
  Button,
  Card,
  Chip,
  Divider,
  List,
  PaperProvider,
  ProgressBar,
  Snackbar,
  Text,
  TextInput,
} from "react-native-paper";
import * as Network from "expo-network";
import { File } from "expo-file-system";
import TcpSocket from "react-native-tcp-socket";
import { PORT } from "@/config";
import { theme, mono } from "@/theme";
import { sendFile, startReceiver } from "@/lib/transfer";
import { discoverUdp, isLocalhost, scanSubnet, testHost, type Peer } from "@/lib/discover";
import { fmtSize } from "@/lib/format";

type Server = InstanceType<typeof TcpSocket.Server>;

export default function App() {
  const [ip, setIp] = useState("");
  const [server, setServer] = useState<Server | null>(null);
  const [host, setHost] = useState("");
  const [portStr, setPortStr] = useState(String(PORT));
  const [peers, setPeers] = useState<Peer[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [snack, setSnack] = useState("");

  const port = Number(portStr) || PORT;
  const push = (m: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()} ${m}`, ...l].slice(0, 50));
  const remember = (h: string) =>
    setRecent((r) => [h, ...r.filter((x) => x !== h)].slice(0, 5));

  useEffect(() => {
    Network.getIpAddressAsync()
      .then(setIp)
      .catch(() => setIp("unknown"));
  }, []);

  const toggleServer = () => {
    if (server) {
      server.close();
      setServer(null);
      push("receiver stopped");
      return;
    }
    try {
      const s = startReceiver(port, {
        onOffer: (h) => {
          push(`offer ${h.name} (${fmtSize(h.size)}) — accepting`);
          return true;
        },
        onFile: (f, h) => {
          push(`saved ${h.name}`);
          setSnack(`${h.name} received`);
        },
        onError: (e) => push(`rx: ${e.message}`),
      });
      setServer(s);
      push(`listening on :${port}`);
    } catch (e) {
      push(`listen failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const pick = async () => {
    try {
      const res = await File.pickFileAsync({ multipleFiles: false });
      if (res.canceled) return;
      const f = res.result;
      setFileUri(f.uri);
      setFileName(f.name);
      setFileSize(f.size ?? 0);
      push(`picked ${f.name} (${fmtSize(f.size ?? 0)})`);
    } catch (e) {
      push(`pick failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const scan = async (deep = false) => {
    if (!ip || ip === "unknown") {
      push("no local IP yet — check Wi-Fi, then retry");
      return;
    }
    setScanning(true);
    try {
      if (!deep) {
        setScanMsg("shouting on LAN…");
        const found = await discoverUdp(ip, port, (m) => push(m));
        setPeers(found);
        if (found.length === 0) {
          setScanMsg("nothing heard — try deep scan, or type the IP");
          push("udp: silence — old receiver? try deep scan");
        } else {
          setScanMsg(`${found.length} found`);
          push(`scan: ${found.map((p) => p.host).join(", ")}`);
          if (!host) setHost(found[0].host);
        }
        return;
      }
      setScanMsg("scanning…");
      const found = await scanSubnet(ip, port, {
        onProgress: (c, t) => setScanMsg(`scanning ${c}/${t}…`),
      });
      setPeers(found);
      if (found.length === 0) {
        push(`scan: nothing on :${port} — recv running on your PC?`);
        setScanMsg("nothing found");
      } else {
        push(`scan: ${found.map((p) => p.host).join(", ")}`);
        setScanMsg(`${found.length} found`);
        if (!host) setHost(found[0].host);
      }
    } catch (e) {
      push(`scan failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setScanning(false);
    }
  };

  const test = async () => {
    if (!host || isLocalhost(host)) return;
    await testHost(host.trim(), port, (m) => push(m));
  };

  const send = async () => {
    if (!fileUri) return;
    if (isLocalhost(host)) {
      push("localhost = this phone, not your PC — scan instead");
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const f = new File(fileUri);
      const n = await sendFile(
        host.trim(),
        port,
        f,
        ({ sent, total }) => setProgress(total ? sent / total : 0),
        (m) => push(m),
      );
      push(`sent ${f.name} (${fmtSize(n)}) → ${host}:${port}`);
      remember(host.trim());
    } catch (e) {
      push(`send failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PaperProvider theme={theme}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
          <Appbar.Header mode="small" style={styles.bar}>
            <Appbar.Content
              title="localdrop"
              titleStyle={styles.wordmark}
              subtitle={`${ip || "…"}:${port}`}
              subtitleStyle={styles.monoDim}
            />
            <Chip
              icon={server ? "access-point" : "access-point-off"}
              mode="outlined"
              compact
              textStyle={styles.chipText}
            >
              {server ? "live" : "off"}
            </Chip>
          </Appbar.Header>

          <ScrollView contentContainerStyle={styles.root}>
            <Card mode="outlined" style={styles.card}>
              <Card.Title
                title="receive"
                titleStyle={styles.cardTitle}
                left={(p) => <List.Icon {...p} icon="download" />}
                right={() => (
                  <Button
                    mode={server ? "outlined" : "contained"}
                    onPress={toggleServer}
                    compact
                    style={styles.cardBtn}
                  >
                    {server ? "stop" : `listen :${port}`}
                  </Button>
                )}
              />
              <Card.Content>
                <Text variant="bodySmall" style={styles.dim}>
                  {server
                    ? `accepting files — from your PC: go run ./tools/send -addr ${ip}:${port} -file <path>`
                    : "start the receiver, then send to this device from a peer"}
                </Text>
              </Card.Content>
            </Card>

            <Card mode="outlined" style={styles.card}>
              <Card.Title
                title="send"
                titleStyle={styles.cardTitle}
                left={(p) => <List.Icon {...p} icon="upload" />}
              />
              <Card.Content style={styles.gap}>
                <List.Item
                  title={fileName || "no file picked"}
                  description={fileName ? fmtSize(fileSize) : "tap pick to choose"}
                  titleStyle={fileName ? undefined : styles.dim}
                  left={(p) => <List.Icon {...p} icon="file-outline" />}
                  right={() => (
                    <Button mode="outlined" compact onPress={pick}>
                      pick
                    </Button>
                  )}
                  style={styles.fileRow}
                />
                <View style={styles.row}>
                  <TextInput
                    label="host"
                    value={host}
                    onChangeText={setHost}
                    placeholder="192.168.1.x"
                    autoCapitalize="none"
                    mode="outlined"
                    dense
                    style={[styles.input, styles.hostInput]}
                  />
                  <TextInput
                    label="port"
                    value={portStr}
                    onChangeText={setPortStr}
                    keyboardType="numeric"
                    autoCapitalize="none"
                    mode="outlined"
                    dense
                    style={[styles.input, styles.portInput]}
                  />
                </View>
                {isLocalhost(host) && !!host && (
                  <Text variant="bodySmall" style={styles.warn}>
                    localhost is this phone, not your PC — scan instead.
                  </Text>
                )}
                {peers.length > 0 && (
                  <View style={styles.chips}>
                    {peers.map((p) => (
                      <Chip
                        key={p.host}
                        selected={host === p.host}
                        showSelectedCheck={false}
                        icon="laptop"
                        onPress={() => {
                          setHost(p.host);
                          remember(p.host);
                        }}
                        style={styles.chip}
                        textStyle={styles.monoSm}
                      >
                        {p.host}
                      </Chip>
                    ))}
                  </View>
                )}
                {recent.length > 0 && (
                  <View style={styles.chips}>
                    {recent.map((h) => (
                      <Chip
                        key={h}
                        icon="history"
                        onPress={() => setHost(h)}
                        style={styles.chip}
                        textStyle={styles.monoSm}
                      >
                        {h}
                      </Chip>
                    ))}
                  </View>
                )}
                {!!scanMsg && <Text style={styles.monoDim}>{scanMsg}</Text>}
                <View style={styles.row}>
                  <Button
                    mode="outlined"
                    icon="radar"
                    onPress={() => scan(false)}
                    disabled={scanning}
                    compact
                    style={styles.flex}
                  >
                    scan
                  </Button>
                  <Button
                    mode="text"
                    icon="lan-connect"
                    onPress={test}
                    disabled={!host || isLocalhost(host)}
                    compact
                    style={styles.flex}
                  >
                    test
                  </Button>
                </View>
                <Button
                  mode="text"
                  onPress={() => scan(true)}
                  disabled={scanning}
                  compact
                >
                  deep scan (slow)
                </Button>
                {busy && <ProgressBar progress={progress} style={styles.bar2} />}
                <Button
                  mode="contained"
                  icon="send"
                  onPress={send}
                  disabled={busy || !fileUri || !host}
                >
                  {busy ? "sending…" : "send"}
                </Button>
              </Card.Content>
            </Card>

            <Card mode="outlined" style={styles.card}>
              <Card.Title
                title="log"
                titleStyle={styles.cardTitle}
                left={(p) => <List.Icon {...p} icon="console" />}
                right={() =>
                  scanning ? <ActivityIndicator size={18} style={styles.spin} /> : null
                }
              />
              <Card.Content>
                <Divider style={styles.div} />
                {log.length === 0 && (
                  <Text variant="bodySmall" style={styles.dim}>
                    quiet — nothing yet.
                  </Text>
                )}
                {log.map((l, i) => (
                  <Text key={i} style={styles.logLine}>
                    {l}
                  </Text>
                ))}
              </Card.Content>
            </Card>
          </ScrollView>

          <Snackbar
            visible={!!snack}
            onDismiss={() => setSnack("")}
            duration={3000}
            icon="check-circle-outline"
          >
            {snack}
          </Snackbar>
        </SafeAreaView>
      </SafeAreaProvider>
    </PaperProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.background },
  bar: { backgroundColor: theme.colors.background },
  wordmark: { fontFamily: mono, fontWeight: "700", letterSpacing: 0 },
  monoDim: { fontFamily: mono, fontSize: 11, color: theme.colors.onSurfaceVariant },
  monoSm: { fontFamily: mono, fontSize: 12 },
  chipText: { fontFamily: mono, fontSize: 11 },
  root: { padding: 16, gap: 12, paddingBottom: 32 },
  card: { backgroundColor: theme.colors.surface, borderColor: theme.colors.outline },
  cardTitle: { fontFamily: mono, fontSize: 14, letterSpacing: 1 },
  cardBtn: { marginRight: 8 },
  dim: { color: theme.colors.onSurfaceVariant },
  warn: { color: theme.colors.error },
  gap: { gap: 10 },
  row: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
  input: { backgroundColor: theme.colors.surface },
  hostInput: { flex: 3 },
  portInput: { flex: 1 },
  fileRow: { paddingLeft: 0 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderColor: theme.colors.outline },
  div: { marginBottom: 8, backgroundColor: theme.colors.outlineVariant },
  spin: { marginRight: 16 },
  bar2: { borderRadius: 2 },
  logLine: { fontFamily: mono, fontSize: 11, color: theme.colors.onSurfaceVariant },
});
