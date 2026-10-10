package browser

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/input"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/target"
)

// timeoutError is a page that was slow, as Playwright's TimeoutError was; a call Chromium never answers is a context deadline instead.
type timeoutError struct {

	message string

}

func (e *timeoutError) Error() string { return e.message }

func timedOut(limit time.Duration) error {

	return &timeoutError{message: fmt.Sprintf("Timeout %dms exceeded.", limit.Milliseconds())}

}

func isTimeout(err error) bool {

	var slow *timeoutError

	return errors.As(err, &slow)

}

// tabPage is one Chromium page and its session; it lives as long as the page does, while a tab outlives it.
type tabPage struct {

	targetID target.ID
	s *session

	mu sync.Mutex
	url string
	frame cdp.FrameID
	closed bool

	// lifecycle holds the load states each loader reached; loader is the main frame's current one
	loader cdp.LoaderID
	lifecycle map[cdp.LoaderID]map[string]bool
	changed chan struct{}

	// requests is what is in flight, each with the sequence number it started at
	requests map[network.RequestID]int64
	sequence int64

	snapshot refs

}

func newTabPage(targetID target.ID, s *session, url string) *tabPage {

	return &tabPage{targetID: targetID, s: s, url: url, lifecycle: map[cdp.LoaderID]map[string]bool{}, changed: make(chan struct{}), requests: map[network.RequestID]int64{}}

}

func (p *tabPage) URL() string {

	p.mu.Lock()
	defer p.mu.Unlock()

	return p.url

}

func (p *tabPage) isClosed() bool {

	p.mu.Lock()
	defer p.mu.Unlock()

	return p.closed

}

func (p *tabPage) markClosed() {

	p.mu.Lock()
	defer p.mu.Unlock()

	if !p.closed {

		p.closed = true
		close(p.changed)
		p.changed = make(chan struct{})

	}

}

// notify wakes everyone waiting on a load state; called with p.mu held.
func (p *tabPage) notify() {

	close(p.changed)
	p.changed = make(chan struct{})

}

// listen follows the page's navigations, load states and requests, and dismisses its dialogs as Playwright did.
func (p *tabPage) listen(onNavigated func(url string)) {

	onEvent(p.s, page.FrameNavigated, func(event page.EventFrameNavigated) {

		if event.Frame == nil || event.Frame.ParentID != "" {

			return

		}

		url := event.Frame.URL + event.Frame.URLFragment

		p.mu.Lock()
		p.url = url
		p.frame = event.Frame.ID
		p.loader = event.Frame.LoaderID
		p.snapshot.reset()
		p.notify()
		p.mu.Unlock()

		onNavigated(url)

	})

	onEvent(p.s, page.NavigatedWithinDocument, func(event page.EventNavigatedWithinDocument) {

		p.mu.Lock()
		main := p.frame == "" || event.FrameID == p.frame

		if main && event.URL != "" {

			p.url = event.URL

		}

		p.mu.Unlock()

		if main && event.URL != "" {

			onNavigated(event.URL)

		}

	})

	onEvent(p.s, page.LifecycleEvent, func(event page.EventLifecycleEvent) {

		p.mu.Lock()
		defer p.mu.Unlock()

		if event.Name == "init" {

			p.lifecycle[event.LoaderID] = map[string]bool{}

			// a few navigations back is all anyone waits on
			if len(p.lifecycle) > 8 {

				for loader := range p.lifecycle {

					if loader != event.LoaderID && loader != p.loader {

						delete(p.lifecycle, loader)

						break

					}

				}

			}

		}

		if p.lifecycle[event.LoaderID] == nil {

			p.lifecycle[event.LoaderID] = map[string]bool{}

		}

		p.lifecycle[event.LoaderID][event.Name] = true
		p.notify()

	})

	onEvent(p.s, network.RequestWillBeSent, func(event network.EventRequestWillBeSent) {

		p.mu.Lock()
		defer p.mu.Unlock()

		if _, known := p.requests[event.RequestID]; !known {

			p.sequence++
			p.requests[event.RequestID] = p.sequence

		}

	})

	finished := func(id network.RequestID) {

		p.mu.Lock()
		defer p.mu.Unlock()

		delete(p.requests, id)
		p.notify()

	}

	onEvent(p.s, network.LoadingFinished, func(event network.EventLoadingFinished) { finished(event.RequestID) })
	onEvent(p.s, network.LoadingFailed, func(event network.EventLoadingFailed) { finished(event.RequestID) })

	onEvent(p.s, page.JavascriptDialogOpening, func(event page.EventJavascriptDialogOpening) {

		accept := event.Type == page.DialogTypeBeforeunload

		go call(context.Background(), p.s, page.HandleJavaScriptDialog, page.HandleJavaScriptDialogParams{Accept: accept})

	})

}

