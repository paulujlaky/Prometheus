package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"boombox/server"
	"boombox/store"

	"github.com/coder/websocket"
)

type harness struct {

	t *testing.T
	st *store.Store
	base string
	token string
	userID int64

}

func newHarness(t *testing.T) *harness {

	st, err := store.Open(t.TempDir())

	if err != nil {

		t.Fatal(err)

	}

	t.Cleanup(func() { st.Close() })

	srv, err := server.New(st, t.TempDir())

	if err != nil {

		t.Fatal(err)

	}

	httpServer := httptest.NewServer(srv)

	t.Cleanup(httpServer.Close)

	token, _ := st.IssueKey("tester")
	user, _ := st.GetUser("tester")

	return &harness{t: t, st: st, base: httpServer.URL, token: token, userID: user.ID}

}

func (h *harness) as(key, method, path string, body any) (int, any, http.Header) {

	h.t.Helper()

	var reader *bytes.Reader

	if body != nil {

		encoded, _ := json.Marshal(body)
		reader = bytes.NewReader(encoded)

	} else {

		reader = bytes.NewReader(nil)

	}

	req, _ := http.NewRequest(method, h.base+path, reader)

	if key != "" {

		req.Header.Set("Authorization", "Bearer "+key)

	}

	req.Header.Set("Content-Type", "application/json")

	res, err := http.DefaultClient.Do(req)

	if err != nil {

		h.t.Fatal(err)

	}

	defer res.Body.Close()

	var decoded any

	json.NewDecoder(res.Body).Decode(&decoded)

	return res.StatusCode, decoded, res.Header

}

func (h *harness) call(method, path string, body any) (int, any) {

	h.t.Helper()

	status, decoded, _ := h.as(h.token, method, path, body)

	return status, decoded

}

func field(value any, key string) any {

	object, _ := value.(map[string]any)

	return object[key]

}

func id(value any) int64 {

	number, _ := field(value, "id").(float64)

	return int64(number)

}

func TestEverythingButLoginNeedsAKey(t *testing.T) {

	h := newHarness(t)

	if status, _, _ := h.as("", "GET", "/api/agents", nil); status != 401 {

		t.Fatalf("no key: %d", status)

	}

	if status, _, _ := h.as("nope", "GET", "/api/agents", nil); status != 401 {

		t.Fatalf("bad key: %d", status)

	}

	if status, _, _ := h.as("", "POST", "/api/login", map[string]any{"key": "nope"}); status != 401 {

		t.Fatalf("wrong login: %d", status)

	}

	_, _, header := h.as("", "POST", "/api/login", map[string]any{"key": h.token})
	cookie := header.Get("Set-Cookie")

	if !strings.Contains(cookie, "HttpOnly") {

		t.Fatalf("cookie %q", cookie)

	}

	req, _ := http.NewRequest("GET", h.base+"/api/agents", nil)
	req.Header.Set("Cookie", strings.Split(cookie, ";")[0])

	res, err := http.DefaultClient.Do(req)

	if err != nil || res.StatusCode != 200 {

		t.Fatalf("cookie sign-in: %v %v", err, res.StatusCode)

	}

	res.Body.Close()

}

func TestAgentsAreCreatedChangedRememberedAndDeleted(t *testing.T) {

	h := newHarness(t)

	status, created := h.call("POST", "/api/agents", map[string]any{"name": "Tester", "modelId": "model-1"})

	if status != 201 || field(created, "name") != "Tester" || field(created, "persona") != "" || field(created, "state") != "idle" {

		t.Fatalf("created %d %v", status, created)

	}

	agentID := id(created)

	if status, _ := h.call("POST", "/api/agents", map[string]any{"name": "Modelless"}); status != 503 {

		t.Fatalf("modelless %d", status)

	}

	if _, settings := h.call("GET", "/api/settings", nil); field(settings, "defaultModel") != nil || field(settings, "timezone") != nil {

		t.Fatalf("settings %v", settings)

	}

	if status, _ := h.call("POST", "/api/agents", map[string]any{"name": "tester", "modelId": "model-1"}); status != 400 {

		t.Fatalf("duplicate %d", status)

	}

	if _, patched := h.call("PATCH", fmt.Sprintf("/api/agents/%d", agentID), map[string]any{"persona": "Terse."}); field(patched, "persona") != "Terse." {

		t.Fatalf("patched %v", patched)

	}

	h.call("PUT", fmt.Sprintf("/api/agents/%d/memory", agentID), map[string]any{"text": "- likes tea"})

	if _, memory := h.call("GET", fmt.Sprintf("/api/agents/%d/memory", agentID), nil); field(memory, "text") != "- likes tea" {

		t.Fatalf("memory %v", memory)

	}

	if _, events := h.call("GET", fmt.Sprintf("/api/agents/%d/events", agentID), nil); fmt.Sprint(events) != "[]" {

		t.Fatalf("events %v", events)

	}

	if status, _ := h.call("POST", fmt.Sprintf("/api/agents/%d/messages", agentID), map[string]any{"text": "hi"}); status != 503 {

		t.Fatalf("message without cookie %d", status)

	}

	if status, _ := h.call("DELETE", fmt.Sprintf("/api/agents/%d", agentID), nil); status != 200 {

		t.Fatalf("delete %d", status)

	}

	if status, _ := h.call("GET", fmt.Sprintf("/api/agents/%d", agentID), nil); status != 404 {

		t.Fatalf("deleted agent %d", status)

	}

}

