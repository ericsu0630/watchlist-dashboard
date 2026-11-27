//go:build windows

// Watchlist.exe: a tray app that runs the bundled dashboard server with the bundled Node.
// Folder layout (made by winapp/build.sh):
//
//	Watchlist.exe       this program
//	node\node.exe       Node.js runtime
//	app\                server.js, lib\, public\, node_modules\
//
// Writable files live outside that folder:
//
//	%APPDATA%\Watchlist                    accounts, synced boards, optional .env
//	%LOCALAPPDATA%\Watchlist\Watchlist.log server output
//
// For testing, WD_PORT, WD_DATA_DIR and WD_LOG override the port, data folder and log file.
package main

import (
	_ "embed"
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed icon.ico
var iconICO []byte

const (
	appName = "Watchlist"
	runKey  = `Software\Microsoft\Windows\CurrentVersion\Run`
)

var (
	exePath string
	nodeExe string
	appDir  string
	dataDir string
	logPath string
	// Small state files (current port, "opened once") live next to the log, not in the install folder.
	stateDir string
	job      windows.Handle
)

func main() {
	exe, err := os.Executable()
	if err != nil {
		fatal("Can't find Watchlist.exe's folder: " + err.Error())
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	exePath = exe
	root := filepath.Dir(exe)
	nodeExe = filepath.Join(root, "node", "node.exe")
	appDir = filepath.Join(root, "app")

	dataDir = os.Getenv("WD_DATA_DIR")
	if dataDir == "" {
		cfg, err := os.UserConfigDir() // %APPDATA%
		if err != nil {
			fatal("Can't find the AppData folder: " + err.Error())
		}
		dataDir = filepath.Join(cfg, appName)
	}
	logPath = os.Getenv("WD_LOG")
	if logPath == "" {
		local, err := os.UserCacheDir() // %LOCALAPPDATA%
		if err != nil {
			fatal("Can't find the LocalAppData folder: " + err.Error())
		}
		logPath = filepath.Join(local, appName, appName+".log")
	}
	stateDir = filepath.Dir(logPath)

	for _, f := range []string{nodeExe, filepath.Join(appDir, "server.js")} {
		if _, err := os.Stat(f); err != nil {
			fatal("Missing " + f + "\n\nUnzip the whole Watchlist folder and run Watchlist.exe from inside it.")
		}
	}

	// One copy per data folder: two servers sharing one folder could overwrite each other's accounts.
	// Starting a second copy opens the dashboard of the one that's running.
	h := fnv.New32a()
	h.Write([]byte(strings.ToLower(dataDir)))
	name, _ := windows.UTF16PtrFromString(fmt.Sprintf(`Local\Watchlist-%08x`, h.Sum32()))
	if instance, err := windows.CreateMutex(nil, false, name); errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(instance)
		if b, err := os.ReadFile(filepath.Join(stateDir, "Watchlist.port")); err == nil {
			if p, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && portInUse(p) {
				openURL(fmt.Sprintf("http://localhost:%d", p))
				return
			}
		}
		messageBox("Watchlist is already running. Click its icon in the notification area (bottom right of the taskbar).")
		return
	}

	job = newKillOnCloseJob()
	systray.Run(onReady, func() { srv.stop() })
}

// newKillOnCloseJob returns a Job Object that ends every process in it when this program exits,
// even if it crashes, so node never outlives the tray app.
func newKillOnCloseJob() windows.Handle {
	j, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(j, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(j)
		return 0
	}
	return j
}

var (
	stateItem *systray.MenuItem
	loginItem *systray.MenuItem
)

func onReady() {
	systray.SetIcon(iconICO)
	systray.SetTooltip(appName)
	stateItem = systray.AddMenuItem("Starting…", "")
	stateItem.Disable()
	systray.AddSeparator()
	openItem := systray.AddMenuItem("Open Dashboard", "Open the dashboard in your browser")
	restartItem := systray.AddMenuItem("Restart Server", "Stop and start the server, for example after editing .env")
	systray.AddSeparator()
	loginItem = systray.AddMenuItemCheckbox("Start at Login", "Start Watchlist when you sign in to Windows", startsAtLogin())
	systray.AddSeparator()
	quitItem := systray.AddMenuItem("Quit", "Stop the server and quit")

	go func() {
		for {
			select {
			case <-openItem.ClickedCh:
				openURL(fmt.Sprintf("http://localhost:%d", srv.currentPort()))
			case <-restartItem.ClickedCh:
				go srv.restart()
			case <-loginItem.ClickedCh:
				toggleLogin()
			case <-quitItem.ClickedCh:
				srv.stop()
				systray.Quit()
				return
			}
		}
	}()
	go srv.start()
}

func setState(text string) {
	stateItem.SetTitle(text)
	systray.SetTooltip(appName + " – " + text)
}

// server runs node server.js and tracks which run is current, so a stale exit doesn't overwrite the menu.
type server struct {
	op   sync.Mutex // one start, stop or restart at a time
	mu   sync.Mutex // guards the fields below
	cmd  *exec.Cmd
	done chan struct{}
	gen  int
	port int
}

var srv = &server{port: 3000}

func (s *server) currentPort() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.port
}

func (s *server) start() {
	s.op.Lock()
	defer s.op.Unlock()
	s.launch()
}

