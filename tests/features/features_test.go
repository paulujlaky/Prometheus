package features_test

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"boombox/features"
	"boombox/store"
)

func openStore(t *testing.T) (*store.Store, int64) {

	st, err := store.Open(t.TempDir())

	if err != nil {

		t.Fatal(err)

	}

	t.Cleanup(func() { st.Close() })

	if _, err := st.IssueKey("features"); err != nil {

		t.Fatal(err)

	}

	user, err := st.GetUser("features")

	if err != nil {

		t.Fatal(err)

	}

	return st, user.ID

}

func TestSchedulesFireOnTheUsersClock(t *testing.T) {

	next := func(spec, zone, after string) string {

		cron, err := features.ParseCron(spec)

		if err != nil {

			t.Fatal(err)

		}

		from, _ := time.Parse(time.RFC3339, after)
		at, ok := features.NextRun(cron, zone, from)

		if !ok {

			return "null"

		}

		return at.UTC().Format(time.RFC3339)

	}

	cases := [][4]string{

		{"0 8 * * 1-5", "America/New_York", "2026-10-03T12:00:00Z", "2026-10-05T12:00:00Z"},
		{"*/15 * * * *", "UTC", "2026-10-05T10:07:00Z", "2026-10-05T10:15:00Z"},
		{"*/15 * * * *", "UTC", "2026-10-05T10:15:00Z", "2026-10-05T10:30:00Z"},
		{"* * * * *", "UTC", "2026-10-05T10:15:30Z", "2026-10-05T10:16:00Z"},
		{"0 9 1 * 0", "UTC", "2026-10-01T10:00:00Z", "2026-10-04T09:00:00Z"},
		{"0 0 * * 7", "UTC", "2026-10-01T00:00:00Z", "2026-10-04T00:00:00Z"},
		{"0 22 * * 0", "America/New_York", "2026-10-04T00:00:00Z", "2026-10-05T02:00:00Z"},
		{"30 8 * * *", "Asia/Kolkata", "2026-10-04T12:00:00Z", "2026-10-05T03:00:00Z"},
		{"0 9 * * *", "America/New_York", "2026-10-31T14:00:00Z", "2026-11-01T14:00:00Z"},
		{"30 2 * * *", "America/New_York", "2027-03-13T12:00:00Z", "2027-03-15T06:30:00Z"},
		{"0 0 29 2 *", "UTC", "2026-10-01T00:00:00Z", "2028-02-29T00:00:00Z"},
		{"0 0 30 2 *", "UTC", "2026-10-01T00:00:00Z", "null"},

	}

	for _, c := range cases {

		if got := next(c[0], c[1], c[2]); got != c[3] {

			t.Errorf("%s in %s after %s: got %s, want %s", c[0], c[1], c[2], got, c[3])

		}

	}

	for _, bad := range []string{"0 8 * *", "60 8 * * *", "0 8 * * mon"} {

		if _, err := features.ParseCron(bad); err == nil {

			t.Errorf("%q should not parse", bad)

		}

	}

	if _, err := features.ParseInterval("0"); err == nil {

		t.Error("an interval of 0 should fail")

	}

	if features.IsTimeZone("Local") || !features.IsTimeZone("Europe/Paris") || features.IsTimeZone("Mars/Base") {

		t.Error("time zones are checked by IANA name")

	}

}