func TestRoutinesAreValidatedEditedAndRemoved(t *testing.T) {

	h := newHarness(t)

	_, created := h.call("POST", "/api/agents", map[string]any{"name": "Router", "modelId": "model-1"})
	path := fmt.Sprintf("/api/agents/%d/routines", id(created))

	if status, _ := h.call("POST", path, map[string]any{"kind": "schedule", "spec": "every morning", "task": "x"}); status != 400 {

		t.Fatalf("bad cron %d", status)

	}

	if status, _ := h.call("POST", path, map[string]any{"kind": "watch", "spec": "5", "task": "x"}); status != 400 {

		t.Fatalf("watch without target %d", status)

	}

	status, routine := h.call("POST", path, map[string]any{"kind": "watch", "spec": "5", "target": "https://example.com", "task": "Tell me what changed"})

	if status != 201 || field(routine, "kind") != "watch" || field(routine, "enabled") != true || field(routine, "lastOutput") != nil {

		t.Fatalf("routine %d %v", status, routine)

	}

	routinePath := fmt.Sprintf("/api/routines/%d", id(routine))

	if _, paused := h.call("PATCH", routinePath, map[string]any{"enabled": false}); field(paused, "enabled") != false {

		t.Fatalf("paused %v", paused)

	}

	if _, list := h.call("GET", path, nil); len(list.([]any)) != 1 {

		t.Fatalf("list %v", list)

	}

	if status, _ := h.call("DELETE", routinePath, nil); status != 200 {

		t.Fatalf("delete %d", status)

	}

	if status, _ := h.call("DELETE", routinePath, nil); status != 404 {

		t.Fatalf("delete again %d", status)

	}

	if status, _ := h.call("POST", "/api/group", map[string]any{"text": "hi all"}); status != 503 {

		t.Fatalf("group without cookie %d", status)

	}

	if _, messages := h.call("GET", "/api/group", nil); fmt.Sprint(messages) != "[]" {

		t.Fatalf("messages %v", messages)

	}

}

func TestCategoriesGroupChatsAndUnreadCounts(t *testing.T) {

	h := newHarness(t)

	make := func(name string) int64 {

		_, created := h.call("POST", "/api/agents", map[string]any{"name": name, "modelId": "model-1"})

		return id(created)

	}

	a, b := make("Ann"), make("Bob")

	if _, patched := h.call("PATCH", fmt.Sprintf("/api/agents/%d", a), map[string]any{"category": " Research "}); field(patched, "category") != "Research" {

		t.Fatalf("category %v", patched)

	}

	if status, _ := h.call("POST", "/api/groups", map[string]any{"members": []int64{a, a}}); status != 400 {

		t.Fatalf("one-member group %d", status)

	}

	_, group := h.call("POST", "/api/groups", map[string]any{"members": []int64{a, b}})

	if field(group, "name") != "Ann, Bob" || field(group, "unread") != 0.0 {

		t.Fatalf("group %v", group)

	}

	groupID := id(group)

	h.st.AddEvent(a, "r1", "say", "On it.")
	h.st.AddEvent(a, "r1", "done", "Wait.")
	h.st.AddEvent(a, "r1", "done", "Found it.")
	h.st.AddGroupMessage(h.userID, groupID, "Bob", b, "Hi.")
	h.st.AddGroupMessage(h.userID, groupID, "user", 0, "Mine.")

	if _, view := h.call("GET", fmt.Sprintf("/api/agents/%d", a), nil); field(view, "unread") != 2.0 {

		t.Fatalf("unread %v", view)

	}

	_, groups := h.call("GET", "/api/groups", nil)
	unread := []float64{}

	for _, one := range groups.([]any) {

		unread = append(unread, field(one, "unread").(float64))

	}

	if !slices.Equal(unread, []float64{0, 1}) {

		t.Fatalf("group unread %v", unread)

	}

	h.call("POST", "/api/read", map[string]any{"agent": a})
	h.call("POST", "/api/read", map[string]any{"group": groupID})

	if _, view := h.call("GET", fmt.Sprintf("/api/agents/%d", a), nil); field(view, "unread") != 0.0 {

		t.Fatalf("read %v", view)

	}

	if _, messages := h.call("GET", fmt.Sprintf("/api/group?group=%d", groupID), nil); len(messages.([]any)) != 2 {

		t.Fatalf("messages %v", messages)

	}

	if status, _ := h.call("DELETE", "/api/groups/0", nil); status != 404 {

		t.Fatalf("delete Everyone %d", status)

	}

	if status, _ := h.call("DELETE", fmt.Sprintf("/api/groups/%d", groupID), nil); status != 200 {

		t.Fatalf("delete group %d", status)

	}

	if status, _ := h.call("GET", fmt.Sprintf("/api/group?group=%d", groupID), nil); status != 404 {

		t.Fatalf("deleted group %d", status)

	}

}

