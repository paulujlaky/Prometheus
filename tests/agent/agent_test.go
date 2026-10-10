package agent_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"boombox/agent"
	"boombox/features"
	"boombox/sdk"
	"boombox/store"

	"github.com/coder/websocket"
)

func eventually(t *testing.T, check func() bool) {

	t.Helper()

	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {

		if check() {

			return

		}

	}

	t.Fatal("condition never held")

}

func TestQueueCapsFoldsAndStops(t *testing.T) {

	worker := func(id int64) store.Agent { return store.Agent{ID: id, Name: "a"} }

	var mu sync.Mutex

	finish := map[int64]chan struct{}{}
	started := []string{}
	states := [][2]any{}
	notes := []string{}
	aborted := false

	queue := agent.NewQueue(func(job store.Agent, task string, control agent.RunControl, origin *features.Origin) {

		done := make(chan struct{})

		mu.Lock()
		started = append(started, string(rune('0'+job.ID))+":"+task)
		finish[job.ID] = done
		mu.Unlock()

		select {

		case <-done:

			mu.Lock()
			notes = control.TakeNotes()
			mu.Unlock()

		case <-control.Ctx.Done():

			mu.Lock()
			aborted = true
			mu.Unlock()

		}

	}, func(agent.RunEvent) {}, func(id int64, state agent.State) {

		mu.Lock()
		states = append(states, [2]any{id, state})
		mu.Unlock()

	}, 2)

	queue.Send(worker(1), "one")
	queue.Send(worker(2), "two")

	eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(started) == 2 })

	queue.Send(worker(3), "three")
	queue.Send(worker(3), "three again")
	queue.Send(worker(1), "note for one")

	if queue.State(3) != agent.Queued {

		t.Fatalf("agent 3 is %s", queue.State(3))

	}

	mu.Lock()
	close(finish[1])
	mu.Unlock()

	eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(started) == 3 })

	mu.Lock()

	if !slices.Equal(notes, []string{"note for one"}) || started[2] != "3:three\n\nthree again" {

		t.Fatalf("notes %v started %v", notes, started)

	}

	mu.Unlock()

	queue.Stop(2)

	eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return aborted })

	mu.Lock()
	defer mu.Unlock()

	if !slices.ContainsFunc(states, func(s [2]any) bool { return s[0] == int64(3) && s[1] == agent.Running }) {

		t.Fatalf("states %v", states)

	}

}

func TestRunAsksAndHearsAnswersOrStop(t *testing.T) {

	answers := make(chan agent.Reply, 3)

	queue := agent.NewQueue(func(_ store.Agent, _ string, control agent.RunControl, _ *features.Origin) {

		answers <- control.Ask("Send it?", agent.WaitAsk)
		answers <- control.Ask("Which one?\n- A\n- B", agent.WaitQuestion)
		answers <- control.Ask("Sign in to GitHub", agent.WaitHandoff)

	}, func(agent.RunEvent) {}, nil, 1)

	queue.Send(store.Agent{ID: 7}, "go")

	eventually(t, func() bool { return queue.State(7) == agent.Waiting })

	if question, _ := queue.Question(7); question != "Send it?" || !queue.Answer(7, agent.Allow(true), "") {

		t.Fatal("the approval is waiting")

	}

	eventually(t, func() bool { _, kind := queue.Question(7); return kind == agent.WaitQuestion })

	if !queue.Answer(7, agent.Answer("B"), agent.WaitQuestion) {

		t.Fatal("the question is waiting")

	}

	eventually(t, func() bool { _, kind := queue.Question(7); return kind == agent.WaitHandoff })

	// handing the browser back must never answer a <submit>, and an approval must not end a handoff
	if queue.Answer(7, agent.Allow(true), agent.WaitAsk) {

		t.Fatal("an approval answered a handoff")

	}

	queue.Stop(7)

	got := []agent.Reply{<-answers, <-answers, <-answers}

	if !got[0].Allow || got[1].Text != "B" || got[2].Allow {

		t.Fatalf("answers %+v", got)

	}

	eventually(t, func() bool { return queue.State(7) == agent.Idle })

}

