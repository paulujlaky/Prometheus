package tools_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"boombox/agent/protocol"
	"boombox/agent/tools"
)

func TestParsesLabelledBlocksAliasesAndUnclosedTail(t *testing.T) {

	actions := protocol.ParseActions("thinking first\n\nread the plan\n<cat notes/plan.md>\n</cat>\n\n<ignored>\n\nsave it\n<write path=\"a.md\">\nhello\n</write>\n\n<done>\nall good")

	want := [][3]string{{"read", "notes/plan.md", "read the plan"}, {"write", "a.md", "save it"}, {"done", "", ""}}

	if len(actions) != len(want) {

		t.Fatalf("got %d actions: %+v", len(actions), actions)

	}

	for i, action := range actions {

		if string(action.Verb) != want[i][0] || action.Path != want[i][1] || action.Label != want[i][2] {

			t.Errorf("action %d: %+v", i, action)

		}

	}

	if actions[1].Body != "hello" || actions[2].Body != "all good" {

		t.Fatalf("bodies %q %q", actions[1].Body, actions[2].Body)

	}

	mentioned := protocol.ParseActions("I should use the `<run>` block here.\n\n<run>\nwhoami\n</run>")

	if len(mentioned) != 1 || mentioned[0].Body != "whoami" {

		t.Fatalf("got %+v", mentioned)

	}

	question := protocol.ParseQuestion("Which one?\n- The 7:05\n2. The 9:40\n+ Other")

	if question.Prompt != "Which one?" || strings.Join(question.Choices, "|") != "The 7:05|The 9:40" || question.Write != "Other" {

		t.Fatalf("question %+v", question)

	}

	if protocol.ParseQuestion("What's the address?").Write != "Your answer" {

		t.Fatal("a question without choices takes a written answer")

	}

}

func TestEditsMatchExactlyThenLooselyAndRollBack(t *testing.T) {

	cwd := t.TempDir()
	file := filepath.Join(cwd, "a.ts")

	os.WriteFile(file, []byte("function a() {\n\n    return 1;\n\n}\n"), 0o644)

	if result := tools.ApplyEdit(cwd, "a.ts", "@@ FIND\n  return 1;\n@@ REPLACE\n  return 2;"); !result.OK {

		t.Fatalf("edit failed: %s", result.Text)

	}

	if data, _ := os.ReadFile(file); string(data) != "function a() {\n\n    return 2;\n\n}\n" {

		t.Fatalf("got %q", data)

	}

	miss := tools.ApplyEdit(cwd, "a.ts", "@@ FIND\nreturn 2;\n@@ REPLACE\nreturn 3;\n@@ FIND\nreturn 99;\n@@ REPLACE\nreturn 4;")

	if miss.OK || !strings.Contains(miss.Text, "Closest match") {

		t.Fatalf("miss %+v", miss)

	}

	if data, _ := os.ReadFile(file); strings.Contains(string(data), "return 3;") {

		t.Fatal("a failed block must leave the file untouched")

	}

}

func TestPathsCannotLeaveTheWorkspace(t *testing.T) {

	cwd := t.TempDir()

	if _, err := tools.RelPath("../secret", cwd); err == nil {

		t.Fatal("../ must be refused")

	}

	if result := tools.Execute(context.Background(), protocol.Action{Verb: "read", Body: "../../etc/passwd"}, cwd, ""); result.OK {

		t.Fatal("reading outside must fail")

	}

	outside := t.TempDir()

	os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("hidden"), 0o644)

	if err := os.Symlink(outside, filepath.Join(cwd, "escape")); err == nil {

		if result := tools.Execute(context.Background(), protocol.Action{Verb: "read", Body: "escape/secret.txt"}, cwd, ""); result.OK {

			t.Fatal("a link out of the workspace must not be followed")

		}

	}

}

