package server

import (
	"encoding/json"
	"math"
	"sync"
	"time"

	"boombox/agent/browser"
	"boombox/config"
	"boombox/store"
)

var (
	// a take-over left alone (phone locked, tab forgotten) must not park the agent forever
	holdFor = config.Millis("PTS_HOLD_MS", 5*time.Minute)

	// iOS drops the socket when the user switches apps, say to copy a sign-in code; they get this long to come back
	graceFor = config.Millis("PTS_HOLD_GRACE_MS", 2*time.Minute)
)

// liveMessage is everything a window can say about the browser it watches.
type liveMessage struct {

	Live string `json:"live"`

	AgentID json.RawMessage `json:"agentId"`

	Width *float64 `json:"width"`
	Height *float64 `json:"height"`

	Event map[string]any `json:"event"`

	Action string `json:"action"`
	ID json.RawMessage `json:"id"`

}

type view struct {

	agentID int64
	workspace string
	stop func()

}

// holder's client is nil while the device that took over is reconnecting.
type holder struct {

	client *client
	workspace string
	timer *time.Timer

}

// Live is watching an agent's browser and taking it over, over the app's one socket; onGive runs when a take-over ends.
type Live struct {

	mu sync.Mutex

	st *store.Store
	views map[*client]*view
	holders map[int64]*holder

	onGive func(agentID int64)

}

func NewLive(st *store.Store, onGive func(agentID int64)) *Live {

	return &Live{st: st, views: map[*client]*view{}, holders: map[int64]*holder{}, onGive: onGive}

}

// validInput keeps only the known fields of a well-formed gesture, so nothing else from the socket reaches the page.
func validInput(event map[string]any) (browser.Input, bool) {

	number := func(key string) (float64, bool) {

		value, ok := event[key].(float64)

		return value, ok && !math.IsNaN(value)

	}

	unit := func(keys ...string) ([]float64, bool) {

		values := make([]float64, len(keys))

		for i, key := range keys {

			value, ok := number(key)

			if !ok || value < 0 || value > 1 {

				return nil, false

			}

			values[i] = value

		}

		return values, true

	}

	short := func(key string, limit int) (string, bool) {

		value, ok := event[key].(string)

		return value, ok && value != "" && len([]rune(value)) <= limit

	}

	kind, _ := event["kind"].(string)

	switch kind {

	case "click":

		if at, ok := unit("x", "y"); ok {

			return browser.Input{Kind: kind, X: at[0], Y: at[1]}, true

		}

	case "scroll":

		at, ok := unit("x", "y")
		dx, okX := number("dx")
		dy, okY := number("dy")

		if ok && okX && okY && math.Abs(dx) <= 10 && math.Abs(dy) <= 10 {

			return browser.Input{Kind: kind, X: at[0], Y: at[1], DX: dx, DY: dy}, true

		}

	case "drag":

		if at, ok := unit("x", "y", "toX", "toY"); ok {

			return browser.Input{Kind: kind, X: at[0], Y: at[1], ToX: at[2], ToY: at[3]}, true

		}

	case "text":

		if text, ok := short("text", 20_000); ok {

			return browser.Input{Kind: kind, Text: text}, true

		}

	case "key":

		if key, ok := short("key", 40); ok {

			return browser.Input{Kind: kind, Key: key}, true

		}

	case "back":

		return browser.Input{Kind: kind}, true

	}

	return browser.Input{}, false

}

func wholeNumber(raw json.RawMessage) (int64, bool) {

	var value float64

	if json.Unmarshal(raw, &value) != nil || value != math.Trunc(value) {

		return 0, false

	}

	return int64(value), true

}

