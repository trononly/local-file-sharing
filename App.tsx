import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
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
import { discoverUdp, isLocalhost, testHost, type Peer } from "@/lib/discover";
import { fmtSize } from "@/lib/format";

type Server = InstanceType<typeof TcpSocket.Server>;

const MUTED = theme.colors.onSurfaceVariant;

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
  const [snack, setSnack] = useState("");

  const port = Number(portStr) || PORT;
  const fail = (m: string) => setSnack(m);
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
      return;
    }
    try {
      const s = startReceiver(port, {
        onOffer: () => true,
        onFile: (f, h) => {
          setSnack(`${h.name} received`);
        },
        onError: (e) => fail(`Receive error: ${e.message}`),
      });
      setServer(s);
    } catch (e) {
      fail(`Couldn't start receiver: ${e instanceof Error ? e.message : e}`);
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
    } catch (e) {
      fail(`Couldn't pick file: ${e instanceof Error ? e.message : e}`);
    }
  };

  const scan = async () => {
    if (!ip || ip === "unknown") {
      fail("No local IP yet — check Wi-Fi, then retry");
      return;
    }
    setScanning(true);
    try {
      setScanMsg("broadcasting…");
      const found = await discoverUdp(ip, port);
      setPeers(found);
      if (found.length === 0) {
        setScanMsg("no receivers found");
      } else {
        setScanMsg(`${found.length} receiver${found.length > 1 ? "s" : ""} found`);
        if (!host) setHost(found[0].host);
      }
    } catch (e) {
      fail(`Scan failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setScanning(false);
    }
  };

  const test = async () => {
    if (!host || isLocalhost(host)) return;
    setScanMsg("testing…");
    try {
      const lines: string[] = [];
      const peer = await testHost(host.trim(), port, (m) => lines.push(m));
      if (peer) {
        setScanMsg(`reachable: ${peer.host}:${peer.port}`);
      } else {
        setScanMsg("unreachable");
        fail(`Can't reach ${host.trim()}:${port}`);
      }
    } catch (e) {
      setScanMsg("unreachable");
      fail(`Test failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const send = async () => {
    if (!fileUri) return;
    if (isLocalhost(host)) {
      fail("Localhost is this phone, not the peer");
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
      );
      setSnack(`Sent ${f.name} (${fmtSize(n)})`);
      remember(host.trim());
    } catch (e) {
      fail(`Send failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PaperProvider theme={theme}>
      <SafeAreaProvider>
        <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
          <View style={styles.header}>
            <Text style={styles.wordmark}>localdrop</Text>
            <Text style={styles.ip}>
              {ip || "…"}:{port}
            </Text>
          </View>
          <Divider style={styles.hairline} />

          <ScrollView contentContainerStyle={styles.root}>
            <Card mode="outlined" style={styles.card}>
              <Card.Content style={styles.cardPad}>
                <View style={styles.sectionHead}>
                  <List.Icon icon="download" color={MUTED} style={styles.headIcon} />
                  <View style={styles.sectionText}>
                    <Text style={styles.cardTitle}>Receive</Text>
                    <Text style={styles.cardSub}>
                      {server ? "Accepting incoming files" : "Start the receiver"}
                    </Text>
                  </View>
                </View>
                <View style={styles.gap}>
                <Button
                  mode={server ? "outlined" : "contained"}
                  icon={server ? "stop" : "play"}
                  onPress={toggleServer}
                  style={styles.btn}
                >
                  {server ? "stop" : `listen :${port}`}
                </Button>
                {server && (
                  <View style={styles.code}>
                    <Text style={styles.codeText}>
                      ./tools/send -addr {ip}:{port} -file {"<path>"}
                    </Text>
                  </View>
                )}
                </View>
              </Card.Content>
            </Card>

            <Card mode="outlined" style={styles.card}>
              <Card.Content style={styles.cardPad}>
                <View style={styles.sectionHead}>
                  <List.Icon icon="upload" color={MUTED} style={styles.headIcon} />
                  <View style={styles.sectionText}>
                    <Text style={styles.cardTitle}>Send</Text>
                    <Text style={styles.cardSub}>Pick a file and a destination</Text>
                  </View>
                </View>
                <View style={styles.gap}>
                <List.Item
                  title={fileName || "No file selected"}
                  description={fileName ? fmtSize(fileSize) : "Choose a file"}
                  titleStyle={fileName ? styles.fileName : styles.dim}
                  descriptionStyle={styles.dim}
                  left={(p) => (
                    <List.Icon {...p} icon="file-outline" color={MUTED} />
                  )}
                  right={() => (
                    <Button mode="contained-tonal" compact onPress={pick} style={styles.btnSm}>
                      Browse
                    </Button>
                  )}
                  style={styles.fileRow}
                />
                <View style={styles.row}>
                  <TextInput
                    label="Host"
                    value={host}
                    onChangeText={setHost}
                    placeholder="192.168.1.x"
                    autoCapitalize="none"
                    mode="outlined"
                    dense
                    outlineStyle={styles.inputOutline}
                    style={[styles.input, styles.hostInput]}
                  />
                  <TextInput
                    label="Port"
                    value={portStr}
                    onChangeText={setPortStr}
                    keyboardType="numeric"
                    autoCapitalize="none"
                    mode="outlined"
                    dense
                    outlineStyle={styles.inputOutline}
                    style={[styles.input, styles.portInput]}
                  />
                </View>
                {isLocalhost(host) && !!host && (
                  <Text variant="bodySmall" style={styles.warn}>
                    Localhost refers to this phone, not the peer.
                  </Text>
                )}
                {peers.length > 0 && (
                  <View style={styles.gapSm}>
                    <Text style={styles.label}>Discovered</Text>
                    <View style={styles.chips}>
                      {peers.map((p) => (
                        <Chip
                          key={p.host}
                          selected={host === p.host}
                          showSelectedCheck={false}
                          icon="laptop"
                          mode="outlined"
                          compact
                          onPress={() => {
                            setHost(p.host);
                            remember(p.host);
                          }}
                          style={styles.chip}
                          textStyle={styles.monoSm}
                        >
                          {p.name ? `${p.name} · ${p.host}` : p.host}
                        </Chip>
                      ))}
                    </View>
                  </View>
                )}
                {recent.length > 0 && (
                  <View style={styles.gapSm}>
                    <Text style={styles.label}>Recent</Text>
                    <View style={styles.chips}>
                      {recent.map((h) => (
                        <Chip
                          key={h}
                          icon="history"
                          mode="outlined"
                          compact
                          onPress={() => setHost(h)}
                          style={styles.chip}
                          textStyle={styles.monoSm}
                        >
                          {h}
                        </Chip>
                      ))}
                    </View>
                  </View>
                )}
                {!!scanMsg && <Text style={styles.scanMsg}>{scanMsg}</Text>}
                <View style={styles.row}>
                  <Button
                    mode="contained-tonal"
                    icon="radar"
                    onPress={scan}
                    loading={scanning}
                    disabled={scanning}
                    style={[styles.flex, styles.btn]}
                  >
                    Scan
                  </Button>
                  <Button
                    mode="outlined"
                    icon="lan-connect"
                    onPress={test}
                    disabled={!host || isLocalhost(host)}
                    style={[styles.flex, styles.btn]}
                  >
                    Test
                  </Button>
                </View>
                {busy && <ProgressBar progress={progress} />}
                <Button
                  mode="contained"
                  icon="send"
                  onPress={send}
                  disabled={busy || !fileUri || !host}
                  style={styles.btn}
                >
                  {busy ? `Sending ${Math.round(progress * 100)}%` : "Send"}
                </Button>
                </View>
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
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 2,
  },
  wordmark: {
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.5,
    color: theme.colors.onBackground,
  },
  ip: { fontFamily: mono, fontSize: 12, color: MUTED },
  hairline: { backgroundColor: theme.colors.outlineVariant },
  root: { padding: 16, gap: 12, paddingBottom: 32 },
  card: { backgroundColor: theme.colors.surface, borderRadius: 16 },
  cardPad: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16 },
  sectionHead: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  headIcon: { margin: 0, marginRight: 4 },
  sectionText: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: "600" },
  cardSub: { fontSize: 13, color: MUTED },
  dim: { color: MUTED },
  warn: { color: theme.colors.error },
  gap: { gap: 12 },
  gapSm: { gap: 6 },
  row: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
  input: { backgroundColor: theme.colors.surface },
  inputOutline: { borderRadius: 10 },
  hostInput: { flex: 3 },
  portInput: { flex: 1 },
  btn: { borderRadius: 10 },
  btnSm: { borderRadius: 8 },
  fileRow: { paddingLeft: 0 },
  fileName: { fontSize: 14 },
  label: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: MUTED,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderColor: theme.colors.outline },
  monoSm: { fontFamily: mono, fontSize: 12 },
  scanMsg: { fontFamily: mono, fontSize: 12, color: MUTED },
  code: {
    backgroundColor: theme.colors.surfaceVariant,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  codeText: { fontFamily: mono, fontSize: 12, color: MUTED },
});