func TestFileVerbs(t *testing.T) {

	cwd := t.TempDir()
	run := func(verb, path, body string) protocol.Result {

		return tools.Execute(context.Background(), protocol.Action{Verb: protocol.Verb(verb), Path: path, Body: body}, cwd, "")

	}

	if result := run("write", "notes/plan.md", "- [ ] book the venue\n- [ ] send invites"); !result.OK || result.Text != "created notes/plan.md  2 lines" {

		t.Fatalf("write %+v", result)

	}

	if result := run("ls", "", ""); !result.OK || !strings.Contains(result.Text, "notes/  1 files") {

		t.Fatalf("ls %+v", result)

	}

	if result := run("read", "", "notes/plan.md 2"); !result.OK || !strings.Contains(result.Text, "2  - [ ] send invites") {

		t.Fatalf("read %+v", result)

	}

	if result := run("grep", "", "invites"); !result.OK || !strings.HasPrefix(result.Text, "1 match in 1 file") {

		t.Fatalf("grep %+v", result)

	}

	if result := run("grep", "", "/v[ae]nue/"); !result.OK || !strings.Contains(result.Text, "book the venue") {

		t.Fatalf("grep regex %+v", result)

	}

	if result := run("run", "", "cat notes/plan.md"); result.OK {

		t.Fatal("reading through the shell is refused")

	}

	if result := run("delete", "MEMORY.md", ""); result.OK {

		t.Fatal("MEMORY.md cannot be deleted")

	}

	if result := run("delete", "notes", ""); !result.OK || result.Text != "deleted notes" {

		t.Fatalf("delete %+v", result)

	}

}

func TestUnclosedShortBlocksEndWhereTheNextBlockOpens(t *testing.T) {

	reply := "Reading the plan first.\n\n<read plan.md>\n\n<done>\nIt is ticked.\n</done>"
	actions := protocol.ParseActions(reply)

	if len(actions) != 2 || actions[0].Verb != "read" || actions[0].Path != "plan.md" || actions[0].Body != "" || actions[1].Verb != "done" || actions[1].Body != "It is ticked." {

		t.Fatalf("actions %+v", actions)

	}

	// a file's own content may hold tags, so an unclosed write still runs to the end
	written := protocol.ParseActions("<write page.html>\n<p>Hi</p>\n<input name=\"q\">\n")

	if len(written) != 1 || !strings.Contains(written[0].Body, "<input") {

		t.Fatalf("write %+v", written)

	}

	if prose := protocol.Prose(reply, actions); strings.TrimSpace(prose) != "Reading the plan first." {

		t.Fatalf("prose %q", prose)

	}

}

func TestFileOnTheBodysFirstLineStillCounts(t *testing.T) {

	cwd := t.TempDir()

	for _, reply := range []string{"<write>plan.md\n# Party\n- [ ] book the venue\n</write>", "<edit>plan.md\n@@ FIND\n- [ ] book the venue\n@@ REPLACE\n- [x] book the venue\n</edit>"} {

		action := protocol.ParseActions(reply)[0]

		if result := tools.Execute(context.Background(), action, cwd, ""); !result.OK {

			t.Fatalf("%s: %s", action.Verb, result.Text)

		}

	}

	if data, _ := os.ReadFile(filepath.Join(cwd, "plan.md")); string(data) != "# Party\n- [x] book the venue\n" {

		t.Fatalf("plan.md %q", data)

	}

	// a body that is only content is still refused, saying where the file goes
	result := tools.Execute(context.Background(), protocol.Action{Verb: "edit", Body: "@@ FIND\nx\n@@ REPLACE\ny"}, cwd, "")

	if result.OK || !strings.Contains(result.Text, "edit needs its file on the tag") {

		t.Fatalf("result %+v", result)

	}

}

func TestEditClosedAroundItsPathTakesThePairsAfterIt(t *testing.T) {

	cwd := t.TempDir()

	os.WriteFile(filepath.Join(cwd, "plan.md"), []byte("- [ ] book the venue\n"), 0o644)

	actions := protocol.ParseActions("Tick off the venue\n<edit>plan.md</edit>\n@@ FIND\n- [ ] book the venue\n@@ REPLACE\n- [x] book the venue\n</edit>\n\n<done>\nTicked.\n</done>")

	if len(actions) != 2 || actions[0].Path != "plan.md" || actions[1].Verb != "done" {

		t.Fatalf("actions %+v", actions)

	}

	if result := tools.Execute(context.Background(), actions[0], cwd, ""); !result.OK {

		t.Fatalf("edit %s", result.Text)

	}

	if data, _ := os.ReadFile(filepath.Join(cwd, "plan.md")); string(data) != "- [x] book the venue\n" {

		t.Fatalf("plan.md %q", data)

	}

}
