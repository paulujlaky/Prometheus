//go:build linux

package browser_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"boombox/agent/browser"
)

func TestOpensReadsTypesAndClicksByRef(t *testing.T) {

	linuxOnly(t)

	url := site(t, func(w http.ResponseWriter, r *http.Request) {

		if name := r.URL.Query().Get("name"); name != "" {

			servePage(w, "Greeter", "<h2>Hello "+name+"</h2>")

			return

		}

		servePage(w, "Greeter", `<form><label>Name <input name="name"></label><button>Greet</button></form>`)

	})

	cwd := t.TempDir()
	ctx := context.Background()

	if _, err := browser.Open(ctx, cwd, "file:///etc/passwd"); err == nil {

		t.Fatal("file:// must be refused")

	}

	opened, err := browser.Open(ctx, cwd, url+"/")

	if err != nil || !strings.Contains(opened, "Greeter") {

		t.Fatalf("open %v:\n%s", err, opened)

	}

	if _, err := browser.Type(ctx, cwd, refFor(t, opened, "textbox"), "Ada"); err != nil {

		t.Fatalf("type %v", err)

	}

	greeted, err := browser.Click(ctx, cwd, refFor(t, opened, "button"))

	if err != nil || !strings.Contains(greeted, "Hello Ada") {

		t.Fatalf("click %v:\n%s", err, greeted)

	}

	// the tab strip names a tab by its document's title, not its host
	until(t, func() bool {

		listed, _ := browser.Tab(ctx, cwd, "")

		return strings.Contains(listed, "1. Greeter — ")

	})

}