func TestFreeSlotGoesToTheUserWithFewestRuns(t *testing.T) {

	var mu sync.Mutex

	started := []int64{}
	finish := map[int64]chan struct{}{}

	queue := agent.NewQueue(func(job store.Agent, _ string, _ agent.RunControl, _ *features.Origin) {

		done := make(chan struct{})

		mu.Lock()
		started = append(started, job.ID)
		finish[job.ID] = done
		mu.Unlock()

		<-done

	}, func(agent.RunEvent) {}, nil, 2)

	for _, id := range []int64{1, 2, 3} {

		queue.Enqueue(store.Agent{ID: id, UserID: 1}, "burst", nil)

	}

	queue.Enqueue(store.Agent{ID: 9, UserID: 2}, "mine", nil)

	eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(started) == 2 })

	mu.Lock()
	close(finish[started[0]])
	mu.Unlock()

	eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(started) == 3 })

	mu.Lock()
	defer mu.Unlock()

	if started[2] != 9 {

		t.Fatalf("started %v", started)

	}

}

func TestHandoffToABusyAgentRunsAfterItsCurrentRun(t *testing.T) {

	var mu sync.Mutex

	tasks := []string{}
	release := make(chan struct{})

	queue := agent.NewQueue(func(_ store.Agent, task string, _ agent.RunControl, _ *features.Origin) {

		mu.Lock()
		tasks = append(tasks, task)
		first := len(tasks) == 1
		mu.Unlock()

		if first {

			<-release

		}

	}, func(agent.RunEvent) {}, nil, 2)

	queue.Enqueue(store.Agent{ID: 2}, "wait for A", &features.Origin{Chain: 5})

	eventually(t, func() bool { return queue.State(2) == agent.Running })

	// the same chain, a hop later: it waits for the run, then runs on its own
	queue.Enqueue(store.Agent{ID: 2}, "A's number", &features.Origin{Chain: 5, Hops: 1})

	// a different conversation never folds into it, or its reply would go astray
	queue.Enqueue(store.Agent{ID: 2}, "from C", &features.Origin{Chain: 9, Direct: true, ReplyTo: 3})
	queue.Enqueue(store.Agent{ID: 2}, "from C again", &features.Origin{Chain: 9, Direct: true, ReplyTo: 3})

	if queue.State(2) != agent.Running {

		t.Fatal("the agent is still on its first run")

	}

	close(release)

	eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(tasks) == 3 })

	mu.Lock()
	defer mu.Unlock()

	if tasks[1] != "A's number" || tasks[2] != "from C\n\nfrom C again" {

		t.Fatalf("tasks %q", tasks)

	}

}

type fakeDeleter struct {

	mu sync.Mutex
	deleted []string
	statuses map[string]int

}

func (f *fakeDeleter) DeleteChat(_ context.Context, id string) error {

	f.mu.Lock()
	defer f.mu.Unlock()

	f.deleted = append(f.deleted, id)

	if status := f.statuses[id]; status != 200 {

		return &sdk.APIError{Method: "DELETE", Path: "/chat/" + id, Status: status, StatusText: "Error"}

	}

	return nil

}

func openStore(t *testing.T) (*store.Store, int64) {

	st, err := store.Open(t.TempDir())

	if err != nil {

		t.Fatal(err)

	}

	t.Cleanup(func() { st.Close() })

	st.IssueKey("runner")
	user, _ := st.GetUser("runner")

	return st, user.ID

}

func TestFinishedChatsAreDroppedAndFailuresStayTracked(t *testing.T) {

	st, userID := openStore(t)
	client := &fakeDeleter{statuses: map[string]int{"ok": 200, "gone": 404, "down": 503}}

	for id := range client.statuses {

		st.TrackChat(id, 7, userID)

	}

	st.TrackChat("other", 8, userID)

	chats, _ := st.TrackedChats(userID, 7)

	agent.DropChats(st, client, chats)

	left, _ := st.TrackedChats(userID, 0)

	slices.Sort(left)
	slices.Sort(client.deleted)

	if !slices.Equal(client.deleted, []string{"down", "gone", "ok"}) || !slices.Equal(left, []string{"down", "other"}) {

		t.Fatalf("deleted %v left %v", client.deleted, left)

	}

}

