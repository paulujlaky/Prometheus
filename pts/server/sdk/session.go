package sdk

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

var (
	ErrDisposed = errors.New("ChatSession is disposed")
	ErrBusy = errors.New("A response is already in progress")
	ErrCancelled = errors.New("Generation cancelled")
)

type SessionOptions struct {

	// AssistantID falls back to the cookie's preferred assistant.
	AssistantID string

	NoReconnect bool
	ReconnectDelay time.Duration
	MaxReconnectAttempts int

	Timeout time.Duration

}

// SessionEvent is a stream change with the turn it produced, or an error with neither.
type SessionEvent struct {

	Change *StreamChange
	Turn ChatTurn

	Err error

}

type finalResult struct {

	turn ChatTurn
	err error

}

type pendingFinal struct {

	submissionID string
	done chan finalResult

}

// ChatSession is one Boodle chat: its history, a self-healing socket, and sends that wait for the full answer.
type ChatSession struct {

	ChatID string

	client *Client
	options SessionOptions

	mu sync.Mutex

	chat *Chat
	messages []ChatTurn

	connected bool
	busy bool
	err error

	socket *Socket
	unsubscribe []func()

	activeStream *ResponseStream
	activeTurnID string
	pending *pendingFinal

	reconnectAttempts int
	reconnectTimer *time.Timer
	disposed bool
	connecting chan struct{}
	connectErr error

	nextListener int
	listeners map[int]func(SessionEvent)

}

func newSession(client *Client, chatID string, options SessionOptions) *ChatSession {

	if options.ReconnectDelay == 0 {

		options.ReconnectDelay = 1500 * time.Millisecond

	}

	if options.MaxReconnectAttempts == 0 {

		options.MaxReconnectAttempts = 8

	}

	if options.Timeout == 0 {

		options.Timeout = 720 * time.Second

	}

	return &ChatSession{

		ChatID: chatID,

		client: client,
		options: options,

		listeners: map[int]func(SessionEvent){},

	}

}

// OpenSession loads an existing chat's history and connects its socket.
func OpenSession(ctx context.Context, client *Client, chatID string, options SessionOptions) (*ChatSession, error) {

	session := newSession(client, chatID, options)

	if err := session.Refresh(ctx); err != nil {

		return nil, err

	}

	if err := session.Connect(ctx); err != nil {

		return nil, err

	}

	return session, nil

}

func (s *ChatSession) Messages() []ChatTurn {

	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]ChatTurn(nil), s.messages...)

}

func (s *ChatSession) Connected() bool {

	s.mu.Lock()
	defer s.mu.Unlock()

	return s.connected

}

// On listens to stream changes and errors; listeners run on the socket's goroutine.
func (s *ChatSession) On(listener func(SessionEvent)) func() {

	s.mu.Lock()
	defer s.mu.Unlock()

	id := s.nextListener
	s.nextListener++
	s.listeners[id] = listener

	return func() {

		s.mu.Lock()
		delete(s.listeners, id)
		s.mu.Unlock()

	}

}

func (s *ChatSession) Refresh(ctx context.Context) error {

	detail, err := s.client.GetChat(ctx, s.ChatID)

	if err != nil {

		return err

	}

	s.mu.Lock()
	s.chat = &detail.Chat
	s.messages = TurnsFromChatDetail(detail)
	s.err = nil
	s.mu.Unlock()

	return nil

}

func (s *ChatSession) Connect(ctx context.Context) error {

	s.mu.Lock()

	if s.disposed {

		s.mu.Unlock()

		return ErrDisposed

	}

	if s.socket != nil && s.socket.Connected() {

		socket := s.socket
		s.mu.Unlock()
		socket.SetActive(s.ChatID)

		return nil

	}

	if s.connecting != nil {

		waiting := s.connecting
		s.mu.Unlock()

		select {

		case <-waiting:

		case <-ctx.Done():

			return ctx.Err()

		}

		s.mu.Lock()
		defer s.mu.Unlock()

		return s.connectErr

	}

	done := make(chan struct{})
	s.connecting = done
	s.mu.Unlock()

	err := s.openSocket(ctx)

	s.mu.Lock()
	s.connecting = nil
	s.connectErr = err
	s.mu.Unlock()
	close(done)

	if err != nil {

		s.setError(err)

	}

	return err

}