func TestRoutineBlockCreatesListsAndRemoves(t *testing.T) {

	st, userID := openStore(t)
	mine, _ := st.CreateAgent(userID, "Planner", "model-1", "")
	other, _ := st.CreateAgent(userID, "Other", "model-1", "")

	if _, text := features.RoutineBlock(st, *mine, ""); text != "You have no routines." {

		t.Fatalf("got %q", text)

	}

	if ok, _ := features.RoutineBlock(st, *mine, "schedule: every morning\ntask: x"); ok {

		t.Fatal("a bad cron must fail")

	}

	if ok, _ := features.RoutineBlock(st, *mine, "schedule: 0 8 * * 1-5"); ok {

		t.Fatal("a routine without a task must fail")

	}

	okDaily, _ := features.RoutineBlock(st, *mine, "schedule: 0 8 * * 1-5\ntitle: HN digest\ntask: Summarise HN.\nKeep it to five bullets.")
	okWatch, _ := features.RoutineBlock(st, *mine, "watch: curl -s https://example.com > page.txt && cat page.txt\nevery: 30\ntask: Report changes.")

	if !okDaily || !okWatch {

		t.Fatal("both routines should be created")

	}

	routines, _ := st.ListRoutines(mine.ID)

	if len(routines) != 2 {

		t.Fatalf("got %d routines", len(routines))

	}

	first, second := routines[0], routines[1]

	if first.Kind != "schedule" || first.Title != "HN digest" || first.Task != "Summarise HN.\nKeep it to five bullets." || !first.Enabled {

		t.Fatalf("unexpected schedule %+v", first)

	}

	if second.Kind != "watch" || second.Spec != "30" || second.Target != "curl -s https://example.com > page.txt && cat page.txt" || second.Title != "" {

		t.Fatalf("unexpected watch %+v", second)

	}

	if _, text := features.RoutineBlock(st, *mine, ""); len(strings.Split(text, "\n")) != 2 {

		t.Fatalf("listing: %q", text)

	}

	if ok, _ := features.RoutineBlock(st, *other, fmt.Sprintf("remove: %d", first.ID)); ok {

		t.Fatal("an agent cannot remove another's routine")

	}

	if ok, _ := features.RoutineBlock(st, *mine, fmt.Sprintf("remove: %d", first.ID)); !ok {

		t.Fatal("an agent removes its own routine")

	}

	if left, _ := st.ListRoutines(mine.ID); len(left) != 1 || left[0].ID != second.ID {

		t.Fatalf("left %+v", left)

	}

}

func TestWatchOutputIsVisibleTextDiffedByLine(t *testing.T) {

	text := features.VisibleText(`<html><head><style>p{}</style><script>var t = "1";</script></head><body><h1>Price</h1><p>$10 &amp; up</p></body></html>`)

	if text != "Price\n$10 & up" {

		t.Fatalf("got %q", text)

	}

	if got := features.LineChanges("Price\n$10\nIn stock", "Price\n$12\nIn stock"); got != "Added:\n  $12\n\nRemoved:\n  $10" {

		t.Fatalf("got %q", got)

	}

}