// scriptedBoodle replies to each message with the next scripted answer and records what it was sent.
func scriptedBoodle(t *testing.T, replies []string) (*httptest.Server, *[]string) {

	var mu sync.Mutex

	sent := []string{}
	sockets := make(chan *websocket.Conn, 1)
	mux := http.NewServeMux()

	writeJSON := func(w http.ResponseWriter, value any) { json.NewEncoder(w).Encode(value) }

	mux.HandleFunc("GET /assistant/custom/drafts", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"total": 0, "entries": []any{}}) })
	mux.HandleFunc("POST /assistant/custom/draft", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"draft": map[string]any{"id": "draft-1"}}) })
	mux.HandleFunc("POST /assistant/custom/draft/{id}/publish", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"draft": map[string]any{"id": "draft-1"}, "published": map[string]any{"id": "bot-1"}}) })
	mux.HandleFunc("POST /chat", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"chat": map[string]any{"id": "chat-1"}}) })
	mux.HandleFunc("GET /chat/{id}", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{"chat": map[string]any{"id": "chat-1"}, "messages": []any{}}) })
	mux.HandleFunc("DELETE /chat/{id}", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]any{}) })
	mux.HandleFunc("GET /user/ws-ticket", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`"t"`)) })

	mux.HandleFunc("GET /v2/parrot/connect/user/{user}/ticket/{ticket}", func(w http.ResponseWriter, r *http.Request) {

		conn, err := websocket.Accept(w, r, nil)

		if err != nil {

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

		mu.Lock()
		index := len(sent)
		sent = append(sent, body.Message.Content)
		mu.Unlock()

		reply := "<done>\nout of script\n</done>"

		if index < len(replies) {

			reply = replies[index]

		}

		submission := "sub-" + string(rune('a'+index))

		writeJSON(w, map[string]any{"id": submission, "type": "User", "state": "Pending"})

		conn := <-sockets
		sockets <- conn

		go func() {

			final, _ := json.Marshal(map[string]any{"entityId": "chat-1", "data": map[string]any{"type": "MessageFinalResponse", "chatId": "chat-1", "submissionId": submission, "message": []any{map[string]any{"type": "SectionResponse", "index": 0.0, "content": reply}}}})

			time.Sleep(20 * time.Millisecond)
			conn.Write(context.Background(), websocket.MessageText, final)

		}()

	})

	return httptest.NewServer(mux), &sent

}