func (l *Live) Message(c *client, message liveMessage) {

	l.mu.Lock()
	watched := l.views[c]
	mine := watched != nil && l.holders[watched.agentID] != nil && l.holders[watched.agentID].client == c
	l.mu.Unlock()

	fail := func(err error) {

		if err == nil {

			return

		}

		var agentID any

		if watched != nil {

			agentID = watched.agentID

		}

		c.sendJSON(map[string]any{"type": "browser", "agentId": agentID, "error": browser.Reason(err)})

	}

	switch {

	case message.Live == "watch":

		l.watch(c, message.AgentID)

	case message.Live == "unwatch":

		l.unwatch(c)

	case watched != nil && message.Live == "take":

		var size *browser.Size

		if message.Width != nil && message.Height != nil && !math.IsInf(*message.Width, 0) && !math.IsInf(*message.Height, 0) {

			size = &browser.Size{Width: int(*message.Width), Height: int(*message.Height)}

		}

		l.mu.Lock()

		if previous := l.holders[watched.agentID]; previous != nil {

			previous.timer.Stop()

		}

		// the latest device to ask gets the browser; the one that had it drops back to watching
		agentID := watched.agentID
		l.holders[agentID] = &holder{client: c, workspace: watched.workspace, timer: time.AfterFunc(holdFor, func() { l.give(agentID) })}
		l.mu.Unlock()

		go func() { fail(browser.TakeOver(watched.workspace, size)) }()

		l.status(watched.agentID)

	case mine && message.Live == "give":

		l.give(watched.agentID)

	case mine && message.Live == "tab":

		id, whole := wholeNumber(message.ID)

		if (message.Action != "switch" && message.Action != "close" && message.Action != "new") || (message.Action != "new" && !whole) {

			return

		}

		l.renew(watched.agentID, holdFor)

		go func() { fail(browser.UserTab(watched.workspace, browser.TabAction(message.Action), int(id))) }()

	case mine && message.Live == "input":

		if event, ok := validInput(message.Event); ok {

			l.renew(watched.agentID, holdFor)

			go func() { fail(browser.SendInput(watched.workspace, event)) }()

		}

	}

}

// Close keeps a lost connection's take-over for a while; leaving the browser screen gives it back at once.
func (l *Live) Close(c *client) {

	l.mu.Lock()
	watched := l.views[c]

	if watched != nil {

		if current := l.holders[watched.agentID]; current != nil && current.client == c {

			current.client = nil
			l.renewLocked(watched.agentID, graceFor)

		}

	}

	l.mu.Unlock()

	l.unwatch(c)

}

func (l *Live) status(agentID int64) {

	l.mu.Lock()

	var holding *client

	held := l.holders[agentID] != nil

	if held {

		holding = l.holders[agentID].client

	}

	targets := []*client{}

	for c, watched := range l.views {

		if watched.agentID == agentID {

			targets = append(targets, c)

		}

	}

	l.mu.Unlock()

	for _, c := range targets {

		c.sendJSON(map[string]any{"type": "browser", "agentId": agentID, "held": held, "mine": holding == c})

	}

}

func (l *Live) watch(c *client, rawID json.RawMessage) {

	l.unwatch(c)

	agentID, whole := wholeNumber(rawID)

	if !whole {

		return

	}

	agent, err := l.st.AgentByID(agentID)

	// another user's agent is as good as missing
	if err != nil || agent.UserID != c.userID {

		return

	}

	workspace := l.st.Workspace(agent)

	// frames go as raw JPEG bytes: a third smaller than base64, and the socket only ever streams the one browser it watches
	stop := browser.Watch(workspace, browser.Viewer{

		Frame: func(jpeg []byte) {

			if jpeg == nil {

				c.sendJSON(map[string]any{"type": "browser", "agentId": agent.ID, "blank": true})

				return

			}

			c.sendFrame(jpeg)

		},

		Fail: func(message string) {

			c.sendJSON(map[string]any{"type": "browser", "agentId": agent.ID, "error": message})

		},

		Tabs: func(tabs []browser.TabView) {

			c.sendJSON(map[string]any{"type": "tabs", "agentId": agent.ID, "tabs": tabs})

		},

	})

	l.mu.Lock()
	l.views[c] = &view{agentID: agent.ID, workspace: workspace, stop: stop}
	l.mu.Unlock()

	l.status(agent.ID)

}

func (l *Live) unwatch(c *client) {

	l.mu.Lock()
	watched := l.views[c]

	if watched == nil {

		l.mu.Unlock()

		return

	}

	delete(l.views, c)
	holding := l.holders[watched.agentID] != nil && l.holders[watched.agentID].client == c
	l.mu.Unlock()

	watched.stop()

	if holding {

		l.give(watched.agentID)

	}

}

func (l *Live) renew(agentID int64, wait time.Duration) {

	l.mu.Lock()
	defer l.mu.Unlock()

	l.renewLocked(agentID, wait)

}

func (l *Live) renewLocked(agentID int64, wait time.Duration) {

	if current := l.holders[agentID]; current != nil {

		current.timer.Stop()
		current.timer = time.AfterFunc(wait, func() { l.give(agentID) })

	}

}

func (l *Live) give(agentID int64) {

	l.mu.Lock()
	current := l.holders[agentID]

	if current == nil {

		l.mu.Unlock()

		return

	}

	current.timer.Stop()
	delete(l.holders, agentID)
	l.mu.Unlock()

	go browser.HandBack(current.workspace)

	l.onGive(agentID)
	l.status(agentID)

}
