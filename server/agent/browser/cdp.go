package browser

import (
	"fmt"
	"os"
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"

	"github.com/chromedp/cdproto"
	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/cdp/jsonv2"
	"github.com/chromedp/cdproto/target"
)

// errClosed is every call's answer once Chromium, or the pipe to it, is gone.
var errClosed = errors.New("the browser closed")

type reply struct {

	result jsonv2.Value
	err *cdproto.Error

}

type handlerKey struct {

	session target.SessionID
	method string

}

// conn speaks CDP over Chromium's --remote-debugging-pipe: NUL-terminated JSON both ways, every target on one pipe.
type conn struct {

	w io.WriteCloser
	r io.ReadCloser

	writeMu sync.Mutex
	nextID atomic.Int64

	mu sync.Mutex
	pending map[int64]chan reply
	handlers map[handlerKey]map[int]func(jsonv2.Value)
	nextHandler int

	done chan struct{}
	once sync.Once

}

func newConn(w io.WriteCloser, r io.ReadCloser) *conn {

	c := &conn{w: w, r: r, pending: map[int64]chan reply{}, handlers: map[handlerKey]map[int]func(jsonv2.Value){}, done: make(chan struct{})}

	go c.readLoop()

	return c

}

func (c *conn) close() {

	c.once.Do(func() {

		close(c.done)
		c.w.Close()
		c.r.Close()

	})

}

func (c *conn) readLoop() {

	defer c.close()

	reader := bufio.NewReaderSize(c.r, 1<<20)

	for {

		raw, err := reader.ReadBytes(0)

		if err != nil {

			return

		}

		traceCDP("<-", raw)

		var message cdproto.Message

		if jsonv2.Unmarshal(bytes.TrimSuffix(raw, []byte{0}), &message) != nil {

			continue

		}

		if message.ID != 0 {

			c.mu.Lock()
			waiting := c.pending[message.ID]
			delete(c.pending, message.ID)
			c.mu.Unlock()

			if waiting != nil {

				waiting <- reply{result: message.Result, err: message.Error}

			}

			continue

		}

		c.mu.Lock()
		listeners := make([]func(jsonv2.Value), 0, len(c.handlers[handlerKey{message.SessionID, string(message.Method)}]))

		for _, listener := range c.handlers[handlerKey{message.SessionID, string(message.Method)}] {

			listeners = append(listeners, listener)

		}

		c.mu.Unlock()

		// handlers run on this goroutine, so they must never wait on a call themselves
		for _, listener := range listeners {

			listener(message.Params)

		}

	}

}

func (c *conn) call(ctx context.Context, session target.SessionID, method string, params, result any) error {

	return c.send(session, method, params)(ctx, result)

}

// send writes the command at once and returns what waits for its answer, so a paused target can be set up and resumed in one go.
func (c *conn) send(session target.SessionID, method string, params any) func(ctx context.Context, result any) error {

	if params == nil {

		params = struct{}{}

	}

	encoded, err := jsonv2.Marshal(params)

	if err != nil {

		return func(context.Context, any) error { return err }

	}

	id := c.nextID.Add(1)
	waiting := make(chan reply, 1)

	c.mu.Lock()
	c.pending[id] = waiting
	c.mu.Unlock()

	forget := func() {

		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()

	}

	message, err := jsonv2.Marshal(cdproto.Message{ID: id, SessionID: session, Method: cdproto.MethodType(method), Params: encoded})

	if err == nil {

		traceCDP("->", message)

		c.writeMu.Lock()
		_, err = c.w.Write(append(message, 0))
		c.writeMu.Unlock()

		if err != nil {

			err = errClosed

		}

	}

	if err != nil {

		forget()

		return func(context.Context, any) error { return err }

	}

	return func(ctx context.Context, result any) error {

		select {

		case answer := <-waiting:

			if answer.err != nil {

				return answer.err

			}

			if result == nil || len(answer.result) == 0 {

				return nil

			}

			if _, empty := result.(*cdp.Empty); empty {

				return nil

			}

			return jsonv2.Unmarshal(answer.result, result)

		case <-ctx.Done():

			forget()

			return ctx.Err()

		case <-c.done:

			forget()

			return errClosed

		}

	}

}

// on calls handler with each event of method on the session until the returned func stops it.
func (c *conn) on(session target.SessionID, method string, handler func(jsonv2.Value)) func() {

	key := handlerKey{session, method}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.handlers[key] == nil {

		c.handlers[key] = map[int]func(jsonv2.Value){}

	}

	id := c.nextHandler
	c.nextHandler++
	c.handlers[key][id] = handler

	return func() {

		c.mu.Lock()
		delete(c.handlers[key], id)
		c.mu.Unlock()

	}

}

// dropSession forgets every handler of a detached session.
func (c *conn) dropSession(session target.SessionID) {

	c.mu.Lock()
	defer c.mu.Unlock()

	for key := range c.handlers {

		if key.session == session {

			delete(c.handlers, key)

		}

	}

}

// session is one target over the shared pipe; the browser itself is the session with no id.
type session struct {

	c *conn
	id target.SessionID

}

func (s *session) Call(ctx context.Context, method string, params, result any) error {

	return s.c.call(ctx, s.id, method, params, result)

}

func (s *session) Subscribe(method string) (<-chan jsonv2.Value, func()) {

	events := make(chan jsonv2.Value, 256)
	stop := s.c.on(s.id, method, func(value jsonv2.Value) {

		select {

		case events <- value:

		default:

		}

	})

	return events, stop

}

// batch writes every command in order without waiting, then waits for them all; the first error wins.
func (s *session) batch(ctx context.Context, commands ...command) error {

	waits := make([]func(context.Context, any) error, len(commands))

	for i, next := range commands {

		waits[i] = s.c.send(s.id, next.method, next.params)

	}

	var first error

	for _, wait := range waits {

		if err := wait(ctx, nil); err != nil && first == nil {

			first = err

		}

	}

	return first

}

type command struct {

	method string
	params any

}

// onEvent decodes each event of e on the session into handler, which runs on the read loop.
func onEvent[E any](s *session, e cdp.Event[E], handler func(E)) func() {

	return s.c.on(s.id, e.Method, func(raw jsonv2.Value) {

		var payload E

		if jsonv2.Unmarshal(raw, &payload) == nil {

			handler(payload)

		}

	})

}

// call runs a typed command on the session.
func call[P, R any](ctx context.Context, s *session, command cdp.Command[P, R], params P) (R, error) {

	return cdp.Call(ctx, cdp.Session(s), command, params)

}

// traceCDP prints the pipe's traffic to stderr when PTS_CDP_TRACE is set; "full" keeps whole messages.
func traceCDP(direction string, raw []byte) {

	if os.Getenv("PTS_CDP_TRACE") == "" {

		return

	}

	text := string(raw)

	if len(text) > 300 && os.Getenv("PTS_CDP_TRACE") != "full" {

		text = text[:300]

	}

	fmt.Fprintln(os.Stderr, direction, text)

}
