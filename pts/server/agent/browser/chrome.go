package browser

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"boombox/agent/browser/proc"

	browserdomain "github.com/chromedp/cdproto/browser"
	"github.com/chromedp/cdproto/cdp"
)

// Playwright's own Chromium switches, less --enable-automation: these builds were made against them, and existing profiles came from them.
var baseArgs = []string{

	"--disable-field-trial-config",
	"--disable-background-networking",
	"--disable-background-timer-throttling",
	"--disable-backgrounding-occluded-windows",
	"--disable-back-forward-cache",
	"--disable-breakpad",
	"--disable-client-side-phishing-detection",
	"--disable-component-extensions-with-background-pages",
	"--disable-component-update",
	"--no-default-browser-check",
	"--disable-default-apps",
	"--disable-dev-shm-usage",
	"--disable-extensions",
	"--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,HttpsUpgrades,PaintHolding,ThirdPartyStoragePartitioning,LensOverlay,PlzDedicatedWorker",
	"--allow-pre-commit-input",
	"--disable-hang-monitor",
	"--disable-ipc-flooding-protection",
	"--disable-popup-blocking",
	"--disable-prompt-on-repost",
	"--disable-renderer-backgrounding",
	"--force-color-profile=srgb",
	"--metrics-recording-only",
	"--no-first-run",
	"--password-store=basic",
	"--use-mock-keychain",
	"--no-service-autorun",
	"--export-tagged-pdf",
	"--disable-search-engine-choice-screen",
	"--headless",
	"--hide-scrollbars",
	"--mute-audio",
	"--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
	"--remote-debugging-pipe",
}

// installHint is what to do when no Chromium is found.
const installHint = "Chromium is not installed. Run: bunx playwright install --with-deps chromium"

// newest is the path with the highest Playwright revision among matches, as chromium-1187 beats chromium-1179.
func newest(matches []string) string {

	revision := func(path string) int {

		for _, part := range strings.Split(filepath.ToSlash(path), "/") {

			if index := strings.LastIndex(part, "-"); index != -1 && (strings.HasPrefix(part, "chromium-") || strings.HasPrefix(part, "chromium_headless_shell-")) {

				n, _ := strconv.Atoi(part[index+1:])

				return n

			}

		}

		return 0

	}

	sort.SliceStable(matches, func(i, j int) bool { return revision(matches[i]) > revision(matches[j]) })

	if len(matches) == 0 {

		return ""

	}

	return matches[0]

}

// findChromium is Playwright's full Chromium, else its headless shell; full is false for the shell, which is easy to spot.
func findChromium() (path string, full bool, err error) {

	if path := os.Getenv("PTS_CHROMIUM"); path != "" {

		return path, true, nil

	}

	base := os.Getenv("PLAYWRIGHT_BROWSERS_PATH")

	if base == "" || base == "0" {

		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".cache", "ms-playwright")

	}

	var matches []string

	for _, pattern := range []string{"chromium-*/chrome-linux*/chrome", "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium", "chromium-*/chrome-win*/chrome.exe"} {

		found, _ := filepath.Glob(filepath.Join(base, pattern))
		matches = append(matches, found...)

	}

	if path := newest(matches); path != "" {

		return path, true, nil

	}

	matches = nil

	for _, pattern := range []string{"chromium_headless_shell-*/chrome-*/headless_shell", "chromium_headless_shell-*/chrome-*/chrome-headless-shell"} {

		found, _ := filepath.Glob(filepath.Join(base, pattern))
		matches = append(matches, found...)

	}

	if path := newest(matches); path != "" {

		return path, false, nil

	}

	return "", false, errors.New(installHint)

}

// stderrTail keeps the end of what Chromium printed, which names a missing library or a sandbox it could not set up.
type stderrTail struct {
	mu   sync.Mutex
	data []byte
}

func (s *stderrTail) Write(chunk []byte) (int, error) {

	s.mu.Lock()
	defer s.mu.Unlock()

	s.data = append(s.data, chunk...)

	if len(s.data) > 4096 {

		s.data = s.data[len(s.data)-4096:]

	}

	return len(chunk), nil

}

// lastLine is the last thing Chromium said before it exited.
func (s *stderrTail) lastLine() string {

	s.mu.Lock()
	defer s.mu.Unlock()

	lines := strings.Split(strings.TrimSpace(string(s.data)), "\n")

	return strings.TrimSpace(lines[len(lines)-1])

}

// process is one running Chromium and the pipe to it.
type process struct {
	cmd *exec.Cmd
	pid int

	conn *conn
	root *session

	exited chan struct{}
}

// startChromium runs binary with the pipe on fds 3 and 4, where --remote-debugging-pipe expects them.
func startChromium(binary string, args, env []string) (*process, error) {

	toChrome, ours, err := os.Pipe()

	if err != nil {

		return nil, err

	}

	theirs, fromChrome, err := os.Pipe()

	if err != nil {

		toChrome.Close()
		ours.Close()

		return nil, err

	}

	cmd := exec.Command(binary, args...)
	cmd.Env = env
	cmd.ExtraFiles = []*os.File{toChrome, fromChrome}
	cmd.Stderr = &stderrTail{}
	proc.Detach(cmd)

	if err := cmd.Start(); err != nil {

		toChrome.Close()
		ours.Close()
		theirs.Close()
		fromChrome.Close()

		return nil, err

	}

	toChrome.Close()
	fromChrome.Close()

	connection := newConn(ours, theirs)
	running := &process{cmd: cmd, pid: cmd.Process.Pid, conn: connection, root: &session{c: connection}, exited: make(chan struct{})}

	go func() {

		cmd.Wait()
		connection.close()
		close(running.exited)

	}()

	return running, nil

}

// failure explains a Chromium that exited while starting, in its own words when it gave any.
func (p *process) failure(fallback string) error {

	select {

	case <-p.exited:

		if line := p.cmd.Stderr.(*stderrTail).lastLine(); line != "" {

			return errors.New("Chromium could not start: " + line)

		}

	case <-time.After(200 * time.Millisecond):

	}

	return errors.New(fallback)

}

// stop asks Chromium to close, so it writes the profile's logins out; one that will not close in time is killed.
func (p *process) stop(wait time.Duration) {

	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()

	call(ctx, p.root, browserdomain.Close, cdp.Empty{})

	select {

	case <-p.exited:

		return

	case <-ctx.Done():

	}

	p.kill()

}

// kill takes the whole process group, and returns once it has gone: the profile lock names it until then.
func (p *process) kill() {

	proc.KillGroup(p.pid)

	for i := 0; i < 60 && !proc.Exited(p.pid); i++ {

		select {

		case <-p.exited:

			return

		case <-time.After(50 * time.Millisecond):

		}

	}

}