func TestDoesNotCallItselfHeadless(t *testing.T) {

	linuxOnly(t)

	url := site(t, func(w http.ResponseWriter, r *http.Request) {

		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><title>Who</title><h1></h1><script>
const data = navigator.userAgentData;
document.querySelector("h1").textContent = [String(navigator.webdriver), navigator.userAgent, data ? data.brands.map((brand) => brand.brand).join(",") : "", String(screen.width)].join(" | ");
</script>`)

	})

	text, err := browser.Open(context.Background(), t.TempDir(), url+"/")

	if err != nil {

		t.Fatal(err)

	}

	for _, want := range []string{"false |", "Google Chrome", "| 1920"} {

		if !strings.Contains(text, want) {

			t.Errorf("missing %q in:\n%s", want, text)

		}

	}

	if strings.Contains(text, "HeadlessChrome") {

		t.Errorf("headless in:\n%s", text)

	}

}

type hint struct {

	ua string
	hint string
	full string

}

func TestWorkersDoNotSayHeadless(t *testing.T) {

	linuxOnly(t)

	var mu sync.Mutex

	hits := []hint{}
	document := hint{}
	taken := func(r *http.Request) hint {

		return hint{ua: r.Header.Get("User-Agent"), hint: r.Header.Get("Sec-CH-UA"), full: r.Header.Get("Sec-CH-UA-Full-Version-List")}

	}

	url := site(t, func(w http.ResponseWriter, r *http.Request) {

		switch r.URL.Path {

		case "/sw.js":

			w.Header().Set("Content-Type", "text/javascript")
			fmt.Fprint(w, `self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => { if (new URL(event.request.url).pathname === '/from-sw') event.respondWith(fetch('/hit?from=sw').then(() => new Response('ok'))); });`)

		case "/hit":

			mu.Lock()
			hits = append(hits, taken(r))
			mu.Unlock()

		default:

			mu.Lock()
			document = taken(r)
			mu.Unlock()

			w.Header().Set("Content-Type", "text/html")
			w.Header().Set("Accept-CH", "Sec-CH-UA-Full-Version-List")
			fmt.Fprint(w, `<!doctype html><title>wait</title><script>
const source = "fetch(self.location.origin + '/hit?from=worker').then(() => postMessage('worker-sent'))";
const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
let done = 0;
const show = () => { done += 1; if (done === 2) document.title = "both-sent"; };
worker.onmessage = show;
const controlled = new Promise((resolve) => navigator.serviceWorker.controller ? resolve() : navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
navigator.serviceWorker.register("/sw.js");
controlled.then(() => fetch("/from-sw")).then(show);
</script>`)

		}

	})

	cwd := t.TempDir()
	text, err := browser.Open(context.Background(), cwd, url+"/")

	for i := 0; i < 40 && err == nil && !strings.Contains(text, "both-sent"); i++ {

		time.Sleep(250 * time.Millisecond)
		text, err = browser.Look(context.Background(), cwd)

	}

	if err != nil || !strings.Contains(text, "both-sent") {

		t.Fatalf("%v:\n%s", err, text)

	}

	mu.Lock()
	defer mu.Unlock()

	if len(hits) < 2 {

		t.Fatalf("hits %+v", hits)

	}

	if !strings.Contains(document.hint, "Google Chrome") || strings.Contains(document.hint, "HeadlessChrome") {

		t.Errorf("document %+v", document)

	}

	// Chromium sends no client hints on a worker's fetch at all, as Chrome does; what it does send must not say headless
	for _, hit := range hits {

		if strings.Contains(hit.ua, "HeadlessChrome") || strings.Contains(hit.hint, "HeadlessChrome") || (hit.hint != "" && !strings.Contains(hit.hint, "Google Chrome")) {

			t.Errorf("hit %+v", hit)

		}

	}

}

// widthOf reads a baseline JPEG's width from its SOF0 segment.
func widthOf(jpeg []byte) int {

	at := bytes.Index(jpeg, []byte{0xff, 0xc0})

	if at == -1 || at+9 > len(jpeg) {

		return 0

	}

	return int(binary.BigEndian.Uint16(jpeg[at+7:]))

}

func TestWatchedBrowserStreamsAndTakeOverHoldsTheAgent(t *testing.T) {

	linuxOnly(t)

	url := site(t, func(w http.ResponseWriter, r *http.Request) {

		if name := r.URL.Query().Get("name"); name != "" {

			servePage(w, "Greeter", "<h2>Hello "+name+"</h2>")

			return

		}

		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><title>Greeter</title><a href="?name=Grace" style="position:fixed;inset:0">Greet</a>`)

	})

	cwd := t.TempDir()
	ctx := context.Background()
	opened, err := browser.Open(ctx, cwd, url+"/")

	if err != nil {

		t.Fatal(err)

	}

	link := refFor(t, opened, "link")

	var mu sync.Mutex

	frames := [][]byte{}
	failures := []string{}

	stop := browser.Watch(cwd, browser.Viewer{

		Frame: func(jpeg []byte) {

			if jpeg != nil {

				mu.Lock()
				frames = append(frames, jpeg)
				mu.Unlock()

			}

		},

		Fail: func(message string) {

			mu.Lock()
			failures = append(failures, message)
			mu.Unlock()

		},

	})

	defer stop()

	until(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(frames) > 0 })

	mu.Lock()

	if frames[0][0] != 0xff || frames[0][1] != 0xd8 {

		t.Fatal("frames are JPEG")

	}

	mu.Unlock()

	second := 0
	stopSecond := browser.Watch(cwd, browser.Viewer{Frame: func([]byte) { second++ }, Fail: func(string) {}})

	if second != 1 {

		t.Fatalf("a second viewer is handed the latest frame at once, got %d", second)

	}

	stopSecond()

	if err := browser.TakeOver(cwd, &browser.Size{Width: 400, Height: 700}); err != nil {

		t.Fatal(err)

	}

	until(t, func() bool { mu.Lock(); defer mu.Unlock(); return widthOf(frames[len(frames)-1]) == 400 })

	held := make(chan error, 1)

	go func() {

		_, err := browser.Click(ctx, cwd, link)
		held <- err

	}()

	if err := browser.SendInput(cwd, browser.Input{Kind: "click", X: 0.5, Y: 0.5}); err != nil {

		t.Fatal(err)

	}

	time.Sleep(500 * time.Millisecond)

	select {

	case <-held:

		t.Fatal("the agent's click must wait for the hand-back")

	default:

	}

	browser.HandBack(cwd)

	result := <-held

	if result == nil || !strings.Contains(result.Error(), "Hello Grace") {

		t.Fatalf("result %v", result)

	}

	mu.Lock()
	defer mu.Unlock()

	if len(failures) > 0 {

		t.Fatalf("failures %v", failures)

	}

}

