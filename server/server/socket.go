package server

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// a slow connection gets fewer frames rather than a growing backlog of stale ones; a few frames is already a lag
const maxBuffered = 300_000

type frame struct {

	binary bool
	data []byte

}

// client is one app window's socket; writes go through a queue so a slow phone never blocks the server.
type client struct {

	ws *websocket.Conn
	userID int64

	out chan frame
	buffered atomic.Int64

	done chan struct{}
	once sync.Once

}

func newClient(ws *websocket.Conn, userID int64) *client {

	c := &client{ws: ws, userID: userID, out: make(chan frame, 1024), done: make(chan struct{})}

	go c.writeLoop()

	return c

}

func (c *client) writeLoop() {

	for {

		select {

		case <-c.done:

			return

		case next := <-c.out:

			kind := websocket.MessageText

			if next.binary {

				kind = websocket.MessageBinary

			}

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			err := c.ws.Write(ctx, kind, next.data)

			cancel()
			c.buffered.Add(-int64(len(next.data)))

			if err != nil {

				c.close()

				return

			}

		}

	}

}

func (c *client) enqueue(next frame) {

	select {

	case <-c.done:

		return

	default:

	}

	c.buffered.Add(int64(len(next.data)))

	select {

	case c.out <- next:

	default:

		// a queue this deep means the window stopped reading; it reconnects and reloads what it missed
		c.buffered.Add(-int64(len(next.data)))
		c.close()

	}

}

func (c *client) sendJSON(message any) {

	data, err := json.Marshal(message)

	if err == nil {

		c.enqueue(frame{data: data})

	}

}

func (c *client) sendText(data []byte) {

	c.enqueue(frame{data: data})

}

// sendFrame drops a frame when the window is behind, since a newer one is always on its way.
func (c *client) sendFrame(jpeg []byte) {

	if c.buffered.Load() < maxBuffered {

		c.enqueue(frame{binary: true, data: jpeg})

	}

}

func (c *client) close() {

	c.once.Do(func() {

		close(c.done)
		c.ws.Close(websocket.StatusGoingAway, "")

	})

}

// hub gives each user a topic, so nobody sees another's agents.
type hub struct {

	mu sync.Mutex
	clients map[int64]map[*client]bool

}

func newHub() *hub {

	return &hub{clients: map[int64]map[*client]bool{}}

}

func (h *hub) add(c *client) {

	h.mu.Lock()
	defer h.mu.Unlock()

	if h.clients[c.userID] == nil {

		h.clients[c.userID] = map[*client]bool{}

	}

	h.clients[c.userID][c] = true

}

func (h *hub) remove(c *client) {

	h.mu.Lock()
	defer h.mu.Unlock()

	delete(h.clients[c.userID], c)

	if len(h.clients[c.userID]) == 0 {

		delete(h.clients, c.userID)

	}

}

func (h *hub) publish(userID int64, message any) {

	data, err := json.Marshal(message)

	if err != nil {

		return

	}

	h.mu.Lock()
	targets := make([]*client, 0, len(h.clients[userID]))

	for c := range h.clients[userID] {

		targets = append(targets, c)

	}

	h.mu.Unlock()

	for _, c := range targets {

		c.sendText(data)

	}

}
