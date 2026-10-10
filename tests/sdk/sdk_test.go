package sdk_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"boombox/sdk"

	"github.com/coder/websocket"
)

func fakeCookie(userID string) string {

	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"userId":"` + userID + `"}`))

	return `d=x.` + payload + `.sig; teamID=%22org-1%22; preferred-chat-assistant=` + "%7B%22assistantId%22%3A%22asst-1%22%7D"

}

func TestParseSession(t *testing.T) {

	info, err := sdk.ParseSession(fakeCookie("u-1"))

	if err != nil {

		t.Fatal(err)

	}

	if info.UserID != "u-1" || info.OrgID != "org-1" || info.PreferredAssistantID != "asst-1" {

		t.Fatalf("unexpected session %+v", info)

	}

	if _, err := sdk.ParseSession("foo=bar"); err == nil {

		t.Fatal("a cookie without d should fail")

	}

}

func TestStreamAssemblesSectionsAndFinal(t *testing.T) {

	stream := sdk.NewResponseStream("c-1", "s-1")

	stream.HandleData(sdk.WsData{"type": "MessageIncrementalResponse", "chatId": "c-1", "message": []any{

		map[string]any{"type": "StreamSectionStart", "index": 0.0, "sectionType": "Reasoning"},
		map[string]any{"type": "StreamSection", "index": 0.0, "content": []any{map[string]any{"type": "Stream", "content": "thinking"}}},
		map[string]any{"type": "StreamSection", "index": 1.0, "content": []any{map[string]any{"type": "Stream", "content": "Hel"}, map[string]any{"type": "Stream", "content": "lo"}}},
		map[string]any{"type": "Progress", "content": "Searching"},

	}})

	if stream.FullText() != "Hello" || stream.ReasoningText() != "thinking" {

		t.Fatalf("got text %q reasoning %q", stream.FullText(), stream.ReasoningText())

	}

	changes := stream.HandleData(sdk.WsData{"type": "MessageFinalResponse", "chatId": "c-1", "submissionId": "s-1", "message": []any{

		map[string]any{"type": "SectionResponse", "index": 1.0, "sectionType": "Text", "content": []any{map[string]any{"type": "PlainText", "content": "Hello, world"}}},
		map[string]any{"type": "Link", "title": "Example", "url": "https://example.com"},

	}})

	last := changes[len(changes)-1]

	if last.Kind != sdk.ChangeComplete || last.Snapshot.Text != "Hello, world" || len(last.Snapshot.Links) != 1 {

		t.Fatalf("unexpected final change %+v", last)

	}

	if other := stream.HandleData(sdk.WsData{"type": "MessageIncrementalResponse", "chatId": "c-2"}); other != nil {

		t.Fatal("another chat's data must be ignored")

	}

}

func TestStreamErrorWithoutText(t *testing.T) {

	stream := sdk.NewResponseStream("c-1", "s-1")

	changes := stream.HandleData(sdk.WsData{"type": "MessageFinalResponse", "message": []any{map[string]any{"type": "Error", "content": "quota", "opcode": 7.0}}})
	last := changes[len(changes)-1]

	if last.Kind != sdk.ChangeError || last.Content != "quota" || stream.Status != sdk.StreamError {

		t.Fatalf("unexpected %+v", last)

	}

}

func TestHistoryTurnsRebuildPrompts(t *testing.T) {

	detail := sdk.ChatDetail{Chat: sdk.Chat{ID: "c-1"}, Messages: []sdk.Message{{

		ID: "m-1",
		Type: "Assistant",
		State: "Complete",

		Submission: "hi",
		Responses: []sdk.RawPart{{"type": "SectionResponse", "index": 0.0, "content": "hello"}},

	}}}

	turns := sdk.TurnsFromChatDetail(detail)

	if len(turns) != 2 || turns[0].Role != "user" || turns[0].Text != "hi" || turns[1].Text != "hello" {

		t.Fatalf("unexpected turns %+v", turns)

	}

}

// fakeBoodle answers the REST calls a session makes and streams a reply to every message.
func fakeBoodle(t *testing.T) *httptest.Server {

	sockets := make(chan *websocket.Conn, 4)

	mux := http.NewServeMux()

	mux.HandleFunc("GET /user/ws-ticket", func(w http.ResponseWriter, r *http.Request) {

		w.Write([]byte(`"ticket-1"`))

	})

	mux.HandleFunc("GET /chat/{id}", func(w http.ResponseWriter, r *http.Request) {

		json.NewEncoder(w).Encode(map[string]any{"chat": map[string]any{"id": r.PathValue("id")}, "messages": []any{}})

	})

	mux.HandleFunc("GET /v2/parrot/connect/user/{user}/ticket/{ticket}", func(w http.ResponseWriter, r *http.Request) {

		conn, err := websocket.Accept(w, r, nil)

		if err != nil {

			t.Error(err)

			return

		}

		sockets <- conn

		for {

			if _, _, err := conn.Read(context.Background()); err != nil {

				return

			}

		}

	})

	mux.HandleFunc("POST /chat/{id}/message", func(w http.ResponseWriter, r *http.Request) {

		var body struct {

			Message struct {

				Content string `json:"content"`

			} `json:"message"`

		}

		json.NewDecoder(r.Body).Decode(&body)

		chatID := r.PathValue("id")
		conn := <-sockets

		sockets <- conn

		send := func(data map[string]any) {

			encoded, _ := json.Marshal(map[string]any{"entityId": chatID, "data": data})

			conn.Write(context.Background(), websocket.MessageText, encoded)

		}

		// the stream starts before the HTTP reply, as it can with Boodle
		send(map[string]any{"type": "MessageIncrementalResponse", "chatId": chatID, "submissionId": "sub-1", "message": []any{

			map[string]any{"type": "StreamSection", "index": 0.0, "content": []any{map[string]any{"type": "Stream", "content": "echo: "}}},

		}})

		json.NewEncoder(w).Encode(map[string]any{"id": "sub-1", "chatId": chatID, "type": "User", "state": "Pending", "submission": body.Message.Content, "created": 1.0})

		go func() {

			time.Sleep(50 * time.Millisecond)

			send(map[string]any{"type": "MessageFinalResponse", "chatId": chatID, "submissionId": "sub-1", "message": []any{

				map[string]any{"type": "SectionResponse", "index": 0.0, "content": "echo: " + body.Message.Content},

			}})

		}()

	})

	return httptest.NewServer(mux)

}

func TestSessionSendWaitsForFinal(t *testing.T) {

	server := fakeBoodle(t)
	defer server.Close()

	client, err := sdk.NewClient(sdk.ClientOptions{Cookie: fakeCookie("u-1"), BaseURL: server.URL})

	if err != nil {

		t.Fatal(err)

	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	session, err := sdk.OpenSession(ctx, client, "c-1", sdk.SessionOptions{})

	if err != nil {

		t.Fatal(err)

	}

	defer session.Dispose()

	var deltas strings.Builder

	session.On(func(event sdk.SessionEvent) {

		if event.Change != nil && event.Change.Kind == sdk.ChangeDelta {

			deltas.WriteString(event.Change.Text)

		}

	})

	turn, err := session.Send(ctx, "ping", sdk.SendOptions{})

	if err != nil {

		t.Fatal(err)

	}

	if turn.Text != "echo: ping" || turn.Status != sdk.TurnComplete {

		t.Fatalf("unexpected turn %+v", turn)

	}

	if deltas.String() != "echo: " {

		t.Fatalf("deltas %q", deltas.String())

	}

}
