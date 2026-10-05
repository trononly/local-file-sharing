// Command recv is the applications reference receiver.
// it speaks the wire protocol soo the react native side
// can be tested against a known-good peer.

package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type header struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func main() {
	addr := flag.String("addr", ":5000", "listen address")
	decline := flag.Bool("decline", false, "answer 'no' to every offer(tests the decline path")
	noFirewall := flag.Bool("no-firewall", false, "skip automatic Windows Firewall rule setup")
	flag.Parse()

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	tcpPortNum := listenerPort(ln)
	if !*noFirewall {
		ensureFirewall(tcpPortNum)
	}
	// UDP discovery responder on the same port number (separate namespace
	// from TCP): one broadcast in, one unicast ad out. This is what keeps
	// phones from having to SYN-sweep the subnet (which trips router
	// flood protection). Best-effort: discovery still works over TCP.
	go serveDiscovery(tcpPortNum)
	log.Printf("listening on %s", ln.Addr())
	for _, ip := range lanIPs() {
		log.Printf("reachable at %s%s (enter this on your phone, not localhost)", ip, *addr)
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Println(err)
		}
		go handle(conn, *decline)
	}
}

func handle(conn net.Conn, decline bool) {
	defer conn.Close()
	// ONE reader for header and body: bufio may read past
	//  the header's newline into the file bytes.
	//  Draining the same reader below keeps those bytes.
	// The RN receiver must handle this exact situation too
	r := bufio.NewReader(conn)

	line, err := r.ReadString('\n')
	if err != nil {
		log.Print("read header: ", err)
		return
	}
	// Discovery probe: {"discover":true} -> advertise, no file.
	var disc struct {
		Discover bool `json:"discover"`
	}
	if err := json.Unmarshal([]byte(line), &disc); err == nil && disc.Discover {
		ad, _ := json.Marshal(struct {
			Localdrop string `json:"localdrop"`
			TCP       int    `json:"tcp"`
		}{"recv", tcpPort(conn)})
		fmt.Fprintf(conn, "%s\n", ad)
		return
	}
	var h header
	if err := json.Unmarshal([]byte(line), &h); err != nil || h.Size < 0 || h.Name == "" {
		log.Printf("bad header %q", line)
		fmt.Fprintf(conn, "no\n")
		return
	}
	name := filepath.Base(h.Name)

	if decline {
		log.Printf("offer %s (%d B) - declining", name, h.Size)
		fmt.Fprintf(conn, "no\n")
		return
	}
	log.Printf("offer %s (%d B) - accepting", name, h.Size)
	fmt.Fprintf(conn, "ok\n")

	// Received files land in ./received so the tool never overwrites
	// its own directory (fixtures, the binary, etc.).
	if err := os.MkdirAll("received", 0o755); err != nil {
		log.Print("mkdir received: ", err)
		return
	}
	f, err := os.Create(filepath.Join("received", name))
	if err != nil {
		log.Print("create: ", err)
		return
	}
	defer f.Close()

	n, err := io.CopyN(f, r, h.Size)
	if err != nil {
		log.Printf("body: got %d/%d bytes: %v", n, h.Size, err)
		return
	}
	log.Printf("saved received/%s (%d B)", name, n)
}

// listenerPort reports the actual local port of a bound listener
// (resolves :0 / :5000 to the real number for the firewall rule).
func listenerPort(ln net.Listener) int {
	if a, ok := ln.Addr().(*net.TCPAddr); ok {
		return a.Port
	}
	if _, p, err := net.SplitHostPort(ln.Addr().String()); err == nil {
		if n, err := strconv.Atoi(p); err == nil {
			return n
		}
	}
	return 5000
}

// ensureFirewall makes recv reachable from the LAN without manual
// commands: on Windows it registers a firewall rule scoped to TCP
// <port> from the local subnet only. First run triggers one UAC
// "Yes" via an elevated netsh call; later runs are silent.
// Non-Windows platforms: no-op. Bypass with -no-firewall.
func ensureFirewall(port int) {
	if runtime.GOOS != "windows" {
		return
	}
	const rule = "LocalDrop"
	if out, err := exec.Command(
		"netsh", "advfirewall", "firewall", "show", "rule", "name="+rule,
	).CombinedOutput(); err == nil && strings.Contains(string(out), rule) {
		ensureFirewallProto(rule+"-UDP", "UDP", port)
		return // already registered
	}
	ensureFirewallProto(rule, "TCP", port)
	ensureFirewallProto(rule+"-UDP", "UDP", port)
}

func ensureFirewallProto(rule, proto string, port int) {
	if out, err := exec.Command(
		"netsh", "advfirewall", "firewall", "show", "rule", "name="+rule,
	).CombinedOutput(); err == nil && strings.Contains(string(out), rule) {
		return // already registered
	}
	args := fmt.Sprintf(
		`advfirewall firewall add rule name=%s dir=in action=allow protocol=%s localport=%d remoteip=localsubnet profile=public,private`,
		rule, proto, port,
	)
	log.Printf("registering firewall rule %q (one UAC prompt, LAN-only %s %d)...", rule, proto, port)
	elevated := exec.Command("powershell", "-NoProfile", "-Command",
		"Start-Process", "netsh", "-ArgumentList", strconv.Quote(args),
		"-Verb", "RunAs", "-Wait", "-WindowStyle", "Hidden")
	if out, err := elevated.CombinedOutput(); err != nil {
		log.Printf("firewall setup declined/failed (%v): phones can't reach "+
			"%s %d from the local subnet until allowed (or run with -no-firewall and allow manually)",
			strings.TrimSpace(string(out)), proto, port)
		return
	}
	log.Printf("firewall rule %q registered", rule)
}
// serveDiscovery answers {"discover":true} UDP datagrams with a unicast
// advertisement. Senders broadcast once (phone -> 255.255.255.255 and the
// subnet broadcast); every LocalDrop receiver replies directly.
func serveDiscovery(tcpPort int) {
	pc, err := net.ListenPacket("udp", fmt.Sprintf(":%d", tcpPort))
	if err != nil {
		log.Printf("udp discovery off: %v", err)
		return
	}
	defer pc.Close()
	ad, _ := json.Marshal(struct {
		Localdrop string `json:"localdrop"`
		TCP       int    `json:"tcp"`
	}{"recv", tcpPort})
	ad = append(ad, '\n')
	buf := make([]byte, 2048)
	for {
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			log.Print("udp read: ", err)
			return
		}
		var disc struct {
			Discover bool `json:"discover"`
		}
		if err := json.Unmarshal(buf[:n], &disc); err != nil || !disc.Discover {
			continue
		}
		if _, err := pc.WriteTo(ad, addr); err != nil {
			log.Print("udp reply: ", err)
		}
	}
}

// tcpPort reports the local port of a listener-accepted connection.
func tcpPort(conn net.Conn) int {
	if a, ok := conn.LocalAddr().(*net.TCPAddr); ok {
		return a.Port
	}
	return 5000
}

// lanIPs returns non-loopback IPv4 addresses so the phone user
// can see which address to type (localhost on the phone != the PC).
func lanIPs() []string {
	var out []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if ip == nil || ip.IsLoopback() {
			continue
		}
		if v4 := ip.To4(); v4 != nil {
			out = append(out, v4.String())
		}
	}
	return out
}
