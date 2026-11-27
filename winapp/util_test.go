package main

import (
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestReadDotEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	text := "\ufeffPORT=3200\r\n# HOST=0.0.0.0\r\nHOST = '0.0.0.0'\r\nTV_SESSION=\"a=b\"\r\nnot a pair\r\n"
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	got := readDotEnv(path)
	want := map[string]string{"PORT": "3200", "HOST": "0.0.0.0", "TV_SESSION": "a=b"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if len(readDotEnv(filepath.Join(t.TempDir(), "missing"))) != 0 {
		t.Error("missing file should give no values")
	}
}

func TestChildEnv(t *testing.T) {
	t.Setenv("WD_PORT", "1")
	t.Setenv("WD_DATA_DIR", "x")
	t.Setenv("PD_DATA_DIR", "old")
	t.Setenv("KEEP_ME", "yes")
	env := childEnv(map[string]string{"PD_DATA_DIR": "new", "PORT": "3001"})
	for _, kv := range env {
		if strings.HasPrefix(kv, "WD_") {
			t.Errorf("test override passed to node: %s", kv)
		}
	}
	for _, kv := range []string{"PD_DATA_DIR=new", "PORT=3001", "KEEP_ME=yes"} {
		if !slices.Contains(env, kv) {
			t.Errorf("missing %s", kv)
		}
	}
	if slices.Contains(env, "PD_DATA_DIR=old") {
		t.Error("old PD_DATA_DIR kept")
	}
}

func TestPortInUse(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	if !portInUse(port) {
		t.Error("listening port reported free")
	}
	l.Close()
	if portInUse(port) {
		t.Error("closed port reported busy")
	}
}