func (s *server) launch() {
	_ = os.MkdirAll(dataDir, 0o755)
	dotEnv := readDotEnv(filepath.Join(dataDir, ".env"))
	preferred := 3000
	for _, v := range []string{os.Getenv("WD_PORT"), dotEnv["PORT"]} {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
			preferred = n
			break
		}
	}
	// Use the next free port when the preferred one is taken, so a second server doesn't stop this one.
	port := 0
	for p := preferred; p <= preferred+10; p++ {
		if !portInUse(p) {
			port = p
			break
		}
	}
	if port == 0 {
		setState(fmt.Sprintf("Ports %d–%d are in use", preferred, preferred+10))
		return
	}

	host := dotEnv["HOST"]
	if host == "" {
		// Only this PC by default: the dashboard has no lock. HOST=0.0.0.0 in the .env opens it to the network.
		host = "127.0.0.1"
	}
	cmd := exec.Command(nodeExe, "server.js")
	cmd.Dir = appDir
	cmd.Env = childEnv(map[string]string{
		"PORT":        strconv.Itoa(port),
		"HOST":        host,
		"PD_DATA_DIR": dataDir,
		"NODE_ENV":    "production",
	})
	// No console window for node.
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	log := openLog()
	if log != nil {
		fmt.Fprintf(log, "\r\n--- %s Watchlist starting on port %d\r\n", time.Now().Format(time.RFC1123), port)
		cmd.Stdout = log
		cmd.Stderr = log
	}
	if err := cmd.Start(); err != nil {
		if log != nil {
			log.Close()
		}
		setState("Failed to start: " + err.Error())
		return
	}
	if log != nil {
		log.Close() // node has its own copy of the handle
	}
	if job != 0 {
		if ph, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid)); err == nil {
			_ = windows.AssignProcessToJobObject(job, ph)
			windows.CloseHandle(ph)
		}
	}

	s.mu.Lock()
	s.gen++
	gen := s.gen
	s.cmd = cmd
	s.done = make(chan struct{})
	done := s.done
	s.port = port
	s.mu.Unlock()
	setState(fmt.Sprintf("Starting on :%d…", port))

	go func() {
		err := cmd.Wait()
		close(done)
		s.mu.Lock()
		current := s.gen == gen
		if current {
			s.cmd = nil
		}
		s.mu.Unlock()
		if !current {
			return
		}
		code := 0
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		}
		_ = os.Remove(filepath.Join(stateDir, "Watchlist.port"))
		if code == 2 {
			setState(fmt.Sprintf("Port %d is in use", port))
		} else {
			setState(fmt.Sprintf("Server stopped (exit %d)", code))
		}
	}()

	note := ""
	if port != preferred {
		note = fmt.Sprintf(" (%d was busy)", preferred)
	}
	go s.waitUntilListening(gen, done, port, note)
}

// waitUntilListening polls the port until the server answers, then updates the menu
// (and opens the dashboard the first time the app runs).
func (s *server) waitUntilListening(gen int, done chan struct{}, port int, note string) {
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-done:
			return
		case <-time.After(250 * time.Millisecond):
		}
		s.mu.Lock()
		current := s.gen == gen
		s.mu.Unlock()
		if !current {
			return
		}
		if !portInUse(port) {
			continue
		}
		setState(fmt.Sprintf("Running on :%d%s", port, note))
		_ = os.MkdirAll(stateDir, 0o755)
		_ = os.WriteFile(filepath.Join(stateDir, "Watchlist.port"), []byte(strconv.Itoa(port)), 0o644)
		marker := filepath.Join(stateDir, "opened-once")
		if _, err := os.Stat(marker); errors.Is(err, os.ErrNotExist) {
			_ = os.WriteFile(marker, nil, 0o644)
			openURL(fmt.Sprintf("http://localhost:%d", port))
		}
		return
	}
}

// stop ends the server and waits up to 3 seconds for it to exit. Writes in the server are atomic
// (write a temp file, then rename), so ending it straight away can't leave half a file.
func (s *server) stop() {
	s.op.Lock()
	defer s.op.Unlock()
	s.kill()
}

func (s *server) kill() {
	s.mu.Lock()
	cmd, done := s.cmd, s.done
	s.gen++ // the exit that follows is expected, so it doesn't change the menu
	s.cmd = nil
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
	_ = os.Remove(filepath.Join(stateDir, "Watchlist.port"))
}

func (s *server) restart() {
	s.op.Lock()
	defer s.op.Unlock()
	setState("Restarting…")
	s.kill()
	s.launch()
}

// openLog opens the log for appending, starting it over once it passes 5 MB so it can't grow forever.
func openLog() *os.File {
	_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if fi, err := os.Stat(logPath); err == nil && fi.Size() > 5_000_000 {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(logPath, flags, 0o644)
	if err != nil {
		return nil
	}
	return f
}

// Start at Login is a value under HKCU\...\Run pointing at this Watchlist.exe.
func startsAtLogin() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetStringValue(appName)
	return err == nil && strings.EqualFold(strings.Trim(v, `"`), exePath)
}

func toggleLogin() {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE|registry.SET_VALUE)
	if err == nil {
		if startsAtLogin() {
			err = k.DeleteValue(appName)
		} else {
			// Points at this copy, so turning it on again after moving the folder fixes the path.
			err = k.SetStringValue(appName, `"`+exePath+`"`)
		}
		k.Close()
	}
	if err != nil {
		messageBox("Couldn't change Start at Login: " + err.Error())
	}
	if startsAtLogin() {
		loginItem.Check()
	} else {
		loginItem.Uncheck()
	}
}

func openURL(url string) {
	verb, _ := windows.UTF16PtrFromString("open")
	u, _ := windows.UTF16PtrFromString(url)
	_ = windows.ShellExecute(0, verb, u, nil, nil, windows.SW_SHOWNORMAL)
}

func messageBox(text string) {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(appName)
	windows.MessageBox(0, t, c, windows.MB_OK|windows.MB_ICONINFORMATION)
}

func fatal(text string) {
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(appName)
	windows.MessageBox(0, t, c, windows.MB_OK|windows.MB_ICONERROR)
	os.Exit(1)
}