func TestGroupRoutesByMentionAndCapsHandoffs(t *testing.T) {

	agents := []store.Agent{{ID: 1, Name: "Scout"}, {ID: 2, Name: "Scout Two"}, {ID: 3, Name: "Ops"}}

	message := func(text string, agentID int64) store.GroupMessage {

		message := store.GroupMessage{ID: 10, GroupID: 4, Author: "user", Text: text}

		if agentID != 0 {

			message.Author = "agent"
			message.AgentID = &agentID

		}

		return message

	}

	ids := func(list []store.Agent) []int64 {

		out := []int64{}

		for _, agent := range list {

			out = append(out, agent.ID)

		}

		slices.Sort(out)

		return out

	}

	if got := ids(features.Mentioned("ask @scout two and @OPS", agents)); !slices.Equal(got, []int64{2, 3}) {

		t.Fatalf("mentioned %v", got)

	}

	if got := features.RouteMessage(message("morning all", 0), agents, nil); len(got.Recipients) != 3 {

		t.Fatal("an unaddressed user message wakes everyone")

	}

	if got := ids(features.RouteMessage(message("@Ops check the disk", 0), agents, nil).Recipients); !slices.Equal(got, []int64{3}) {

		t.Fatalf("got %v", got)

	}

	handoff := features.RouteMessage(message("@Scout over to you, not me @Ops", 3), agents, &features.Origin{Chain: 10, Group: 4})

	if !slices.Equal(ids(handoff.Recipients), []int64{1}) || handoff.Origin != (features.Origin{Chain: 10, Hops: 1, Group: 4}) {

		t.Fatalf("handoff %+v", handoff)

	}

	if got := features.RouteMessage(message("done, nobody tagged", 3), agents, &features.Origin{Chain: 10, Hops: 2, Group: 4}); len(got.Recipients) != 0 || got.Capped {

		t.Fatalf("got %+v", got)

	}

	if got := features.RouteMessage(message("@Scout again", 3), agents, &features.Origin{Chain: 10, Hops: features.MaxHops, Group: 4}); !got.Capped {

		t.Fatal("hand-offs stop at the cap")

	}

	task := features.GroupTask(agents[2], agents, []store.GroupMessage{message("earlier", 0)}, message("@Ops check the disk", 0), "Infra")

	if !strings.HasPrefix(task, `[Group thread "Infra",`) || !strings.Contains(task, "Scout, Scout Two") || !strings.Contains(task, "user: earlier") {

		t.Fatalf("task %q", task)

	}

	if !features.IsWaiting(" Wait. ") || features.IsWaiting("Waited for Probe, then wrote the haiku.") {

		t.Fatal("wait is recognised exactly")

	}

}

func TestDirectChatsHandOffAndReplyToTheAsker(t *testing.T) {

	scout, pen, mail := store.Agent{ID: 1, Name: "Scout"}, store.Agent{ID: 2, Name: "Pen"}, store.Agent{ID: 3, Name: "Mail"}
	agents := []store.Agent{scout, pen, mail}
	done := func(id int64, text string) store.AgentEvent { return store.AgentEvent{ID: id, Kind: store.KindDone, Text: text} }

	// the user asked Scout, which hands the poem to Pen
	asked := features.RouteDirect(scout, done(40, "@Pen please write a line about 29."), agents, nil)

	if len(asked.Deliveries) != 1 || asked.Deliveries[0].To.ID != 2 || asked.Deliveries[0].Origin != (features.Origin{Chain: 40, Hops: 1, Direct: true, ReplyTo: 1}) {

		t.Fatalf("asked %+v", asked)

	}

	if task := asked.Deliveries[0].Task; !strings.HasPrefix(task, "[Message from Scout]\n\n@Pen please") {

		t.Fatalf("task %q", task)

	}

	// Pen's reply goes back to Scout, and a mention of Scout does not send it twice
	reply := features.RouteDirect(pen, done(41, "Twenty-nine stands alone. @Scout"), agents, &asked.Deliveries[0].Origin)

	if len(reply.Deliveries) != 1 || reply.Deliveries[0].To.ID != 1 || !strings.HasPrefix(reply.Deliveries[0].Task, "[Reply from Pen]\n\nTwenty-nine") {

		t.Fatalf("reply %+v", reply)

	}

	// a failure is reported back rather than left hanging; a run nobody asked for goes nowhere
	failed := features.RouteDirect(pen, store.AgentEvent{ID: 42, Kind: store.KindError, Text: "Boodle is down"}, agents, &asked.Deliveries[0].Origin)

	if len(failed.Deliveries) != 1 || !strings.Contains(failed.Deliveries[0].Task, "Could not finish: Boodle is down") {

		t.Fatalf("failed %+v", failed)

	}

	if quiet := features.RouteDirect(mail, done(43, "Inbox is empty."), agents, nil); len(quiet.Deliveries) != 0 {

		t.Fatalf("quiet %+v", quiet)

	}

	if capped := features.RouteDirect(scout, done(44, "@Pen again"), agents, &features.Origin{Chain: 40, Hops: features.MaxHops, Direct: true}); !capped.Capped {

		t.Fatal("hand-offs stop at the cap")

	}

}