// prepareCommands turn on what the page's events need, sent before the paused page is let run.
func (p *tabPage) prepareCommands() []command {

	return []command{

		{method: "Page.enable", params: page.EnableParams{}},
		{method: "Page.setLifecycleEventsEnabled", params: page.SetLifecycleEventsEnabledParams{Enabled: true}},
		{method: "Network.enable", params: network.EnableParams{}},

	}

}

func (p *tabPage) reached(loader cdp.LoaderID, state string) bool {

	if loader == "" {

		loader = p.loader

	}

	return p.lifecycle[loader][state]

}

// waitFor waits until the loader, or the current one when empty, reaches state.
func (p *tabPage) waitFor(ctx context.Context, loader cdp.LoaderID, state string, limit time.Duration) error {

	deadline := time.NewTimer(limit)
	defer deadline.Stop()

	for {

		p.mu.Lock()
		done := p.reached(loader, state)
		closed := p.closed
		changed := p.changed
		p.mu.Unlock()

		if done {

			return nil

		}

		if closed {

			return errClosed

		}

		select {

		case <-changed:

		case <-deadline.C:

			return timedOut(limit)

		case <-ctx.Done():

			return ctx.Err()

		}

	}

}

// goTo navigates and waits for DOMContentLoaded, then for the network to go quiet.
func (p *tabPage) goTo(ctx context.Context, url string) error {

	navigated, err := call(ctx, p.s, page.Navigate, page.NavigateParams{URL: url})

	if err != nil {

		return err

	}

	if navigated.ErrorText != "" {

		return fmt.Errorf("%s at %s", navigated.ErrorText, url)

	}

	if navigated.LoaderID == "" {

		return nil

	}

	if err := p.waitFor(ctx, navigated.LoaderID, "DOMContentLoaded", loadWait); err != nil {

		return err

	}

	p.settle(ctx)

	return nil

}

// settle gives the page its own fetches; most pages finish within a few seconds, and waiting longer only stalls the agent.
func (p *tabPage) settle(ctx context.Context) {

	p.waitFor(ctx, "", "DOMContentLoaded", loadWait)
	p.waitFor(ctx, "", "networkIdle", quietWait)

}

// mark is the request sequence now, so quiet can wait only for what an action started.
func (p *tabPage) mark() int64 {

	p.mu.Lock()
	defer p.mu.Unlock()

	return p.sequence

}

// quiet waits until no request started after since is in flight; apps like Gmail hold one open forever.
func (p *tabPage) quiet(ctx context.Context, since int64, limit time.Duration) {

	deadline := time.Now().Add(limit)

	for time.Now().Before(deadline) {

		p.mu.Lock()
		busy := false

		for _, started := range p.requests {

			busy = busy || started > since

		}

		p.mu.Unlock()

		if !busy {

			return

		}

		select {

		case <-time.After(100 * time.Millisecond):

		case <-ctx.Done():

			return

		}

	}

}

func (p *tabPage) title(ctx context.Context) string {

	title, _ := evaluate[string](ctx, p.s, "document.title")

	return title

}

func (p *tabPage) goBack(ctx context.Context) error {

	history, err := call(ctx, p.s, page.GetNavigationHistory, cdp.Empty{})

	if err != nil || history.CurrentIndex < 1 {

		return err

	}

	_, err = call(ctx, p.s, page.NavigateToHistoryEntry, page.NavigateToHistoryEntryParams{EntryID: history.Entries[history.CurrentIndex-1].ID})

	return err

}

func (p *tabPage) mouse(ctx context.Context, kind input.DispatchMouseEventType, x, y float64, button input.MouseButton, buttons int64) error {

	params := input.DispatchMouseEventParams{Type: kind, X: x, Y: y, Button: button, Buttons: buttons}

	if kind == input.DispatchMouseEventTypeMousePressed || kind == input.DispatchMouseEventTypeMouseReleased {

		params.ClickCount = 1

	}

	_, err := call(ctx, p.s, input.DispatchMouseEvent, params)

	return err

}

