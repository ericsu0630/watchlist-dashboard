// Helpers with no Windows calls, so they can be tested on any OS (go test ./... in winapp).
package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// childEnv is this program's environment minus the WD_ test overrides, with the given values set.
// Windows variable names ignore case, so matching keys are replaced whatever their case.
func childEnv(set map[string]string) []string {
	var out []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if k == "" { // "=C:=C:\..." entries
			out = append(out, kv)
			continue
		}
		u := strings.ToUpper(k)
		if u == "WD_PORT" || u == "WD_DATA_DIR" || u == "WD_LOG" {
			continue
		}
		if _, ok := set[u]; ok {
			continue
		}
		out = append(out, kv)
	}
	for k, v := range set {
		out = append(out, k+"="+v)
	}
	return out
}

// readDotEnv reads KEY=value pairs from the .env in the data folder (only PORT and HOST matter here;
// the server reads the rest).
func readDotEnv(path string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		t := strings.TrimSpace(sc.Text())
		t = strings.TrimPrefix(t, "\ufeff") // Notepad may save a BOM
		if strings.HasPrefix(t, "#") {
			continue
		}
		k, v, ok := strings.Cut(t, "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
			v = v[1 : len(v)-1]
		}
		out[strings.TrimSpace(k)] = v
	}
	return out
}

// edgeCandidates lists where Microsoft Edge is usually installed, for when its App Paths registry
// entry is missing. getenv is os.Getenv (a parameter so tests can pass their own).
func edgeCandidates(getenv func(string) string) []string {
	var out []string
	for _, v := range []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"} {
		if dir := getenv(v); dir != "" {
			out = append(out, filepath.Join(dir, "Microsoft", "Edge", "Application", "msedge.exe"))
		}
	}
	return out
}

// portInUse is true when something already accepts connections on 127.0.0.1:port.
// On Windows a refused local connection can take a moment, so the timeout is short and any error counts as free.
func portInUse(port int) bool {
	c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}