func TestUsersOnlySeeTheirOwn(t *testing.T) {

	h := newHarness(t)
	other, _ := h.st.IssueKey("other")

	make := func(key, name string) int64 {

		_, created, _ := h.as(key, "POST", "/api/agents", map[string]any{"name": name, "modelId": "model-1"})

		return id(created)

	}

	mine, theirs := make(h.token, "Private"), make(other, "Private")

	if theirs == 0 {

		t.Fatal("names are unique per user only")

	}

	if _, list, _ := h.as(other, "GET", "/api/agents", nil); len(list.([]any)) != 1 || id(list.([]any)[0]) != theirs {

		t.Fatalf("list %v", list)

	}

	for _, check := range []struct {

		method string
		path string
		body any
		want int

	}{

		{"GET", fmt.Sprintf("/api/agents/%d", mine), nil, 404},
		{"DELETE", fmt.Sprintf("/api/agents/%d", mine), nil, 404},
		{"PUT", fmt.Sprintf("/api/agents/%d/memory", mine), map[string]any{"text": "x"}, 404},
		{"POST", "/api/groups", map[string]any{"members": []int64{mine, theirs}}, 400},
		{"POST", "/api/read", map[string]any{"agent": mine}, 404},

	} {

		if status, _, _ := h.as(other, check.method, check.path, check.body); status != check.want {

			t.Errorf("%s %s: %d, want %d", check.method, check.path, status, check.want)

		}

	}

	h.st.AddGroupMessage(h.userID, 0, "user", 0, "Everyone private")

	if _, messages, _ := h.as(other, "GET", "/api/group", nil); fmt.Sprint(messages) != "[]" {

		t.Fatalf("messages %v", messages)

	}

	if _, cookie, _ := h.as(other, "GET", "/api/cookie", nil); field(cookie, "set") != false {

		t.Fatalf("cookie %v", cookie)

	}

	fresh, _ := h.st.IssueKey("other")

	if status, _, _ := h.as(other, "GET", "/api/agents", nil); status != 401 {

		t.Fatalf("old key %d", status)

	}

	if status, _, _ := h.as(fresh, "GET", "/api/agents", nil); status != 200 {

		t.Fatalf("new key %d", status)

	}

}

func TestTimeZoneIsSavedOrRejected(t *testing.T) {

	h := newHarness(t)

	if status, _ := h.call("PUT", "/api/settings", map[string]any{"timezone": "Not/AZone"}); status != 400 {

		t.Fatalf("bad zone %d", status)

	}

	if status, _ := h.call("PUT", "/api/settings", map[string]any{}); status != 400 {

		t.Fatalf("empty %d", status)

	}

	if _, saved := h.call("PUT", "/api/settings", map[string]any{"timezone": "America/New_York"}); field(saved, "timezone") != "America/New_York" || field(saved, "defaultModel") != nil {

		t.Fatalf("saved %v", saved)

	}

	if _, cleared := h.call("PUT", "/api/settings", map[string]any{"timezone": "  "}); field(cleared, "timezone") != nil {

		t.Fatalf("cleared %v", cleared)

	}

}

func TestPushKeyIsStableAndSocketNeedsAuth(t *testing.T) {

	h := newHarness(t)

	_, first := h.call("GET", "/api/push", nil)
	_, second := h.call("GET", "/api/push", nil)

	if key, ok := field(first, "publicKey").(string); !ok || key == "" || key != field(second, "publicKey") {

		t.Fatalf("keys %v %v", first, second)

	}

	url := "ws" + strings.TrimPrefix(h.base, "http") + "/api/ws"
	ws, _, err := websocket.Dial(context.Background(), url, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + h.token}}})

	if err != nil {

		t.Fatalf("authorized socket: %v", err)

	}

	ws.Close(websocket.StatusNormalClosure, "")

	if _, _, err := websocket.Dial(context.Background(), url, nil); err == nil {

		t.Fatal("an unauthorized socket must be refused")

	}

}