func (p *tabPage) click(ctx context.Context, x, y float64) error {

	if err := p.mouse(ctx, input.DispatchMouseEventTypeMouseMoved, x, y, input.MouseButtonNone, 0); err != nil {

		return err

	}

	if err := p.mouse(ctx, input.DispatchMouseEventTypeMousePressed, x, y, input.MouseButtonLeft, 1); err != nil {

		return err

	}

	return p.mouse(ctx, input.DispatchMouseEventTypeMouseReleased, x, y, input.MouseButtonLeft, 0)

}

func (p *tabPage) wheel(ctx context.Context, x, y, dx, dy float64) error {

	if err := p.mouse(ctx, input.DispatchMouseEventTypeMouseMoved, x, y, input.MouseButtonNone, 0); err != nil {

		return err

	}

	_, err := call(ctx, p.s, input.DispatchMouseEvent, input.DispatchMouseEventParams{Type: input.DispatchMouseEventTypeMouseWheel, X: x, Y: y, DeltaX: dx, DeltaY: dy})

	return err

}

// drag is something like a hand, for slider captchas: a press, a few steps across, a release.
func (p *tabPage) drag(ctx context.Context, x, y, toX, toY float64) error {

	if err := p.mouse(ctx, input.DispatchMouseEventTypeMouseMoved, x, y, input.MouseButtonNone, 0); err != nil {

		return err

	}

	if err := p.mouse(ctx, input.DispatchMouseEventTypeMousePressed, x, y, input.MouseButtonLeft, 1); err != nil {

		return err

	}

	const steps = 12

	for i := 1; i <= steps; i++ {

		stepX := x + (toX-x)*float64(i)/steps
		stepY := y + (toY-y)*float64(i)/steps

		if err := p.mouse(ctx, input.DispatchMouseEventTypeMouseMoved, stepX, stepY, input.MouseButtonLeft, 1); err != nil {

			return err

		}

	}

	return p.mouse(ctx, input.DispatchMouseEventTypeMouseReleased, toX, toY, input.MouseButtonLeft, 0)

}

func (p *tabPage) insertText(ctx context.Context, text string) error {

	_, err := call(ctx, p.s, input.InsertText, input.InsertTextParams{Text: text})

	return err

}

type viewport struct {

	Left float64 `json:"left"`
	Top float64 `json:"top"`
	Width float64 `json:"width"`
	Height float64 `json:"height"`

}

// visualViewport is what the frame shows, which a zoomed-out phone page makes wider than the screen; the mouse takes page pixels.
func (p *tabPage) visualViewport(ctx context.Context, fallback Size) viewport {

	short, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	view, err := evaluate[viewport](short, p.s, "({ left: visualViewport.offsetLeft, top: visualViewport.offsetTop, width: visualViewport.width, height: visualViewport.height })")

	if err != nil || view.Width == 0 || math.IsNaN(view.Width) {

		return viewport{Width: float64(fallback.Width), Height: float64(fallback.Height)}

	}

	return view

}

func (p *tabPage) throttle(ctx context.Context, rate float64) {

	call(ctx, p.s, emulation.SetCPUThrottlingRate, emulation.SetCPUThrottlingRateParams{Rate: rate})

}

// fit gives a phone a phone's layout and screen, so sites switch to their mobile pages; nil puts the desktop window back.
func (p *tabPage) fit(ctx context.Context, phone *Size) error {

	if phone == nil {

		_, err := call(ctx, p.s, emulation.ClearDeviceMetricsOverride, cdp.Empty{})

		return err

	}

	_, err := call(ctx, p.s, emulation.SetDeviceMetricsOverride, emulation.SetDeviceMetricsOverrideParams{

		Width: int64(phone.Width),
		Height: int64(phone.Height),
		DeviceScaleFactor: 1,
		Mobile: true,

		ScreenWidth: int64(phone.Width),
		ScreenHeight: int64(phone.Height),
		ScreenOrientation: &emulation.ScreenOrientation{Angle: 0, Type: emulation.ScreenOrientationTypePortraitPrimary},

	})

	return err

}

// isBlank is a page with nothing on it yet.
func isBlank(url string) bool {

	return url == "" || strings.HasPrefix(url, "about:blank")

}
