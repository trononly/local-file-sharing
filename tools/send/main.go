// Command send pushes one file to a LocalDrop receiver. Test rig for the RN receiver and RN sender
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
	"path/filepath"
	"time"
)

func main() {
	addr := flag.String("addr", "localhost:5000", "receiver host:port")
	path := flag.String("file", "", "file to send")
	deadline := flag.Duration("deadline", 60*time.Second, "overall time budget")
	flag.Parse()
	if *path == "" {
		log.Fatal("usage: send -addr host:port -file <path>")
	}

	f, err := os.Open(*path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		log.Fatal(err)
	}

	conn, err := net.DialTimeout("tcp", *addr, 5*time.Second)
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(*deadline))

	hdr, err := json.Marshal(struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	}{filepath.Base(*path), fi.Size()})
	if err != nil {
		log.Fatal(err)
	}
	if _, err := fmt.Fprintf(conn, "%s\n", hdr); err != nil {
		log.Fatal("write header: ", err)
	}

	reply, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		log.Fatal("read reply: ", err)
	}
	if reply != "ok\n" {
		log.Fatalf("declined: receiver replied %q", reply)
	}

	n, err := io.Copy(conn, f)
	if err != nil {
		log.Fatal("send body: ", err)
	}
	log.Printf("sent %s (%d bytes) to %s", filepath.Base(*path), n, *addr)
}
