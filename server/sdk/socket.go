package sdk

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// ErrSocketClosed is reported when the parrot socket drops without Close being called.
var ErrSocketClosed = errors.New("WebSocket closed")

// a final response carries the whole answer, far past the library's 32 KiB default
const maxFrame = 64 << 20

type EnvelopeHandler func(WsEnvelope)

type StatusHandler func(connected bool)

type ErrorHandler func(error)

// Socket is the parrot WebSocket transport: envelopes in, presence out.
type Socket struct {

	UserID string

	conn *websocket.Conn

	mu sync.Mutex
	nextID int
	envelopeHandlers map[int]EnvelopeHandler
	statusHandlers map[int]StatusHandler
	errorHandlers map[int]ErrorHandler

	connected bool
	closed bool

	cancel context.CancelFunc

}

func DialSocket(ctx context.Context, url, userID string) (*Socket, error) {

	conn, _, err := websocket.Dial(ctx, url, nil)

	if err != nil {

		return nil, errors.New("WebSocket connection error: " + err.Error())

	}

	conn.SetReadLimit(maxFrame)

	life, cancel := context.WithCancel(context.Background())

	socket := &Socket{

		UserID: userID,

		conn: conn,

		envelopeHandlers: map[int]EnvelopeHandler{},
		statusHandlers: map[int]StatusHandler{},
		errorHandlers: map[int]ErrorHandler{},

		connected: true,

		cancel: cancel,

	}

	go socket.readLoop(life)

	return socket, nil

}

func (s *Socket) Connected() bool {

	s.mu.Lock()
	defer s.mu.Unlock()

	return s.connected

}

func (s *Socket) OnEnvelope(handler EnvelopeHandler) func() {

	s.mu.Lock()
	defer s.mu.Unlock()

	id := s.nextID
	s.nextID++
	s.envelopeHandlers[id] = handler

	return func() {

		s.mu.Lock()
		delete(s.envelopeHandlers, id)
		s.mu.Unlock()

	}

}

func (s *Socket) OnStatus(handler StatusHandler) func() {

	s.mu.Lock()
	defer s.mu.Unlock()

	id := s.nextID
	s.nextID++
	s.statusHandlers[id] = handler

	return func() {

		s.mu.Lock()
		delete(s.statusHandlers, id)
		s.mu.Unlock()

	}

}

func (s *Socket) OnError(handler ErrorHandler) func() {

	s.mu.Lock()
	defer s.mu.Unlock()

	id := s.nextID
	s.nextID++
	s.errorHandlers[id] = handler

	return func() {

		s.mu.Lock()
		delete(s.errorHandlers, id)
		s.mu.Unlock()

	}

}

func (s *Socket) SetActive(chatID string) error {

	return s.Send(wsOutbound{Type: "ChatMemberActive", ChatID: chatID, UserID: s.UserID})

}

func (s *Socket) SetTyping(chatID string) error {

	return s.Send(wsOutbound{Type: "ChatMemberTyping", ChatID: chatID, UserID: s.UserID})

}

func (s *Socket) Send(payload any) error {

	if !s.Connected() {

		return errors.New("WebSocket is not open")

	}

	data, err := json.Marshal(payload)

	if err != nil {

		return err

	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return s.conn.Write(ctx, websocket.MessageText, data)

}

func (s *Socket) Close() {

	s.mu.Lock()
	already := s.closed
	s.closed = true
	s.mu.Unlock()

	if !already {

		s.conn.Close(websocket.StatusNormalClosure, "")
		s.cancel()

	}

}

func (s *Socket) readLoop(ctx context.Context) {

	for {

		_, data, err := s.conn.Read(ctx)

		if err != nil {

			s.mu.Lock()
			s.connected = false
			intentional := s.closed
			s.mu.Unlock()

			s.emitStatus(false)

			if !intentional {

				s.emitError(ErrSocketClosed)

			}

			return

		}

		envelope, ok := normalizeEnvelope(data)

		if !ok {

			continue

		}

		s.mu.Lock()
		handlers := make([]EnvelopeHandler, 0, len(s.envelopeHandlers))

		for _, handler := range s.envelopeHandlers {

			handlers = append(handlers, handler)

		}

		s.mu.Unlock()

		for _, handler := range handlers {

			handler(envelope)

		}

	}

}

func (s *Socket) emitStatus(connected bool) {

	s.mu.Lock()
	handlers := make([]StatusHandler, 0, len(s.statusHandlers))

	for _, handler := range s.statusHandlers {

		handlers = append(handlers, handler)

	}

	s.mu.Unlock()

	for _, handler := range handlers {

		handler(connected)

	}

}

func (s *Socket) emitError(err error) {

	s.mu.Lock()
	handlers := make([]ErrorHandler, 0, len(s.errorHandlers))

	for _, handler := range s.errorHandlers {

		handlers = append(handlers, handler)

	}

	s.mu.Unlock()

	for _, handler := range handlers {

		handler(err)

	}

}

// normalizeEnvelope accepts the standard { data: { type } } envelope and a bare { type } payload.
func normalizeEnvelope(raw []byte) (WsEnvelope, bool) {

	var obj map[string]any

	if json.Unmarshal(raw, &obj) != nil {

		return WsEnvelope{}, false

	}

	if data, ok := obj["data"].(map[string]any); ok {

		if _, typed := data["type"].(string); !typed {

			return WsEnvelope{}, false

		}

		envelope := WsEnvelope{Data: data}

		envelope.EntityID, _ = obj["entityId"].(string)
		envelope.UserID, _ = obj["userId"].(string)
		envelope.Timestamp, _ = obj["timestamp"].(float64)

		return envelope, true

	}

	if _, typed := obj["type"].(string); typed {

		return WsEnvelope{Data: obj}, true

	}

	return WsEnvelope{}, false

}
