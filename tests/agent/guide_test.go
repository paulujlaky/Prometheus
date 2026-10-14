package agent_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"boombox/agent"
	"boombox/agent/protocol"
	"boombox/sdk"
	"boombox/store"
)

func TestGuideVersionRemintsExistingBotsOnceAndRetriesFailure(t *testing.T) {

	st, userID := openStore(t)
	row, err := st.CreateAgent(userID, "Scout", "model-1", "Be brief.")

	if err != nil {

		t.Fatal(err)

	}

	st.WriteMemory(row, "Keep my preferences")
	instructions := protocol.BotInstructions(row.Name, row.Persona)
	sum := sha256.Sum256([]byte(row.ModelID + "\n" + instructions))
	digest := hex.EncodeToString(sum[:12])
	currentHash := fmt.Sprintf("s%d:%s", protocol.GuideVersion, digest)
	legacyHash := "s" + digest

	if err := st.SaveBot(row.ID, "old-draft", "old-bot", legacyHash); err != nil {

		t.Fatal(err)

	}

	created := 0
	deleted := []string{}
	failPublish := false
	mux := http.NewServeMux()
	writeJSON := func(w http.ResponseWriter, value any) { json.NewEncoder(w).Encode(value) }

	mux.HandleFunc("GET /assistant/custom/drafts", func(w http.ResponseWriter, r *http.Request) {

		writeJSON(w, map[string]any{"entries": []any{map[string]any{"published": map[string]any{"id": "new-bot"}}}})

	})
	mux.HandleFunc("POST /assistant/custom/draft", func(w http.ResponseWriter, r *http.Request) {

		var input map[string]any

		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input["instructions"] != instructions || input["modelId"] != row.ModelID {

			t.Errorf("minted with wrong guide/model: %v, %v", input, err)

		}

		created++
		writeJSON(w, map[string]any{"draft": map[string]any{"id": fmt.Sprintf("draft-%d", created)}})

	})
	mux.HandleFunc("POST /assistant/custom/draft/{id}/publish", func(w http.ResponseWriter, r *http.Request) {

		if failPublish {

			http.Error(w, "publish unavailable", http.StatusServiceUnavailable)
			return

		}

		writeJSON(w, map[string]any{"published": map[string]any{"id": "new-bot"}})

	})
	mux.HandleFunc("DELETE /assistant/custom/draft/{id}", func(w http.ResponseWriter, r *http.Request) {

		saved, err := st.AgentByID(row.ID)

		if err != nil || saved.BotHash != currentHash || saved.BotDraftID == r.PathValue("id") {

			t.Errorf("old bot deleted before replacement was saved: %+v, %v", saved, err)

		}

		deleted = append(deleted, r.PathValue("id"))
		writeJSON(w, map[string]any{})

	})
	// Stop after bot preparation so this test needs no streaming chat connection.
	mux.HandleFunc("POST /chat", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "chat boundary", http.StatusServiceUnavailable) })
	server := httptest.NewServer(mux)
	defer server.Close()

	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"userId":"u-1"}`))
	client, err := sdk.NewClient(sdk.ClientOptions{Cookie: "d=x." + payload + ".y", BaseURL: server.URL})

	if err != nil {

		t.Fatal(err)

	}

	run := func(want string) {

		t.Helper()
		control := agent.RunControl{Ctx: context.Background(), Listen: func(agent.RunEvent) {}}
		end := agent.RunAgent(st, client, *row, "Check guide", control)

		if end.Kind != store.KindError || !strings.Contains(end.Text, want) {

			t.Fatalf("unexpected run end: %+v", end)

		}

	}

	run("chat boundary")
	run("chat boundary")
	saved, _ := st.AgentByID(row.ID)

	if created != 1 || saved.BotHash != currentHash || !slices.Equal(deleted, []string{"old-draft"}) || st.ReadMemory(row) != "Keep my preferences" {

		t.Fatalf("refresh/reuse lost state: created %d, deleted %v, saved %+v", created, deleted, saved)

	}

	olderHash := fmt.Sprintf("s%d:%s", protocol.GuideVersion-1, digest)

	if err := st.SaveBot(row.ID, saved.BotDraftID, saved.BotAssistantID, olderHash); err != nil {

		t.Fatal(err)

	}

	failPublish = true
	run("publish unavailable")
	afterFailure, _ := st.AgentByID(row.ID)

	if created != 2 || afterFailure.BotHash != olderHash || afterFailure.BotDraftID != saved.BotDraftID || len(deleted) != 1 {

		t.Fatalf("failed refresh discarded the previous bot: %+v, deleted %v", afterFailure, deleted)

	}

	failPublish = false
	run("chat boundary")
	run("chat boundary")
	saved, _ = st.AgentByID(row.ID)

	if created != 3 || saved.BotHash != currentHash || saved.BotDraftID != "draft-3" || !slices.Equal(deleted, []string{"old-draft", "draft-1"}) {

		t.Fatalf("version refresh did not settle: created %d, deleted %v, saved %+v", created, deleted, saved)

	}

}

func TestTaskMessageLimitsWhatAnAgentCarriesOver(t *testing.T) {

	recent := []string{"- oldest task"}

	for i := 0; i < 10; i++ {

		recent = append(recent, fmt.Sprintf("- task %d %s", i, strings.Repeat("r", 590)))

	}

	agents := []string{}

	for i := 0; i < 40; i++ {

		agents = append(agents, fmt.Sprintf("Agent%d", i))

	}

	memory := strings.Repeat("a remembered line\n", 2000) + "the newest line"

	message := protocol.TaskMessage(protocol.TaskContext{

		User: strings.Repeat("u", 20000),
		Memory: memory,
		Recent: recent,
		Agents: agents,
		Now: "now",

	}, "do the thing")

	if len(message) > 20000 {

		t.Fatalf("task message is %d characters", len(message))

	}

	for _, want := range []string{"<read MEMORY.md> for the rest", "- task 9 ", ", and 16 more", "## Task\n\ndo the thing"} {

		if !strings.Contains(message, want) {

			t.Fatalf("task message is missing %q", want)

		}

	}

	for _, gone := range []string{"oldest task", "the newest line", "Agent30"} {

		if strings.Contains(message, gone) {

			t.Fatalf("task message still carries %q", gone)

		}

	}

	short := protocol.TaskMessage(protocol.TaskContext{Memory: "one line", Recent: recent[:1], Now: "now"}, "hi")

	if strings.Contains(short, "[harness]") || !strings.Contains(short, "oldest task") {

		t.Fatalf("short context is passed through: %q", short)

	}

}