func TestRunWritesMemoryAndEndsWithDone(t *testing.T) {

	st, userID := openStore(t)
	agentRow, err := st.CreateAgent(userID, "Scout", "model-1", "Be brief.")

	if err != nil {

		t.Fatal(err)

	}

	server, sent := scriptedBoodle(t, []string{

		"note it\n<write MEMORY.md>\n- Prefers aisle seats\n</write>\n\ncheck\n<ls>\n</ls>\n\n<done>\ntoo early\n</done>",
		"<done>\nSaved.\n</done>",

	})

	defer server.Close()

	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"userId":"u-1"}`))
	client, _ := sdk.NewClient(sdk.ClientOptions{Cookie: "d=x." + payload + ".y", BaseURL: server.URL})
	events := []agent.RunEvent{}

	var mu sync.Mutex

	control := agent.RunControl{

		Ctx: context.Background(),
		TakeNotes: func() []string { return nil },
		Ask: func(string, agent.WaitKind) agent.Reply { return agent.Allow(false) },

		Listen: func(event agent.RunEvent) {

			mu.Lock()
			events = append(events, event)
			mu.Unlock()

		},

	}

	end := agent.RunAgent(st, client, *agentRow, "Remember I like aisle seats", control)

	if end.Kind != store.KindDone || end.Text != "Saved." {

		t.Fatalf("ended %+v", end)

	}

	if memory := st.ReadMemory(agentRow); memory != "- Prefers aisle seats\n" {

		t.Fatalf("memory %q", memory)

	}

	if len(*sent) != 2 || !strings.Contains((*sent)[0], "## Task\n\nRemember I like aisle seats") || !strings.Contains((*sent)[1], "[write ok]") || !strings.Contains((*sent)[1], "[ls ok]") || !strings.Contains((*sent)[1], "[ls ok]") || !strings.Contains((*sent)[1], "Your <done> was held") {

		t.Fatalf("sent %q", *sent)

	}

	saved, _ := st.AgentByID(agentRow.ID)

	if saved.BotAssistantID != "bot-1" {

		t.Fatalf("bot %+v", saved)

	}

	if chats, _ := st.TrackedChats(userID, agentRow.ID); len(chats) != 0 {

		t.Fatalf("chats left %v", chats)

	}

	if _, err := os.Stat(filepath.Join(st.Workspace(agentRow), "MEMORY.md")); err != nil {

		t.Fatal(err)

	}

	kinds := []store.EventKind{}

	for _, event := range events {

		kinds = append(kinds, event.Event.Kind)

	}

	if !slices.Equal(kinds, []store.EventKind{store.KindTask, store.KindAssistant, store.KindResult, store.KindAssistant, store.KindDone}) {

		t.Fatalf("kinds %v", kinds)

	}

}

func TestStoppedRunSaysSo(t *testing.T) {

	st, userID := openStore(t)
	agentRow, _ := st.CreateAgent(userID, "Waiter", "model-1", "")
	server, _ := scriptedBoodle(t, []string{"<ask>\nWhich one?\n- A\n</ask>"})

	defer server.Close()

	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"userId":"u-1"}`))
	client, _ := sdk.NewClient(sdk.ClientOptions{Cookie: "d=x." + payload + ".y", BaseURL: server.URL})
	ctx, cancel := context.WithCancel(context.Background())

	control := agent.RunControl{

		Ctx: ctx,
		TakeNotes: func() []string { return nil },

		Ask: func(string, agent.WaitKind) agent.Reply {

			cancel()

			return agent.Allow(false)

		},

		Listen: func(agent.RunEvent) {},

	}

	if end := agent.RunAgent(st, client, *agentRow, "pick", control); end.Kind != store.KindError || end.Text != agent.StoppedText {

		t.Fatalf("ended %+v", end)

	}

	if errors.Is(ctx.Err(), context.Canceled) == false {

		t.Fatal("context should be cancelled")

	}

}

func TestMentionOutsideDoneIsHeldOnce(t *testing.T) {

	st, userID := openStore(t)
	scout, _ := st.CreateAgent(userID, "Scout", "model-1", "")
	st.CreateAgent(userID, "Pen", "model-1", "")

	server, sent := scriptedBoodle(t, []string{

		"@Pen please work out 12*12.\n\n<done>\nWaiting for Pen.\n</done>",
		"<done>\n@Pen please work out 12*12.\n</done>",

	})

	defer server.Close()

	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"userId":"u-1"}`))
	client, _ := sdk.NewClient(sdk.ClientOptions{Cookie: "d=x." + payload + ".y", BaseURL: server.URL})
	control := agent.RunControl{Ctx: context.Background(), TakeNotes: func() []string { return nil }, Ask: func(string, agent.WaitKind) agent.Reply { return agent.Allow(false) }, Listen: func(agent.RunEvent) {}}

	end := agent.RunAgent(st, client, *scout, "Ask @Pen for 12*12.", control)

	if end.Kind != store.KindDone || end.Text != "@Pen please work out 12*12." {

		t.Fatalf("ended %+v", end)

	}

	if len(*sent) != 2 || !strings.Contains((*sent)[1], "you mentioned @Pen outside it") || !strings.Contains((*sent)[0], "## Other agents\n\nPen") {

		t.Fatalf("sent %q", *sent)

	}

}
