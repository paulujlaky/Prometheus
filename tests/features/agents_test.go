package features_test

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"boombox/store"
)

func TestAutomaticAgentsAndMigration(t *testing.T) {

	home := t.TempDir()
	st, err := store.Open(home)

	if err != nil {

		t.Fatal(err)

	}

	st.IssueKey("creator")
	user, _ := st.GetUser("creator")
	manual, _ := st.CreateAgent(user.ID, "Manual", "model", "")
	st.AddGroupMessage(user.ID, 0, "Manual", manual.ID, "Hello")
	st.Close()

	db, err := sql.Open("sqlite", filepath.Join(home, "pts.db"))

	if err != nil {

		t.Fatal(err)

	}

	for _, statement := range []string{"alter table agents drop column automatic", "alter table group_messages drop column kind"} {

		if _, err := db.Exec(statement); err != nil {

			t.Fatal(err)

		}

	}

	db.Close()
	st, err = store.Open(home)

	if err != nil {

		t.Fatal(err)

	}

	defer st.Close()

	manual, err = st.AgentByID(manual.ID)

	if err != nil || manual.Automatic {

		t.Fatalf("manual agent after migration: %+v %v", manual, err)

	}

	messages, err := st.ListGroupMessages(user.ID, 0, 10, store.Newest)

	if err != nil || len(messages) != 1 || messages[0].Kind != "text" {

		t.Fatalf("old messages: %+v %v", messages, err)

	}

	created, err := st.CreateAgentWithOptions(user.ID, "Analyst", "model", "Check sources.", store.AgentOptions{

		Glyph: "orbit:sky",
		Category: "Research",
		Automatic: true,

	})

	if err != nil {

		t.Fatal(err)

	}

	if !created.Automatic || created.Glyph != "orbit:sky" || created.Category != "Research" || st.ReadMemory(created) != "" {

		t.Fatalf("created %+v", created)

	}

	if _, err := st.CreateAgentWithOptions(user.ID, "analyst", "model", "", store.AgentOptions{}); err == nil {

		t.Fatal("duplicate names must fail")

	}

	for _, options := range []store.AgentOptions{{Glyph: "unknown:sky"}, {Category: strings.Repeat("x", 33)}} {

		if _, err := st.CreateAgentWithOptions(user.ID, "Invalid", "model", "", options); err == nil {

			t.Fatal("invalid options must fail")

		}

	}

	if _, err := st.AddGroupContent(user.ID, 0, created.Name, created.ID, "card", `{"blocks":[{"type":"text","text":"Hi"}]}`); err != nil {

		t.Fatal(err)

	}

	messages, _ = st.ListGroupMessages(user.ID, 0, 10, store.Newest)

	if len(messages) != 2 || messages[1].Kind != "card" {

		t.Fatalf("card history: %+v", messages)

	}

}