func (s *ChatSession) openSocket(ctx context.Context) error {

	s.mu.Lock()
	s.teardownLocked()
	s.mu.Unlock()

	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	socket, err := s.client.ConnectSocket(dialCtx)

	if err != nil {

		return err

	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.disposed {

		socket.Close()

		return ErrDisposed

	}

	s.socket = socket
	s.reconnectAttempts = 0
	s.connected = true
	s.err = nil

	s.unsubscribe = []func(){

		socket.OnEnvelope(func(envelope WsEnvelope) {

			s.onEnvelope(socket, envelope)

		}),

		socket.OnStatus(func(connected bool) {

			s.onStatus(socket, connected)

		}),

		socket.OnError(func(err error) {

			s.onSocketError(socket, err)

		}),

	}

	socket.SetActive(s.ChatID)

	return nil

}

// teardownLocked drops listeners before closing, so the old socket's close never schedules a reconnect.
func (s *ChatSession) teardownLocked() {

	for _, unsubscribe := range s.unsubscribe {

		unsubscribe()

	}

	s.unsubscribe = nil

	if s.socket != nil {

		s.socket.Close()
		s.socket = nil

	}

}

func (s *ChatSession) onStatus(socket *Socket, connected bool) {

	s.mu.Lock()

	if s.socket != socket {

		s.mu.Unlock()

		return

	}

	s.connected = connected
	retry := !connected && !s.disposed && !s.options.NoReconnect
	s.mu.Unlock()

	if retry {

		s.scheduleReconnect()

	}

}

func (s *ChatSession) onSocketError(socket *Socket, err error) {

	s.mu.Lock()
	ignore := s.disposed || s.socket != socket || (errors.Is(err, ErrSocketClosed) && !s.options.NoReconnect)
	s.mu.Unlock()

	if !ignore {

		s.setError(err)

	}

}

func (s *ChatSession) scheduleReconnect() {

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.disposed || s.reconnectTimer != nil {

		return

	}

	if s.reconnectAttempts >= s.options.MaxReconnectAttempts {

		s.err = errors.New("WebSocket reconnect attempts exhausted")

		return

	}

	backoff := 1 << s.reconnectAttempts

	if backoff > 8 {

		backoff = 8

	}

	s.reconnectAttempts++

	s.reconnectTimer = time.AfterFunc(s.options.ReconnectDelay*time.Duration(backoff), func() {

		s.mu.Lock()
		s.reconnectTimer = nil
		s.mu.Unlock()

		if err := s.Connect(context.Background()); err != nil && !errors.Is(err, ErrDisposed) {

			s.scheduleReconnect()

		}

	})

}

// Cancel stops the in-flight generation and unblocks whoever waits on it.
func (s *ChatSession) Cancel(ctx context.Context) {

	s.client.StopChat(ctx, s.ChatID)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.resolvePendingLocked(finalResult{err: ErrCancelled})

	if s.activeTurnID != "" {

		s.patchTurnLocked(s.activeTurnID, func(turn *ChatTurn) {

			turn.Status = TurnError
			turn.Error = "cancelled"

		})

	}

	s.busy = false

}

// Send posts a user message and waits until the assistant's turn completes, fails or times out.
func (s *ChatSession) Send(ctx context.Context, content string, options SendOptions) (ChatTurn, error) {

	text := strings.TrimSpace(content)

	s.mu.Lock()

	switch {

	case s.disposed:

		s.mu.Unlock()

		return ChatTurn{}, ErrDisposed

	case s.busy:

		s.mu.Unlock()

		return ChatTurn{}, ErrBusy

	case text == "":

		s.mu.Unlock()

		return ChatTurn{}, errors.New("Message content is empty")

	}

	s.mu.Unlock()

	if err := s.Connect(ctx); err != nil {

		return ChatTurn{}, err

	}

	localID := fmt.Sprintf("local-user-%d", time.Now().UnixNano())

	s.mu.Lock()
	s.busy = true
	s.err = nil
	s.messages = append(s.messages, ChatTurn{ID: localID, Role: "user", Status: TurnPending, Text: text, Blocks: []ContentBlock{}})
	socket := s.socket
	s.mu.Unlock()

	defer func() {

		s.mu.Lock()
		s.busy = false
		s.activeStream = nil
		s.activeTurnID = ""
		s.pending = nil
		s.mu.Unlock()

	}()

	if socket != nil {

		socket.SetActive(s.ChatID)
		socket.SetTyping(s.ChatID)

	}

	assistantID := options.AssistantID

	if assistantID == "" {

		assistantID = s.options.AssistantID

	}

	if assistantID == "" {

		assistantID = s.client.PreferredAssistantID()

	}

	sent, err := s.client.SendMessage(ctx, s.ChatID, text, SendOptions{AssistantID: assistantID})

	if err != nil {

		return ChatTurn{}, s.fail(err)

	}

	assistantTurnID := "assistant-" + sent.ID

	s.mu.Lock()

	s.patchTurnLocked(localID, func(turn *ChatTurn) {

		turn.ID = sent.ID
		turn.Status = TurnComplete
		turn.SubmissionID = sent.ID
		turn.Created = sent.Created

	})

	// the socket can beat the HTTP reply; a stream it already adopted for this submission is kept
	if s.activeStream == nil || (s.activeStream.SubmissionID != "" && s.activeStream.SubmissionID != sent.ID) {

		s.activeStream = NewResponseStream(s.ChatID, sent.ID)
		s.activeTurnID = assistantTurnID
		s.messages = append(s.messages, ChatTurn{ID: assistantTurnID, Role: "assistant", Status: TurnStreaming, Blocks: []ContentBlock{}, SubmissionID: sent.ID, AssistantID: assistantID})

	} else if s.activeStream.SubmissionID == "" {

		s.activeStream.SubmissionID = sent.ID

	}

	completed, waiting := s.finishedTurnLocked(sent.ID)

	if !waiting {

		s.pending = &pendingFinal{submissionID: sent.ID, done: make(chan finalResult, 1)}

	}

	pending := s.pending
	s.mu.Unlock()

	if !waiting {

		timer := time.NewTimer(s.options.Timeout)
		defer timer.Stop()

		select {

		case result := <-pending.done:

			if result.err != nil {

				return ChatTurn{}, s.fail(result.err)

			}

			completed = result.turn

		case <-timer.C:

			return ChatTurn{}, s.fail(fmt.Errorf("Timed out waiting for final response (%dms)", s.options.Timeout.Milliseconds()))

		case <-ctx.Done():

			return ChatTurn{}, s.fail(ctx.Err())

		}

	}

	if completed.Status == TurnError || completed.Error != "" {

		message := completed.Error

		if message == "" {

			message = "Assistant returned an error"

		}

		return ChatTurn{}, s.fail(errors.New(message))

	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, turn := range s.messages {

		if turn.Role == "assistant" && (turn.SubmissionID == sent.ID || turn.ID == assistantTurnID) {

			return turn, nil

		}

	}

	return completed, nil

}

// finishedTurnLocked reports a turn that completed before anyone started waiting for it.
func (s *ChatSession) finishedTurnLocked(submissionID string) (ChatTurn, bool) {

	for _, turn := range s.messages {

		if turn.Role == "assistant" && turn.SubmissionID == submissionID && (turn.Status == TurnComplete || turn.Status == TurnError) {

			return turn, true

		}

	}

	return ChatTurn{}, false

}

func (s *ChatSession) fail(err error) error {

	s.mu.Lock()

	if s.activeTurnID != "" {

		s.patchTurnLocked(s.activeTurnID, func(turn *ChatTurn) {

			turn.Status = TurnError
			turn.Error = err.Error()

		})

	}

	s.mu.Unlock()
	s.setError(err)

	return err

}

func (s *ChatSession) Dispose() {

	s.mu.Lock()

	s.disposed = true

	if s.reconnectTimer != nil {

		s.reconnectTimer.Stop()
		s.reconnectTimer = nil

	}

	s.resolvePendingLocked(finalResult{err: errors.New("ChatSession disposed")})
	s.teardownLocked()
	s.connected = false
	s.listeners = map[int]func(SessionEvent){}

	s.mu.Unlock()

}

func (s *ChatSession) resolvePendingLocked(result finalResult) {

	if s.pending == nil {

		return

	}

	select {

	case s.pending.done <- result:

	default:

	}

	s.pending = nil

}

func (s *ChatSession) onEnvelope(socket *Socket, envelope WsEnvelope) {

	data := envelope.Data
	kind, _ := data["type"].(string)
	generation := kind == "MessageSubmission" || kind == "MessageIncrementalResponse" || kind == "MessageFinalResponse"

	chatID, _ := data["chatId"].(string)

	if chatID == "" {

		chatID = envelope.EntityID

	}

	s.mu.Lock()

	if s.socket != socket || !generation {

		s.mu.Unlock()

		return

	}

	// on the user-level socket, a generation with no chat id is someone else's unless this session asked for a turn
	if (chatID != "" && chatID != s.ChatID) || (chatID == "" && !s.busy && s.pending == nil && s.activeStream == nil) {

		s.mu.Unlock()

		return

	}

	events := s.onGenerationLocked(data, kind)
	s.mu.Unlock()

	s.emit(events)

}

func (s *ChatSession) onGenerationLocked(data WsData, kind string) []SessionEvent {

	submissionID, _ := data["submissionId"].(string)

	if submissionID == "" {

		submissionID, _ = data["id"].(string)

	}

	if s.activeStream == nil {

		// siblings share the user socket, so a stream is adopted only while this session waits on a turn
		if kind == "MessageFinalResponse" || (!s.busy && s.pending == nil) {

			return nil

		}

		s.activeStream = NewResponseStream(s.ChatID, submissionID)
		s.busy = true

		if s.activeTurnID == "" {

			id := submissionID

			if id == "" {

				id = fmt.Sprint(time.Now().UnixMilli())

			}

			turn := TurnFromSnapshot(s.activeStream.Snapshot(), "assistant-"+id)
			turn.Status = TurnStreaming

			s.activeTurnID = turn.ID
			s.messages = append(s.messages, turn)

		}

	}

	if submissionID != "" && s.activeStream.SubmissionID != "" && submissionID != s.activeStream.SubmissionID && kind != "MessageSubmission" {

		return nil

	}

	events := []SessionEvent{}

	for _, change := range s.activeStream.HandleData(data) {

		events = append(events, s.applyChangeLocked(change))

	}

	return events

}

func (s *ChatSession) applyChangeLocked(change StreamChange) SessionEvent {

	snapshot := change.Snapshot
	turnID := s.activeTurnID

	if turnID == "" {

		turnID = snapshot.SubmissionID

	}

	if turnID == "" {

		turnID = fmt.Sprintf("assistant-%d", time.Now().UnixMilli())

	}

	s.activeTurnID = turnID

	turn := TurnFromSnapshot(snapshot, turnID)
	found := false

	for i := range s.messages {

		if s.messages[i].ID == turnID {

			turn.Created = s.messages[i].Created
			s.messages[i] = turn
			found = true

		}

	}

	if !found {

		s.messages = append(s.messages, turn)

	}

	if (change.Kind == ChangeComplete || change.Kind == ChangeError) && s.pending != nil && (s.pending.submissionID == "" || s.pending.submissionID == snapshot.SubmissionID) {

		s.resolvePendingLocked(finalResult{turn: turn})

	}

	return SessionEvent{Change: &change, Turn: turn}

}

func (s *ChatSession) patchTurnLocked(id string, patch func(*ChatTurn)) {

	for i := range s.messages {

		if s.messages[i].ID == id {

			patch(&s.messages[i])

		}

	}

}

func (s *ChatSession) setError(err error) {

	s.mu.Lock()
	s.err = err
	s.mu.Unlock()

	s.emit([]SessionEvent{{Err: err}})

}

func (s *ChatSession) emit(events []SessionEvent) {

	if len(events) == 0 {

		return

	}

	s.mu.Lock()
	listeners := make([]func(SessionEvent), 0, len(s.listeners))

	for _, listener := range s.listeners {

		listeners = append(listeners, listener)

	}

	s.mu.Unlock()

	for _, event := range events {

		for _, listener := range listeners {

			func() {

				// a listener that panics must not abort the rest of the stream
				defer func() { recover() }()

				listener(event)

			}()

		}

	}

}