// pidOf fails the test rather than return 0, since signalling -0 would stop or kill the test run itself.
func pidOf(t *testing.T, workspace string) int {

	t.Helper()

	pid := browser.ChromiumPID(workspace)

	if pid <= 1 {

		t.Fatal("no Chromium is running")

	}

	return pid

}

// exited is true for a pid that is gone, or a zombie waiting to be reaped.
func exited(pid int) bool {

	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")

	return err != nil || strings.Contains(string(stat), ") Z ")

}

func TestDeadChromiumIsReplacedOnNextUse(t *testing.T) {

	linuxOnly(t)

	url := site(t, func(w http.ResponseWriter, r *http.Request) { servePage(w, "Alive", "") })
	cwd := t.TempDir()
	ctx := context.Background()

	if text, err := browser.Open(ctx, cwd, url+"/"); err != nil || !strings.Contains(text, "Alive") {

		t.Fatalf("%v %s", err, text)

	}

	syscall.Kill(-pidOf(t, cwd), syscall.SIGKILL)
	time.Sleep(500 * time.Millisecond)

	// the tab it had comes back with the new one
	if text, err := browser.Look(ctx, cwd); err != nil || !strings.Contains(text, "Alive") {

		t.Fatalf("%v %s", err, text)

	}

}

func TestFrozenChromiumIsKilledAndAnotherCarriesOn(t *testing.T) {

	linuxOnly(t)

	url := site(t, func(w http.ResponseWriter, r *http.Request) { servePage(w, "Fine", "") })
	frozen, other := t.TempDir(), t.TempDir()
	ctx := context.Background()

	for _, workspace := range []string{frozen, other} {

		if _, err := browser.Open(ctx, workspace, url+"/"); err != nil {

			t.Fatal(err)

		}

	}

	pid := pidOf(t, frozen)

	syscall.Kill(-pid, syscall.SIGSTOP)

	started := time.Now()
	stuck := make(chan error, 1)

	go func() {

		_, err := browser.Look(ctx, frozen)
		stuck <- err

	}()

	if text, err := browser.Look(ctx, other); err != nil || !strings.Contains(text, "Fine") {

		t.Fatalf("%v %s", err, text)

	}

	if err := <-stuck; err == nil || !strings.Contains(err.Error(), "restarted") {

		t.Fatalf("frozen look %v", err)

	}

	if time.Since(started) > 25*time.Second {

		t.Fatal("a frozen browser must not be waited on")

	}

	until(t, func() bool { return exited(pid) })

	if text, err := browser.Open(ctx, frozen, url+"/"); err != nil || !strings.Contains(text, "Fine") {

		t.Fatalf("%v %s", err, text)

	}

}

func TestPopupBecomesThePageAndClosingGoesBack(t *testing.T) {

	linuxOnly(t)

	url := site(t, func(w http.ResponseWriter, r *http.Request) {

		if r.URL.Path == "/pop" {

			servePage(w, "Popup", `<button onclick="window.close()">Done</button>`)

			return

		}

		servePage(w, "Opener", `<a href="/pop" target="_blank">Pop</a>`)

	})

	cwd := t.TempDir()
	ctx := context.Background()
	opened, _ := browser.Open(ctx, cwd, url+"/")
	popup, err := browser.Click(ctx, cwd, refFor(t, opened, "link"))

	if err != nil || !strings.Contains(popup, "Popup") {

		t.Fatalf("%v %s", err, popup)

	}

	browser.Click(ctx, cwd, refFor(t, popup, "button"))
	time.Sleep(500 * time.Millisecond)

	if text, err := browser.Look(ctx, cwd); err != nil || !strings.Contains(text, "Opener") {

		t.Fatalf("%v %s", err, text)

	}

}

func TestDeletingAnAgentMidTakeOverLetsItsActionGo(t *testing.T) {

	linuxOnly(t)

	url := site(t, func(w http.ResponseWriter, r *http.Request) { servePage(w, "Held", "") })
	cwd := t.TempDir()

	browser.Open(context.Background(), cwd, url+"/")
	browser.TakeOver(cwd, nil)

	waiting := make(chan struct{})

	go func() {

		browser.Look(context.Background(), cwd)
		close(waiting)

	}()

	time.Sleep(300 * time.Millisecond)
	browser.Close(cwd, true)

	select {

	case <-waiting:

	case <-time.After(20 * time.Second):

		t.Fatal("the waiting action never went")

	}

}
