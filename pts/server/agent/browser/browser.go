// Package browser gives each agent a real Chromium on its own profile, shared with the user who can watch or take it over.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"boombox/agent/browser/proc"
	"boombox/config"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/cdproto/target"

	browserdomain "github.com/chromedp/cdproto/browser"
)

var idleFor = config.Millis("PTS_BROWSER_IDLE_MS", 10*time.Minute)

const (
	actionWait = 15 * time.Second
	loadWait   = 30 * time.Second
	inputWait  = 10 * time.Second

	// an element from the outline is clickable within a moment or covered; waiting longer only stalls the agent
	elementWait = 5 * time.Second

	// most pages finish their own fetches within a few seconds; waiting longer only stalls the agent
	quietWait = 3 * time.Second

	// a take-over may first reload a suspended tab
	landWait = loadWait + actionWait

	// a call still unanswered this long past its own timeout means Chromium, or the pipe to it, is gone
	stallWait = 5 * time.Second

	pingWait = 3 * time.Second

	// so a dead Chromium that someone only watches is noticed too
	heartbeatEvery = 30 * time.Second
	heartbeatPing  = 10 * time.Second

	maxSnapshot = 16_000

	// taps on a page that has stopped answering are refused rather than replayed long after
	maxPending = 8

	// where a take-over lands when the agent has not opened anything yet
	startURL = "https://duckduckgo.com"

	// acking a frame late is what paces the stream
	frameDelay = 150 * time.Millisecond

	// a page's cache otherwise grows with every site the agent visits, on a disk the VPS may not have to spare
	diskCacheBytes = 50 * 1024 * 1024

	// each agent is its own Chromium, and a site's iframes otherwise become a process each
	renderers = 4

	// a browser nobody is watching or driving gives the CPU back, so the one in use stays quick
	restFor  = 5 * time.Second
	slowRate = 6

	// past maxTabs the least recently used tab closes; past liveTabs it is suspended to its URL, so memory stays flat
	maxTabs  = 10
	liveTabs = 3

	// a worker's first fetch can beat the first override; the second one is what it sees
	rewriteDelay = 100 * time.Millisecond
)

// a real window instead of an emulated viewport, so inner and outer sizes look like a desktop browser's
var window = Size{Width: 1280, Height: 800}

const screen = "{1920x1080}"

var webURL = regexp.MustCompile(`(?i)^https?://`)

var errGone = errors.New("gone")

// Viewer is someone looking at an agent's browser; a nil frame means the page is blank.
type Viewer struct {
	Frame func(jpeg []byte)
	Fail  func(message string)
	Tabs  func(tabs []TabView)
}

// TabView is a tab as the app shows it; Live is false while it is suspended to its URL.
type TabView struct {
	ID     int    `json:"id"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	Active bool   `json:"active"`
	Live   bool   `json:"live"`
}

type TabAction string

// Input is one gesture from the user's screen; coordinates are fractions of the page, 0 to 1.
type Input struct {
	Kind string

	X   float64
	Y   float64
	ToX float64
	ToY float64
	DX  float64
	DY  float64

	Text string
	Key  string
}

type Size struct {
	Width  int
	Height int
}

// Reason is the first line of an error, which is all a viewer needs.
func Reason(err error) string {

	first, _, _ := strings.Cut(err.Error(), "\n")

	return first

}

// tab is one of an agent's tabs; it outlives any one Chromium, and page is nil while it is suspended.
type tab struct {
	id    int
	url   string
	title string

	page *tabPage

	// opener is the tab active when this one opened, so closing a sign-in popup goes back to it
	opener int

	used time.Time
}

// chrome is one running Chromium on the agent's own profile.
type chrome struct {
	proc *process
	born time.Time
	dead bool

	// page is the active tab's page: what the agent and viewers see
	page *tabPage

	// claims are suspended tabs waiting for the page made for them; any other new page is a tab the site opened
	claims []*tab

	pages    map[target.ID]*tabPage
	sessions map[target.SessionID]*tabPage
	adopted  map[target.ID]chan struct{}

	cast *tabPage

	// full is nil until the first request, then false once the browser has been asked to yield
	full       *bool
	foreground *bool
	paceMu     sync.Mutex

	stopHeartbeat chan struct{}
}

// Browser is an agent's browser as the agent and the user share it; it outlives any one Chromium.
type Browser struct {
	workspace string

	mu sync.Mutex

	tabs    []*tab
	active  int
	lastTab int

	// announced and saved are what viewers and the tabs file were last given, so a navigation that changes nothing sends nothing
	announced string
	saved     string

	chrome    *chrome
	launching *launch

	// closing is a Chromium still closing, which holds the profile; a second one on it would hand off to it and exit
	closing chan struct{}

	viewers map[*Viewer]bool

	frame  []byte
	framed bool

	// hold is set while the user has the browser; the agent's actions wait for it
	hold chan struct{}

	// phone is the holder's screen, when they took over from one
	phone *Size

	// touched is the user changing the page since the agent last saw it, so the agent's refs are stale
	touched bool

	// pins are handoffs waiting on the user; the page they need must still be there when they arrive
	pins int

	// opening is the agent's <open> loading; until it commits the page still reads about:blank
	opening bool

	lane    sync.Mutex
	pending int
	acting  int

	idle *time.Timer
	nap  *time.Timer
}

type launch struct {
	done   chan struct{}
	chrome *chrome
	err    error
}

var (
	browsersMu sync.Mutex
	browsers   = map[string]*Browser{}

	// zones holds each user's time zone, keyed by the folder their agents' workspaces sit in
	zonesMu sync.Mutex
	zones   = map[string]string{}
)

// profileOf sits beside the workspace, never in it: Chromium runs outside the sandbox and would follow a link the agent planted.
func profileOf(workspace string) string {

	return workspace + ".browser"

}

func tabsFile(b *Browser) string {

	return filepath.Join(profileOf(b.workspace), "Tabs.json")

}

func (b *Browser) activeTab() *tab {

	for _, one := range b.tabs {

		if one.id == b.active {

			return one

		}

	}

	return nil

}

func (b *Browser) tabOfPage(p *tabPage) *tab {

	for _, one := range b.tabs {

		if one.page == p && p != nil {

			return one

		}

	}

	return nil

}

func (b *Browser) tabByID(id int) *tab {

	for _, one := range b.tabs {

		if one.id == id {

			return one

		}

	}

	return nil

}

func (b *Browser) views() []TabView {

	views := make([]TabView, len(b.tabs))

	for i, one := range b.tabs {

		views[i] = TabView{ID: one.id, Title: one.title, URL: one.url, Active: one.id == b.active, Live: one.page != nil}

	}

	return views

}

func (b *Browser) running() bool {

	return b.chrome != nil || b.launching != nil

}

func zoneOf(workspace string) string {

	zonesMu.Lock()
	defer zonesMu.Unlock()

	for scope, zone := range zones {

		if strings.HasPrefix(workspace, scope+string(filepath.Separator)) {

			return zone

		}

	}

	return ""

}

func browserOf(workspace string) *Browser {

	browsersMu.Lock()
	defer browsersMu.Unlock()

	b := browsers[workspace]

	if b == nil {

		// restored before anyone else can see it, so its lock is never taken under browsersMu
		b = &Browser{workspace: workspace, viewers: map[*Viewer]bool{}}
		b.restore()
		browsers[workspace] = b

	}

	return b

}

func existing(workspace string) *Browser {

	browsersMu.Lock()
	defer browsersMu.Unlock()

	return browsers[workspace]

}

type savedTabs struct {
	Active int `json:"active"`

	Tabs []struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	} `json:"tabs"`
}

// restore brings back the tabs the last Chromium left; only web URLs come back from it.
func (b *Browser) restore() {

	data, err := os.ReadFile(tabsFile(b))

	if err != nil {

		return

	}

	var saved savedTabs

	if json.Unmarshal(data, &saved) != nil {

		return

	}

	for i, one := range saved.Tabs {

		if i >= maxTabs || !webURL.MatchString(one.URL) {

			continue

		}

		restored := b.addTab(one.URL, 0)
		restored.title = string([]rune(one.Title)[:min(utf8.RuneCountInString(one.Title), 200)])

	}

	if saved.Active >= 0 && saved.Active < len(b.tabs) {

		b.active = b.tabs[saved.Active].id

	} else if len(b.tabs) > 0 {

		b.active = b.tabs[len(b.tabs)-1].id

	}

}

func (b *Browser) addTab(url string, opener int) *tab {

	b.lastTab++

	added := &tab{id: b.lastTab, url: url, opener: opener, used: time.Now()}
	b.tabs = append(b.tabs, added)

	return added

}

// announce tells viewers what changed in the tab strip, and writes it down so a new Chromium can bring the tabs back.
func (b *Browser) announce() {

	views := b.views()
	encoded, _ := json.Marshal(views)

	if string(encoded) != b.announced {

		b.announced = string(encoded)

		for viewer := range b.viewers {

			if viewer.Tabs != nil {

				viewer.Tabs(views)

			}

		}

	}

	saved := savedTabs{Active: -1}

	for i, one := range b.tabs {

		if one.id == b.active {

			saved.Active = i

		}

		saved.Tabs = append(saved.Tabs, struct {
			URL   string `json:"url"`
			Title string `json:"title"`
		}{URL: one.url, Title: one.title})

	}

	data, _ := json.Marshal(saved)

	if string(data) == b.saved || existing(b.workspace) != b {

		return

	}

	b.saved = string(data)

	// no profile yet, or the agent is being deleted
	os.WriteFile(tabsFile(b), data, 0o600)

}

func (b *Browser) tell(message string) {

	b.mu.Lock()
	defer b.mu.Unlock()

	for viewer := range b.viewers {

		viewer.Fail(message)

	}

}

func launchArgs(b *Browser, full bool, id *identity) []string {

	args := append([]string{}, baseArgs...)

	args = append(args,

		fmt.Sprintf("--window-size=%d,%d", window.Width, window.Height),
		"--screen-info="+screen,
		"--disk-cache-size="+strconv.Itoa(diskCacheBytes),
		"--renderer-process-limit="+strconv.Itoa(renderers),

		// headless and the debugging pipe each enable AutomationControlled, which is what makes navigator.webdriver true
		"--disable-blink-features=AutomationControlled",
	)

	// behind a proxy, WebRTC and DNS would still go out from this machine; loopback goes through it too, so no page reaches this machine's services
	if current := currentProxy(); current != nil {

		args = append(args, "--proxy-server="+current.server, "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE "+current.host)

	}

	// the flag reaches workers and the first packet; the shell blanks client hints when given one, which is louder than the headless token
	if full && id != nil && id.ua != "" {

		args = append(args, "--user-agent="+id.ua)

		if tags := languageTags(id.acceptLanguage); tags != "" {

			args = append(args, "--accept-lang="+tags)

		}

	}

	return append(args, "--user-data-dir="+profileOf(b.workspace), "about:blank")

}

var root = []target.FilterEntry{{Type: "service_worker"}, {Type: "shared_worker"}, {Type: "page"}, {Exclude: true}}

var children = []target.FilterEntry{{Type: "iframe"}, {Type: "worker"}, {Exclude: true}}

func autoAttachParams(filter []target.FilterEntry) target.SetAutoAttachParams {

	flatten := true
	entries := make(target.Filter, len(filter))

	for i, entry := range filter {

		entries[i].Exclude = entry.Exclude
		entries[i].Type = entry.Type

	}

	return target.SetAutoAttachParams{AutoAttach: true, WaitForDebuggerOnStart: true, Flatten: &flatten, Filter: entries}

}

func autoAttach(ctx context.Context, s *session, filter []target.FilterEntry) error {

	_, err := call(ctx, s, target.SetAutoAttach, autoAttachParams(filter))

	return err

}

// stamp puts the identity on a target before it is let run, or its first request still says HeadlessChrome.
func stamp(s *session, id *identity, waiting, deep bool) {

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// a paused target answers nothing until it runs, so the override and the resume go out together, in order
	commands := identityCommands(id, deep)

	if waiting {

		commands = append(commands, command{method: "Runtime.runIfWaitingForDebugger"})

	}

	s.batch(ctx, commands...)

	if deep {

		time.Sleep(rewriteDelay)
		s.batch(ctx, identityCommands(id, deep)...)

	}

}

func (b *Browser) start() (*chrome, error) {

	binary, full, err := findChromium()

	if err != nil {

		return nil, err

	}

	var id *identity

	if full {

		id, _ = browserIdentity()

	}

	if err := os.MkdirAll(profileOf(b.workspace), 0o700); err != nil {

		return nil, err

	}

	env := os.Environ()

	// TZ rather than a per-page override, which service workers never get
	if zone := zoneOf(b.workspace); zone != "" {

		env = append(env, "TZ="+zone)

	}

	proc, err := startChromium(binary, launchArgs(b, full, id), env)

	if err != nil {

		return nil, err

	}

	running := &chrome{proc: proc, born: time.Now(), pages: map[target.ID]*tabPage{}, sessions: map[target.SessionID]*tabPage{}, adopted: map[target.ID]chan struct{}{}, stopHeartbeat: make(chan struct{})}

	b.mu.Lock()

	if first := b.activeTab(); first != nil {

		running.claims = []*tab{first}

	} else if len(b.tabs) > 0 {

		running.claims = []*tab{b.tabs[len(b.tabs)-1]}

	}

	b.mu.Unlock()

	rootSession := proc.root

	onEvent(rootSession, target.AttachedToTarget, func(event target.EventAttachedToTarget) {

		if event.TargetInfo == nil {

			return

		}

		attached := &session{c: proc.conn, id: event.SessionID}

		switch event.TargetInfo.Type {

		case "page":

			go b.adopt(running, attached, event.TargetInfo, event.WaitingForDebugger, id)

		case "service_worker", "shared_worker":

			go stamp(attached, id, event.WaitingForDebugger, true)

		default:

			if event.WaitingForDebugger {

				go call(context.Background(), attached, runtime.RunIfWaitingForDebugger, cdp.Empty{})

			}

		}

	})

	onEvent(rootSession, target.DetachedFromTarget, func(event target.EventDetachedFromTarget) {

		b.mu.Lock()
		closed := running.sessions[event.SessionID]
		b.mu.Unlock()

		proc.conn.dropSession(event.SessionID)

		if closed != nil {

			go b.pageClosed(running, closed)

		}

	})

	onEvent(rootSession, target.TargetCrashed, func(event target.EventTargetCrashed) {

		go call(context.Background(), rootSession, target.CloseTarget, target.CloseTargetParams{TargetID: event.TargetID})

	})

	ctx, cancel := context.WithTimeout(context.Background(), loadWait)
	defer cancel()

	if _, err := call(ctx, rootSession, target.SetDiscoverTargets, target.SetDiscoverTargetsParams{Discover: true}); err != nil {

		proc.kill()

		return nil, proc.failure(err.Error())

	}

	if err := autoAttach(ctx, rootSession, root); err != nil {

		proc.kill()

		return nil, proc.failure(err.Error())

	}

	// the first page Chromium opens is adopted through the auto-attach above
	for {

		b.mu.Lock()
		ready := running.page != nil
		b.mu.Unlock()

		if ready {

			break

		}

		select {

		case <-proc.exited:

			return nil, proc.failure("The browser closed as soon as it started")

		case <-ctx.Done():

			proc.kill()

			return nil, errors.New("The browser did not start in time")

		case <-time.After(20 * time.Millisecond):

		}

	}

	go func() {

		<-proc.exited
		b.gone(running)

	}()

	go b.heartbeat(running)

	return running, nil

}

func (b *Browser) heartbeat(running *chrome) {

	ticker := time.NewTicker(heartbeatEvery)
	defer ticker.Stop()

	for {

		select {

		case <-running.stopHeartbeat:

			return

		case <-ticker.C:

			b.mu.Lock()
			dead := running.dead
			b.mu.Unlock()

			if !dead && !alive(running, heartbeatPing) {

				b.restart(running, "missed a heartbeat")

			}

		}

	}

}

// adoptedSignal is closed once the page made for targetID is shown; whoever made the page waits on it.
func (c *chrome) adoptedSignal(targetID target.ID) chan struct{} {

	signal := c.adopted[targetID]

	if signal == nil {

		signal = make(chan struct{})
		c.adopted[targetID] = signal

	}

	return signal

}

// adopt makes every page a tab: a claimed suspended one when it was made for one, a new tab when the site opened it.
func (b *Browser) adopt(running *chrome, s *session, info *target.Info, waiting bool, id *identity) {

	ctx, cancel := context.WithTimeout(context.Background(), actionWait)
	defer cancel()

	created := newTabPage(info.TargetID, s, info.URL)

	created.listen(func(url string) {

		if isBlank(url) {

			return

		}

		b.mu.Lock()
		defer b.mu.Unlock()

		if owner := b.tabOfPage(created); owner != nil {

			owner.url = url
			b.announce()

		}

	})

	// Chromium's target info names a page by its host until the title is read, so the title comes from the document itself
	retitle := func() {

		go func() {

			ctx, cancel := context.WithTimeout(context.Background(), actionWait)
			defer cancel()

			title := created.title(ctx)

			b.mu.Lock()
			defer b.mu.Unlock()

			if owner := b.tabOfPage(created); owner != nil && owner.title != title {

				owner.title = title
				b.announce()

			}

		}()

	}

	onEvent(s, page.DomContentEventFired, func(page.EventDomContentEventFired) { retitle() })
	onEvent(s, page.LoadEventFired, func(page.EventLoadEventFired) { retitle() })

	onEvent(s, page.ScreencastFrame, func(event page.EventScreencastFrame) {

		go func() {

			time.Sleep(frameDelay)
			call(context.Background(), s, page.ScreencastFrameAck, page.ScreencastFrameAckParams{SessionID: event.SessionID})

		}()

		b.mu.Lock()
		defer b.mu.Unlock()

		if running.cast != created {

			return

		}

		b.framed = true
		b.frame = event.Data

		if isBlank(created.URL()) {

			b.frame = nil

		}

		for viewer := range b.viewers {

			viewer.Frame(b.frame)

		}

	})

	// a dedicated worker or a cross-site frame is a child of the page, not of the browser, so the page session is what hears it
	onEvent(s, target.AttachedToTarget, func(event target.EventAttachedToTarget) {

		child := &session{c: s.c, id: event.SessionID}
		deep := event.TargetInfo != nil && event.TargetInfo.Type == "worker"

		go stamp(child, id, event.WaitingForDebugger, deep)

	})

	// a paused page answers nothing until it runs, so its setup and its resume go out together, in order
	commands := append(created.prepareCommands(), command{method: "Target.setAutoAttach", params: autoAttachParams(children)})
	commands = append(commands, identityCommands(id, false)...)

	if waiting {

		commands = append(commands, command{method: "Runtime.runIfWaitingForDebugger"})

	}

	s.batch(ctx, commands...)

	b.mu.Lock()

	if running.dead {

		b.mu.Unlock()

		return

	}

	var claimed *tab

	if len(running.claims) > 0 {

		claimed = running.claims[0]
		running.claims = running.claims[1:]

	}

	if claimed == nil {

		claimed = b.addTab(info.URL, b.active)

	}

	claimed.page = created
	running.pages[info.TargetID] = created
	running.sessions[s.id] = created
	signal := running.adoptedSignal(info.TargetID)
	b.mu.Unlock()

	b.show(ctx, running, created)
	close(signal)

}

// pageClosed lets a closed page go; a tab suspended or closed on purpose has let go of it already.
func (b *Browser) pageClosed(running *chrome, closed *tabPage) {

	closed.markClosed()

	// a dying Chromium closes its pages just before it exits; waiting a moment lets that mark it dead, which suspends the tabs instead
	time.Sleep(50 * time.Millisecond)

	b.mu.Lock()
	delete(running.pages, closed.targetID)
	delete(running.sessions, closed.s.id)
	owner := b.tabOfPage(closed)
	dead := running.dead
	b.mu.Unlock()

	if owner != nil && !dead {

		ctx, cancel := context.WithTimeout(context.Background(), landWait)
		defer cancel()

		b.closeTab(ctx, running, owner)

	}

}

// show makes the page the one the agent and viewers see, fitted to whoever holds it; the tab it replaces keeps running, slowly.
func (b *Browser) show(ctx context.Context, running *chrome, shown *tabPage) {

	b.mu.Lock()
	before := running.page
	running.page = shown

	if owner := b.tabOfPage(shown); owner != nil {

		b.active = owner.id
		owner.used = time.Now()

	}

	rate := 1.0

	if running.full != nil && !*running.full {

		rate = slowRate

	}

	phone := b.phone
	b.mu.Unlock()

	shown.throttle(ctx, rate)

	if before != nil && before != shown && !before.isClosed() {

		go before.throttle(context.Background(), slowRate)

	}

	b.trim()

	if phone != nil {

		shown.fit(ctx, phone)

	}

	b.mu.Lock()
	b.announce()
	b.mu.Unlock()

	b.cast(ctx, running)

}

// focus shows the tab, making it a page first if it is suspended.
func (b *Browser) focus(ctx context.Context, running *chrome, chosen *tab) error {

	b.mu.Lock()
	existing := chosen.page
	b.mu.Unlock()

	if existing != nil {

		b.show(ctx, running, existing)

		return nil

	}

	b.mu.Lock()
	running.claims = append(running.claims, chosen)
	b.mu.Unlock()

	created, err := call(ctx, running.proc.root, target.CreateTarget, target.CreateTargetParams{URL: "about:blank"})

	if err != nil {

		return err

	}

	b.mu.Lock()
	signal := running.adoptedSignal(created.TargetID)
	b.mu.Unlock()

	select {

	case <-signal:

		return nil

	case <-ctx.Done():

		return ctx.Err()

	}

}

// closeTab goes back from the active tab to the one it was opened from, else the newest; the last tab is replaced by a blank one.
func (b *Browser) closeTab(ctx context.Context, running *chrome, doomed *tab) {

	b.mu.Lock()
	closing := doomed.page
	doomed.page = nil
	kept := b.tabs[:0]

	for _, one := range b.tabs {

		if one != doomed {

			kept = append(kept, one)

		}

	}

	b.tabs = kept

	var next *tab

	if b.active == doomed.id {

		next = b.tabByID(doomed.opener)

		if next == nil && len(b.tabs) > 0 {

			next = b.tabs[len(b.tabs)-1]

		}

		if next == nil {

			next = b.addTab("about:blank", 0)

		}

		b.active = next.id

	}

	alive := running != nil && !running.dead
	b.mu.Unlock()

	// before the old page goes, so Chromium is never left without a window
	if next != nil && alive {

		b.focus(ctx, running, next)

	}

	b.mu.Lock()
	b.announce()
	b.mu.Unlock()

	if closing != nil && alive {

		call(ctx, running.proc.root, target.CloseTarget, target.CloseTargetParams{TargetID: closing.targetID})

	}

}

// trim keeps the active tab and the tabs it was opened from live, for sign-in popups; the rest go by least recent use.
func (b *Browser) trim() {

	b.mu.Lock()

	running := b.chrome
	keep := map[*tab]bool{}

	for current := b.activeTab(); current != nil && !keep[current]; current = b.tabByID(current.opener) {

		keep[current] = true

	}

	rest := []*tab{}

	for _, one := range b.tabs {

		if !keep[one] {

			rest = append(rest, one)

		}

	}

	sort.SliceStable(rest, func(i, j int) bool { return rest[i].used.After(rest[j].used) })

	live := 0

	for one := range keep {

		if one.page != nil {

			live++

		}

	}

	doomed := []*tab{}
	suspended := []*tabPage{}

	for index, one := range rest {

		switch {

		case len(keep)+index >= maxTabs:

			doomed = append(doomed, one)

		case one.page != nil && live < liveTabs:

			live++

		case one.page != nil:

			suspended = append(suspended, one.page)
			one.page = nil

		}

	}

	b.mu.Unlock()

	if running == nil {

		return

	}

	for _, one := range doomed {

		go b.closeTab(context.Background(), running, one)

	}

	for _, gone := range suspended {

		go call(context.Background(), running.proc.root, target.CloseTarget, target.CloseTargetParams{TargetID: gone.targetID})

	}

}

// current is the active tab's page; one suspended when its Chromium closed loads its URL again the first time it is needed.
func (b *Browser) current(ctx context.Context, running *chrome) *tabPage {

	b.mu.Lock()
	shown := running.page
	owner := b.tabOfPage(shown)
	reload := owner != nil && !b.opening && isBlank(shown.URL()) && webURL.MatchString(owner.url)
	address := ""

	if owner != nil {

		address = owner.url

	}

	b.mu.Unlock()

	if reload {

		shown.goTo(ctx, address)

	}

	return shown

}

// cast streams the shown page while anyone watches it, and nothing otherwise.
func (b *Browser) cast(ctx context.Context, running *chrome) error {

	b.mu.Lock()
	shown := running.page
	var want *tabPage

	if len(b.viewers) > 0 {

		want = shown

	}

	if running.cast == want {

		b.mu.Unlock()

		return nil

	}

	old := running.cast
	running.cast = want
	b.mu.Unlock()

	if old != nil && !old.isClosed() {

		go call(context.Background(), old.s, page.StopScreencast, cdp.Empty{})

	}

	if want == nil {

		return nil

	}

	quality := int64(60)

	_, err := call(ctx, want.s, page.StartScreencast, page.StartScreencastParams{Format: page.StartScreencastFormatJpeg, Quality: &quality, MaxWidth: int64(window.Width), MaxHeight: int64(window.Height)})

	return err

}

// alive asks the browser process itself, so a slow page is told from a Chromium that is gone; only silence counts.
func alive(running *chrome, wait time.Duration) bool {

	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()

	_, err := call(ctx, running.proc.root, browserdomain.GetVersion, cdp.Empty{})

	return !errors.Is(err, context.DeadlineExceeded)

}

// restart kills a Chromium that stopped answering; whoever still looks at or holds the browser gets a fresh one.
func (b *Browser) restart(running *chrome, why string) {

	url := ""

	b.mu.Lock()

	if running.page != nil {

		url = running.page.URL()

	}

	closing := make(chan struct{})
	b.closing = closing
	b.mu.Unlock()

	log.Printf("browser: Chromium %d of %s %s on %s; killing it", running.proc.pid, b.workspace, why, url)
	b.tell("The browser stopped responding, so it was restarted")

	go func() {

		running.proc.kill()
		close(closing)

	}()

	b.gone(running)

}

// forget marks the Chromium dead and suspends its tabs to their URLs; true when it was the browser's running one.
func (b *Browser) forget(running *chrome) bool {

	b.mu.Lock()
	defer b.mu.Unlock()

	if !running.dead {

		running.dead = true
		close(running.stopHeartbeat)

	}

	for _, one := range b.tabs {

		if one.page != nil && running.pages[one.page.targetID] == one.page {

			one.page = nil

		}

	}

	b.announce()

	if b.chrome != running {

		return false

	}

	b.chrome = nil
	b.frame = nil
	b.framed = false

	return true

}

// gone is Chromium exiting, crashing or being killed; one that dies as it starts would otherwise relaunch in a loop.
func (b *Browser) gone(running *chrome) {

	if b.forget(running) && time.Since(running.born) > 10*time.Second {

		b.reland()

	}

}

// chromeOf is the running Chromium, launched on first use; a launch that hangs is given up on, and killed if it ever finishes.
func (b *Browser) chromeOf() (*chrome, error) {

	b.mu.Lock()
	closing := b.closing
	b.mu.Unlock()

	if closing != nil {

		<-closing

	}

	b.mu.Lock()

	if b.chrome != nil {

		running := b.chrome
		b.mu.Unlock()

		return running, nil

	}

	pending := b.launching

	if pending == nil {

		pending = &launch{done: make(chan struct{})}
		b.launching = pending

		go func() {

			result := make(chan struct{})

			var started *chrome
			var err error

			go func() {

				started, err = b.start()
				close(result)

			}()

			select {

			case <-result:

			case <-time.After(loadWait + stallWait):

				err = errors.New("The browser did not start in time")

				go func() {

					<-result

					if started != nil {

						b.forget(started)
						started.proc.kill()

					}

				}()

			}

			b.mu.Lock()

			if err == nil {

				b.chrome = started

			}

			pending.chrome, pending.err = started, err

			if b.launching == pending {

				b.launching = nil

			}

			b.mu.Unlock()
			close(pending.done)

		}()

	}

	b.mu.Unlock()

	<-pending.done

	return pending.chrome, pending.err

}

// busy is someone looking, holding, signing in, or a call in flight.
func (b *Browser) busy() bool {

	return len(b.viewers) > 0 || b.hold != nil || b.pending > 0 || b.pins > 0 || b.opening || b.acting > 0

}

// pace runs the browser at full speed, or yields it; background Chromiums otherwise make the one in front sluggish.
func (b *Browser) pace(running *chrome, full bool) {

	running.paceMu.Lock()
	defer running.paceMu.Unlock()

	b.mu.Lock()

	if running.dead || b.chrome != running || (running.full != nil && *running.full == full) || (!full && b.busy()) {

		b.mu.Unlock()

		return

	}

	// set first, so a tab shown meanwhile gets the new rate too
	running.full = &full

	pages := []*tabPage{}

	for _, one := range running.pages {

		pages = append(pages, one)

	}

	shown := running.page
	b.mu.Unlock()

	if running.foreground == nil || *running.foreground != full {

		running.foreground = &full
		level := 10

		if full {

			level = 0

		}

		proc.Renice(running.proc.pid, level)

	}

	ctx, cancel := context.WithTimeout(context.Background(), actionWait)
	defer cancel()

	for _, one := range pages {

		rate := float64(slowRate)

		// a tab in the background stays slow either way
		if full && one == shown {

			rate = 1

		}

		one.throttle(ctx, rate)

	}

}

func (b *Browser) wake(running *chrome) {

	b.mu.Lock()

	if b.nap != nil {

		b.nap.Stop()

	}

	b.mu.Unlock()

	b.pace(running, true)

}

func (b *Browser) rest() {

	b.mu.Lock()
	defer b.mu.Unlock()

	if b.nap != nil {

		b.nap.Stop()

	}

	if b.busy() || b.chrome == nil {

		return

	}

	b.nap = time.AfterFunc(restFor, func() {

		b.mu.Lock()
		running := b.chrome
		idle := running != nil && !b.busy() && !running.dead
		b.mu.Unlock()

		if idle {

			b.pace(running, false)

		}

	})

}

// touch restarts the idle clock: idle is nobody using, watching, holding or waiting on the browser for idleFor.
func (b *Browser) touch() {

	b.mu.Lock()
	defer b.mu.Unlock()

	if b.idle != nil {

		b.idle.Stop()

	}

	b.idle = time.AfterFunc(idleFor, func() { Close(b.workspace, false) })

}

// act is every use of the browser: bounded, and a Chromium that stopped answering is killed, not waited on.
func act[T any](b *Browser, limit time.Duration, work func(ctx context.Context, running *chrome) (T, error)) (T, error) {

	var zero T

	b.touch()

	b.mu.Lock()
	b.acting++
	b.mu.Unlock()

	defer func() {

		b.mu.Lock()
		b.acting--
		b.mu.Unlock()

		b.touch()
		b.rest()

	}()

	running, err := b.chromeOf()

	if err != nil {

		return zero, err

	}

	b.wake(running)

	ctx, cancel := context.WithTimeout(context.Background(), limit+stallWait)
	defer cancel()

	value, err := work(ctx, running)

	if err == nil {

		return value, nil

	}

	// a timeout is a slow page or a gone Chromium; only the second is worth a restart
	stalled := errors.Is(err, context.DeadlineExceeded)

	if stalled || (isTimeout(err) && !alive(running, pingWait)) {

		b.mu.Lock()
		dead := running.dead
		b.mu.Unlock()

		if !dead {

			why := "stopped answering"

			if stalled {

				why = "left a call unanswered"

			}

			b.restart(running, why)

		}

		return zero, errors.New("The browser stopped responding, so it was restarted. Open the page again.")

	}

	b.mu.Lock()
	dead := running.dead
	b.mu.Unlock()

	if dead || errors.Is(err, errClosed) {

		return zero, errors.New("The browser closed unexpectedly. Open the page again.")

	}

	return zero, err

}

// enqueue lands the user's taps and keys in the order they were made; a backlog on a slow page is refused, not replayed later.
func (b *Browser) enqueue(work func() error) error {

	b.mu.Lock()

	if b.pending >= maxPending {

		b.mu.Unlock()

		return errors.New("The page is still busy with your last taps")

	}

	b.pending++
	b.mu.Unlock()

	defer func() {

		b.mu.Lock()
		b.pending--
		b.mu.Unlock()

		b.rest()

	}()

	b.lane.Lock()
	defer b.lane.Unlock()

	return work()

}

// shut lets Chromium write the profile's logins out; one that will not close in time is killed.
func (b *Browser) shut() {

	b.mu.Lock()

	if b.idle != nil {

		b.idle.Stop()

	}

	if b.nap != nil {

		b.nap.Stop()

	}

	running := b.chrome
	pending := b.launching
	b.mu.Unlock()

	if running == nil && pending != nil {

		<-pending.done
		running = pending.chrome

	}

	if running == nil {

		return

	}

	b.forget(running)

	closing := make(chan struct{})

	b.mu.Lock()
	b.closing = closing
	b.mu.Unlock()

	running.proc.stop(5 * time.Second)
	close(closing)

	b.mu.Lock()

	if b.closing == closing {

		b.closing = nil

	}

	b.mu.Unlock()

}

// Close shuts the workspace's browser; force is for a deleted agent, whose browser nobody can use any more.
func Close(workspace string, force bool) error {

	b := existing(workspace)

	if b == nil {

		return nil

	}

	b.mu.Lock()
	inUse := len(b.viewers) > 0 || b.hold != nil || b.pins > 0
	b.mu.Unlock()

	// someone looking at, holding or about to be handed the browser counts as using it
	if !force && inUse {

		b.touch()

		return nil

	}

	if force {

		browsersMu.Lock()
		delete(browsers, workspace)
		browsersMu.Unlock()

		b.mu.Lock()

		if b.hold != nil {

			close(b.hold)
			b.hold = nil

		}

		b.viewers = map[*Viewer]bool{}
		b.mu.Unlock()

	}

	b.shut()

	return nil

}

// CloseAll writes every browser's logins to its profile; the server calls it on the way out.
func CloseAll() {

	browsersMu.Lock()
	all := make([]*Browser, 0, len(browsers))

	for _, b := range browsers {

		all = append(all, b)

	}

	browsersMu.Unlock()

	var wg sync.WaitGroup

	for _, b := range all {

		wg.Add(1)

		go func() {

			defer wg.Done()

			b.shut()

		}()

	}

	wg.Wait()

}

// relaunch closes every running Chromium, or those under scope, so the next one starts with the new settings and its tabs come back.
func relaunch(scope string) {

	browsersMu.Lock()
	all := []*Browser{}

	for _, b := range browsers {

		if scope == "" || strings.HasPrefix(b.workspace, scope+string(filepath.Separator)) {

			all = append(all, b)

		}

	}

	browsersMu.Unlock()

	var wg sync.WaitGroup

	for _, b := range all {

		b.mu.Lock()
		running := b.running()
		b.mu.Unlock()

		if !running {

			continue

		}

		wg.Add(1)

		go func() {

			defer wg.Done()

			b.shut()
			b.reland()

		}()

	}

	wg.Wait()

}

// reland gives whoever still looks at or holds the browser a fresh one at once.
func (b *Browser) reland() {

	b.mu.Lock()
	wanted := len(b.viewers) > 0 || b.hold != nil
	b.mu.Unlock()

	if !wanted {

		return

	}

	go func() {

		if _, err := act(b, landWait, func(ctx context.Context, running *chrome) (struct{}, error) { return struct{}{}, b.land(ctx, running) }); err != nil {

			b.tell(Reason(err))

		}

	}()

}

// land gives an empty browser somewhere to start when the user holds it.
func (b *Browser) land(ctx context.Context, running *chrome) error {

	b.mu.Lock()
	phone := b.phone
	shown := running.page
	b.mu.Unlock()

	shown.fit(ctx, phone)

	current := b.current(ctx, running)

	b.mu.Lock()
	start := b.hold != nil && !b.opening && isBlank(current.URL())
	b.mu.Unlock()

	if start {

		current.goTo(ctx, startURL)

	}

	return nil

}

// SetZone sets the time zone for every Chromium under scope, or this machine's for an empty one; running ones restart onto it.
func SetZone(scope, next string) error {

	if next == zoneOf(scope+string(filepath.Separator)) {

		return nil

	}

	zonesMu.Lock()

	if next == "" {

		delete(zones, scope)

	} else {

		zones[scope] = next

	}

	zonesMu.Unlock()

	relaunch(scope)

	return nil

}

// Warm probes the client hints at boot, not on the agent's first <open>; the probe launches a Chromium of its own.
func Warm() {

	go browserIdentity()

}

// Pinned keeps the browser open, on its current page, for as long as work runs.
func Pinned[T any](workspace string, work func() T) T {

	b := browserOf(workspace)

	b.mu.Lock()
	b.pins++
	running := b.chrome
	b.mu.Unlock()

	if running != nil {

		go b.wake(running)

	}

	defer func() {

		b.mu.Lock()
		b.pins--
		b.mu.Unlock()

		b.touch()
		b.rest()

	}()

	return work()

}

// Watch sends frames to the viewer until the returned func is called; a closed browser stays closed and shows as blank.
func Watch(workspace string, viewer Viewer) func() {

	b := browserOf(workspace)
	watching := &viewer

	b.mu.Lock()
	b.viewers[watching] = true
	running := b.running()

	// a static page sends no new frames, so a second viewer would otherwise see nothing
	if b.framed || !running {

		viewer.Frame(b.frame)

	}

	if viewer.Tabs != nil {

		viewer.Tabs(b.views())

	}

	b.mu.Unlock()

	if running {

		go func() {

			if _, err := act(b, actionWait, func(ctx context.Context, current *chrome) (struct{}, error) { return struct{}{}, b.cast(ctx, current) }); err != nil {

				viewer.Fail(Reason(err))

			}

		}()

	}

	return func() {

		b.mu.Lock()
		delete(b.viewers, watching)
		running := b.chrome
		nobody := len(b.viewers) == 0
		b.mu.Unlock()

		if nobody && running != nil {

			go func() {

				ctx, cancel := context.WithTimeout(context.Background(), actionWait)
				defer cancel()

				b.cast(ctx, running)

			}()

		}

		b.touch()
		b.rest()

	}

}

// TakeOver gives the user the browser; the agent's next browser action waits until they hand it back, and a phone gets a phone's layout.
func TakeOver(workspace string, size *Size) error {

	b := browserOf(workspace)
	clamp := func(value, limit int) int { return max(320, min(limit, value)) }

	b.mu.Lock()

	if b.hold == nil {

		b.hold = make(chan struct{})

	}

	b.phone = nil

	if size != nil {

		b.phone = &Size{Width: clamp(size.Width, window.Width), Height: clamp(size.Height, window.Height)}

	}

	b.mu.Unlock()

	return b.enqueue(func() error {

		_, err := act(b, landWait, func(ctx context.Context, running *chrome) (struct{}, error) { return struct{}{}, b.land(ctx, running) })

		return err

	})

}

func HandBack(workspace string) error {

	b := existing(workspace)

	if b == nil {

		return nil

	}

	b.mu.Lock()
	running := b.chrome
	phone := b.phone

	if b.hold != nil {

		close(b.hold)
		b.hold = nil

	}

	b.phone = nil
	pages := []*tabPage{}

	if running != nil {

		for _, one := range running.pages {

			pages = append(pages, one)

		}

	}

	b.mu.Unlock()

	if phone != nil && running != nil {

		b.enqueue(func() error {

			ctx, cancel := context.WithTimeout(context.Background(), actionWait)
			defer cancel()

			for _, one := range pages {

				one.fit(ctx, nil)

			}

			return nil

		})

	}

	b.rest()

	return nil

}

// held is the browser the user holds; looking changes nothing, only what the user does makes the agent's refs stale.
func held(workspace string) (*Browser, error) {

	b := existing(workspace)

	if b == nil {

		return nil, errors.New("Take over the browser first")

	}

	b.mu.Lock()
	defer b.mu.Unlock()

	if b.hold == nil {

		return nil, errors.New("Take over the browser first")

	}

	b.touched = true

	return b, nil

}

// SendInput is what the user does in take-over; coordinates are fractions of the frame, so any screen size maps onto the page.
func SendInput(workspace string, event Input) error {

	b, err := held(workspace)

	if err != nil {

		return err

	}

	return b.enqueue(func() error {

		_, err := act(b, inputWait, func(ctx context.Context, running *chrome) (struct{}, error) {
			return struct{}{}, b.perform(ctx, running, event)
		})

		return err

	})

}

// UserTab is the user's tab strip in take-over: id names the tab to show or close.
func UserTab(workspace string, action TabAction, id int) error {

	b, err := held(workspace)

	if err != nil {

		return err

	}

	return b.enqueue(func() error {

		_, err := act(b, landWait, func(ctx context.Context, running *chrome) (struct{}, error) {

			b.mu.Lock()

			chosen := b.tabByID(id)

			if action == "new" {

				chosen = b.addTab("about:blank", b.active)

			}

			b.mu.Unlock()

			if chosen == nil {

				return struct{}{}, nil

			}

			if action == "close" {

				b.closeTab(ctx, running, chosen)

			} else if err := b.focus(ctx, running, chosen); err != nil {

				return struct{}{}, err

			}

			// a suspended tab loads again, and a new one starts somewhere
			return struct{}{}, b.land(ctx, running)

		})

		return err

	})

}

func (b *Browser) perform(ctx context.Context, running *chrome, event Input) error {

	b.mu.Lock()
	shown := running.page
	fallback := window

	if b.phone != nil {

		fallback = *b.phone

	}

	b.mu.Unlock()

	view := shown.visualViewport(ctx, fallback)
	at := func(x, y float64) (float64, float64) {
		return float64(int(view.Left + x*view.Width + 0.5)), float64(int(view.Top + y*view.Height + 0.5))
	}

	switch event.Kind {

	case "click":

		x, y := at(event.X, event.Y)

		return shown.click(ctx, x, y)

	case "scroll":

		x, y := at(event.X, event.Y)

		return shown.wheel(ctx, x, y, event.DX*view.Width, event.DY*view.Height)

	case "text":

		return shown.insertText(ctx, event.Text)

	case "key":

		return pressKey(ctx, shown.s, event.Key)

	case "drag":

		x, y := at(event.X, event.Y)
		toX, toY := at(event.ToX, event.ToY)

		return shown.drag(ctx, x, y, toX, toY)

	case "back":

		return shown.goBack(ctx)

	}

	return nil

}

// agentBrowser is the agent's way in: it waits out a take-over, then refuses ref-based actions the user may have made stale.
func agentBrowser(ctx context.Context, workspace string, refs bool) (*Browser, error) {

	b := browserOf(workspace)

	for {

		b.mu.Lock()
		hold := b.hold
		b.mu.Unlock()

		if hold == nil {

			break

		}

		select {

		case <-hold:

		case <-ctx.Done():

			return nil, errors.New("aborted")

		}

	}

	b.mu.Lock()
	touched := b.touched
	b.touched = false
	b.mu.Unlock()

	if touched && refs {

		page, err := act(b, actionWait*2, func(ctx context.Context, running *chrome) (string, error) { return b.read(ctx, running.page) })

		if err != nil {

			page = err.Error()

		}

		return nil, errors.New("The user used the browser while you worked, so that did not run. The page now:\n\n" + page)

	}

	return b, nil

}

func (b *Browser) read(ctx context.Context, shown *tabPage) (string, error) {

	short, cancel := context.WithTimeout(ctx, actionWait)
	defer cancel()

	tree, err := shown.outline(short)

	if err != nil {

		return "", err

	}

	title := shown.title(short)

	if len(tree) > maxSnapshot {

		tree = strings.ToValidUTF8(tree[:maxSnapshot], "") + fmt.Sprintf("\n... page cut at %d characters", maxSnapshot)

	}

	b.mu.Lock()
	at := -1

	for i, one := range b.tabs {

		if one.page == shown {

			at = i

		}

	}

	count := len(b.tabs)
	b.mu.Unlock()

	tabs := ""

	if count > 1 && at != -1 {

		tabs = fmt.Sprintf("\n\n(tab %d of %d; <tab> lists them)", at+1, count)

	}

	return shown.URL() + "\n" + title + "\n\n" + tree + tabs, nil

}

func (b *Browser) listTabs() string {

	b.mu.Lock()
	defer b.mu.Unlock()

	if len(b.tabs) == 0 {

		return "No tabs are open yet. Use <open https://...> first."

	}

	lines := make([]string, len(b.tabs))

	for i, one := range b.tabs {

		title := one.title

		if title == "" {

			title = "(untitled)"

		}

		lines[i] = fmt.Sprintf("%d. %s — %s", i+1, title, one.url)

		if one.id == b.active {

			lines[i] += "  ← current"

		}

	}

	return strings.Join(lines, "\n")

}

func (b *Browser) nthTab(raw string) (*tab, error) {

	n, err := strconv.Atoi(raw)

	b.mu.Lock()

	if err == nil && n >= 1 && n <= len(b.tabs) {

		chosen := b.tabs[n-1]
		b.mu.Unlock()

		return chosen, nil

	}

	b.mu.Unlock()

	return nil, fmt.Errorf("There is no tab %s. The tabs:\n\n%s", raw, b.listTabs())

}

// loading marks the browser as loading the agent's page for as long as work runs.
func loading(b *Browser, opening bool, work func(ctx context.Context, running *chrome) (string, error)) (string, error) {

	b.mu.Lock()
	b.opening = opening
	b.mu.Unlock()

	defer func() {

		b.mu.Lock()
		b.opening = false
		b.mu.Unlock()

		b.rest()

	}()

	return act(b, loadWait+actionWait*2, work)

}

var digits = regexp.MustCompile(`^\d+$`)

// Tab lists the tabs bare; <tab 2> shows one, <tab https://…> opens one, <tab close 2> closes one. Numbers are places in the list.
func Tab(ctx context.Context, workspace, targetText string) (string, error) {

	fields := strings.Fields(targetText)
	word, arg := "", ""

	if len(fields) > 0 {

		word = fields[0]

	}

	if len(fields) > 1 {

		arg = fields[1]

	}

	b, err := agentBrowser(ctx, workspace, false)

	if err != nil {

		return "", err

	}

	b.mu.Lock()
	on := b.running()
	b.mu.Unlock()

	if word == "" {

		return b.listTabs(), nil

	}

	if strings.EqualFold(word, "close") {

		var doomed *tab

		if arg != "" {

			if doomed, err = b.nthTab(arg); err != nil {

				return "", err

			}

		} else {

			b.mu.Lock()
			doomed = b.activeTab()
			b.mu.Unlock()

		}

		if doomed != nil {

			if on {

				act(b, actionWait, func(ctx context.Context, running *chrome) (struct{}, error) {

					b.closeTab(ctx, running, doomed)

					return struct{}{}, nil

				})

			} else {

				b.closeTab(ctx, nil, doomed)

			}

		}

		return b.listTabs(), nil

	}

	url := ""

	switch {

	case webURL.MatchString(word):

		url = word

	case strings.EqualFold(word, "new") && arg != "":

		if url, err = checkedURL(arg); err != nil {

			return "", err

		}

	}

	if url == "" && !digits.MatchString(word) {

		return "", errors.New("tab takes a number to switch to, a URL to open in a new tab, or close and a number:\n\n  <tab 2>\n  <tab https://example.com>\n  <tab close 2>")

	}

	var next *tab

	if url != "" {

		b.mu.Lock()
		next = b.addTab(url, b.active)
		b.mu.Unlock()

	} else if next, err = b.nthTab(word); err != nil {

		return "", err

	}

	// a closed browser starts on this tab, rather than on the old one and then a second page
	if !on {

		b.mu.Lock()
		b.active = next.id
		b.mu.Unlock()

	}

	return loading(b, url != "", func(ctx context.Context, running *chrome) (string, error) {

		b.mu.Lock()
		shownPage := running.page
		nextPage := next.page
		b.mu.Unlock()

		if shownPage != nextPage || nextPage == nil {

			if err := b.focus(ctx, running, next); err != nil {

				return "", err

			}

		}

		if url != "" {

			b.mu.Lock()
			shown := running.page
			b.mu.Unlock()

			if err := shown.goTo(ctx, url); err != nil {

				return "", err

			}

		}

		b.mu.Lock()
		b.opening = false
		b.mu.Unlock()

		return b.read(ctx, b.current(ctx, running))

	})

}

var refPattern = regexp.MustCompile(`^\[?(?:ref=)?(e\d+)\]?$`)

func refOf(raw string) (string, error) {

	match := refPattern.FindStringSubmatch(strings.TrimSpace(raw))

	if match == nil {

		return "", fmt.Errorf("%q is not an element ref. Use the ref from the page, like e12.", raw)

	}

	return match[1], nil

}

// checkedURL refuses anything but the web: Chromium runs outside the sandbox, so file:// would read the server's own disk.
func checkedURL(url string) (string, error) {

	if !webURL.MatchString(strings.TrimSpace(url)) {

		return "", errors.New("open takes an http:// or https:// URL")

	}

	return strings.TrimSpace(url), nil

}

func Open(ctx context.Context, workspace, url string) (string, error) {

	address, err := checkedURL(url)

	if err != nil {

		return "", err

	}

	b, err := agentBrowser(ctx, workspace, false)

	if err != nil {

		return "", err

	}

	return loading(b, true, func(ctx context.Context, running *chrome) (string, error) {

		b.mu.Lock()
		shown := running.page
		b.mu.Unlock()

		if err := shown.goTo(ctx, address); err != nil {

			return "", err

		}

		return b.read(ctx, shown)

	})

}

var errBlank = errors.New("No page is open yet. Use <open https://...> first.")

func Look(ctx context.Context, workspace string) (string, error) {

	b, err := agentBrowser(ctx, workspace, false)

	if err != nil {

		return "", err

	}

	b.mu.Lock()
	active := b.activeTab()
	idle := !b.running() && (active == nil || !webURL.MatchString(active.url))
	b.mu.Unlock()

	// a closed browser with no tab to bring back has no page to read, and launching one just to say so is waste
	if idle {

		return "", errBlank

	}

	return act(b, loadWait+actionWait*2, func(ctx context.Context, running *chrome) (string, error) {

		shown := b.current(ctx, running)

		if isBlank(shown.URL()) {

			return "", errBlank

		}

		return b.read(ctx, shown)

	})

}

// byRef says so, with the page now, when a redrawing page (Gmail's inbox, a feed) swaps the element out under a ref.
func (b *Browser) byRef(ctx context.Context, shown *tabPage, ref string, work func() error) error {

	gone := func() error {

		page, err := b.read(ctx, shown)

		if err != nil {

			page = err.Error()

		}

		return fmt.Errorf("%s is no longer on the page — it redrew since you looked, so nothing ran. Use a ref from the page below. If it keeps redrawing, don't retry the click: open the item by its URL, or search for it.\n\n%s", ref, page)

	}

	if !shown.present(ctx, ref) {

		return gone()

	}

	err := work()

	if errors.Is(err, errGone) || (isTimeout(err) && !shown.present(ctx, ref)) {

		return gone()

	}

	return err

}

// interact waits out what a click or key starts: a new page, a menu, a navigation.
func interact(ctx context.Context, workspace string, limit time.Duration, work func(ctx context.Context, shown *tabPage, b *Browser) error) (string, error) {

	b, err := agentBrowser(ctx, workspace, true)

	if err != nil {

		return "", err

	}

	return act(b, limit, func(ctx context.Context, running *chrome) (string, error) {

		b.mu.Lock()
		shown := running.page
		b.mu.Unlock()

		since := shown.mark()

		if err := work(ctx, shown, b); err != nil {

			return "", err

		}

		time.Sleep(500 * time.Millisecond)

		b.mu.Lock()
		now := running.page
		b.mu.Unlock()

		if now != shown {

			now.settle(ctx)

		} else {

			shown.waitFor(ctx, "", "DOMContentLoaded", loadWait)
			shown.quiet(ctx, since, quietWait)

		}

		return b.read(ctx, now)

	})

}

func Click(ctx context.Context, workspace, ref string) (string, error) {

	target, err := refOf(ref)

	if err != nil {

		return "", err

	}

	return interact(ctx, workspace, loadWait+actionWait*3, func(ctx context.Context, shown *tabPage, b *Browser) error {

		return b.byRef(ctx, shown, target, func() error { return shown.clickRef(ctx, target, elementWait) })

	})

}

func Press(ctx context.Context, workspace, key string) (string, error) {

	if key = strings.TrimSpace(key); key == "" {

		key = "Enter"

	}

	return interact(ctx, workspace, loadWait+actionWait*2, func(ctx context.Context, shown *tabPage, b *Browser) error {

		return pressKey(ctx, shown.s, key)

	})

}

func Type(ctx context.Context, workspace, ref, text string) (string, error) {

	target, err := refOf(ref)

	if err != nil {

		return "", err

	}

	b, err := agentBrowser(ctx, workspace, true)

	if err != nil {

		return "", err

	}

	_, err = act(b, actionWait*3, func(ctx context.Context, running *chrome) (struct{}, error) {

		b.mu.Lock()
		shown := running.page
		b.mu.Unlock()

		return struct{}{}, b.byRef(ctx, shown, target, func() error { return shown.fillRef(ctx, target, text, elementWait) })

	})

	if err != nil {

		return "", err

	}

	return fmt.Sprintf("typed %d characters into %s", len(utf16Units(text)), target), nil

}

// utf16Units counts characters as JavaScript does, which is what this message has always reported.
func utf16Units(text string) []uint16 {

	units := []uint16{}

	for _, r := range text {

		if r >= 0x10000 {

			units = append(units, 0, 0)

		} else {

			units = append(units, 0)

		}

	}

	return units

}

func PageURL(workspace string) string {

	b := existing(workspace)

	if b == nil {

		return "about:blank"

	}

	b.mu.Lock()
	defer b.mu.Unlock()

	if b.chrome == nil || b.chrome.page == nil {

		return "about:blank"

	}

	return b.chrome.page.URL()

}

// Installed is nil when a Chromium to launch is on this machine.
func Installed() error {

	_, _, err := findChromium()

	return err

}

// ChromiumPID is the running Chromium's process group for the workspace, or 0 when none runs.
func ChromiumPID(workspace string) int {

	b := existing(workspace)

	if b == nil {

		return 0

	}

	b.mu.Lock()
	defer b.mu.Unlock()

	if b.chrome == nil {

		return 0

	}

	return b.chrome.proc.pid

}

// KnownKey is true for a key, or a chord like Control+A, that <press> can send.
func KnownKey(chord string) bool {

	for _, part := range strings.Split(chord, "+") {

		if _, err := keyFor(strings.TrimSpace(part)); err != nil {

			return false

		}

	}

	return true

}
