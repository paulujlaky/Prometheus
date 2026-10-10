// Command eval runs scripted tasks against a live pts server and Boodle, and checks what the agents did.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"boombox/agent/protocol"
	"boombox/store"
)

type event struct {

	ID int64 `json:"id"`
	Kind string `json:"kind"`
	Text string `json:"text"`
	At int64 `json:"at"`

}

type agentView struct {

	ID int64 `json:"id"`
	Name string `json:"name"`
	State string `json:"state"`
	Question *string `json:"question"`
	WaitingOn *string `json:"waitingOn"`

}

// env is what one trial of a scenario works with: the API, the store, its agents and a local site.
type env struct {

	base string
	key string

	st *store.Store
	userID int64

	trial int
	agents map[string]agentView
	marks map[int64]int64
	group int64

	site string
	siteMu sync.Mutex
	siteHits []string

	answers map[string]string

	// transcripts is where failed scenarios' events are written, every scenario's with keepAll; empty for nowhere
	transcripts string
	keepAll bool

}

func (e *env) api(method, path string, body any, out any) error {

	var reader io.Reader

	if body != nil {

		encoded, _ := json.Marshal(body)
		reader = bytes.NewReader(encoded)

	}

	req, _ := http.NewRequest(method, e.base+"/api"+path, reader)
	req.Header.Set("Authorization", "Bearer "+e.key)
	req.Header.Set("Content-Type", "application/json")

	res, err := http.DefaultClient.Do(req)

	if err != nil {

		return err

	}

	defer res.Body.Close()

	data, _ := io.ReadAll(res.Body)

	if res.StatusCode >= 300 {

		return fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, data)

	}

	if out != nil {

		return json.Unmarshal(data, out)

	}

	return nil

}

// name is the scenario's agent, unique to the trial so workspaces and bots never collide.
func (e *env) name(short string) string {

	return fmt.Sprintf("Ev%d%s", e.trial, short)

}

func (e *env) agent(short string) agentView {

	return e.agents[short]

}

func (e *env) workspaceFile(short, file string) string {

	data, _ := os.ReadFile(filepath.Join(e.st.WorkspaceOf(e.userID, e.name(short)), file))

	return string(data)

}

func (e *env) writeWorkspace(short, file, text string) error {

	return os.WriteFile(filepath.Join(e.st.WorkspaceOf(e.userID, e.name(short)), file), []byte(text), 0o644)

}

func (e *env) events(short string) []event {

	var events []event

	e.api("GET", fmt.Sprintf("/agents/%d/events", e.agent(short).ID), nil, &events)

	return events

}

// since is the agent's events after the mark the current step set.
func (e *env) since(short string) []event {

	mark := e.marks[e.agent(short).ID]
	out := []event{}

	for _, one := range e.events(short) {

		if one.ID > mark {

			out = append(out, one)

		}

	}

	return out

}

func (e *env) lastDone(short string) string {

	done := ""

	for _, one := range e.since(short) {

		if one.Kind == "done" {

			done = one.Text

		}

	}

	return done

}

func (e *env) send(short, text string) error {

	return e.api("POST", fmt.Sprintf("/agents/%d/messages", e.agent(short).ID), map[string]any{"text": text}, nil)

}

func (e *env) post(text string) error {

	return e.api("POST", "/group", map[string]any{"text": text, "group": e.group}, nil)

}

func (e *env) groupMessages() []string {

	var messages []struct {

		Author string `json:"author"`
		Text string `json:"text"`

	}

	e.api("GET", fmt.Sprintf("/group?group=%d", e.group), nil, &messages)

	out := []string{}

	for _, one := range messages {

		out = append(out, one.Author+": "+one.Text)

	}

	return out

}

// settle answers what agents wait on and returns once every agent of the trial has been idle for a few seconds.
func (e *env) settle(limit time.Duration) error {

	deadline := time.Now().Add(limit)
	quiet := 0

	for time.Now().Before(deadline) {

		time.Sleep(2 * time.Second)

		busy := false

		for short, known := range e.agents {

			var view agentView

			if err := e.api("GET", fmt.Sprintf("/agents/%d", known.ID), nil, &view); err != nil {

				return err

			}

			if view.State != "idle" {

				busy = true

			}

			if view.WaitingOn != nil {

				e.reply(short, *view.WaitingOn, *view.Question)

			}

		}

		if busy {

			quiet = 0

			continue

		}

		if quiet++; quiet >= 2 {

			return nil

		}

	}

	return errors.New("still running when the time ran out")

}

func (e *env) reply(short, kind, question string) {

	path := fmt.Sprintf("/agents/%d/answer", e.agent(short).ID)

	if kind == "question" {

		e.api("POST", path, map[string]any{"text": e.answers["question"]}, nil)

		return

	}

	e.api("POST", path, map[string]any{"allow": e.answers[kind] != "no"}, nil)

}

func (e *env) mark() {

	for _, known := range e.agents {

		events := e.events(nameKey(e, known.ID))

		if len(events) > 0 {

			e.marks[known.ID] = events[len(events)-1].ID

		}

	}

}

func nameKey(e *env, id int64) string {

	for short, known := range e.agents {

		if known.ID == id {

			return short

		}

	}

	return ""

}

type scenario struct {

	name string
	agents []string
	group bool

	answers map[string]string

	setup func(e *env) error
	steps []func(e *env) error
	check func(e *env) error

}

// contains ignores case and digit grouping, so "1,048,576" is 1048576.
func contains(text, want string) error {

	plain := strings.NewReplacer(",", "", " ", "", " ", "").Replace(strings.ToLower(text))

	if !strings.Contains(plain, strings.ToLower(want)) {

		return fmt.Errorf("wanted %q in %q", want, clip(text))

	}

	return nil

}

func clip(text string) string {

	text = strings.Join(strings.Fields(text), " ")

	if len(text) > 160 {

		return text[:160] + "…"

	}

	return text

}

var scenarios = []scenario{

	{

		name: "shell",
		agents: []string{"A"},

		steps: []func(e *env) error{func(e *env) error { return e.send("A", "Use python to work out 2**20, save it to pow.txt, and tell me the number.") }},

		check: func(e *env) error {

			if err := contains(e.lastDone("A"), "1048576"); err != nil {

				return err

			}

			return contains(e.workspaceFile("A", "pow.txt"), "1048576")

		},

	},

	{

		name: "memory",
		agents: []string{"A"},

		steps: []func(e *env) error{

			func(e *env) error { return e.send("A", "Remember that my favourite colour is green.") },
			func(e *env) error { return e.send("A", "What's my favourite colour?") },

		},

		check: func(e *env) error {

			if err := contains(e.workspaceFile("A", "MEMORY.md"), "green"); err != nil {

				return err

			}

			return contains(e.lastDone("A"), "green")

		},

	},

	{

		name: "edit",
		agents: []string{"A"},

		setup: func(e *env) error { return e.writeWorkspace("A", "plan.md", "# Party\n\n- [ ] book the venue\n- [ ] send invites\n") },

		steps: []func(e *env) error{func(e *env) error { return e.send("A", "In plan.md, tick off booking the venue.") }},

		check: func(e *env) error {

			if got := e.workspaceFile("A", "plan.md"); got != "# Party\n\n- [x] book the venue\n- [ ] send invites\n" {

				return fmt.Errorf("plan.md is %q", got)

			}

			return nil

		},

	},

	{

		name: "browser",
		agents: []string{"A"},

		steps: []func(e *env) error{func(e *env) error { return e.send("A", "Go to "+e.site+"/greet, type Ada as the name, press Greet, and tell me what the page says.") }},

		check: func(e *env) error { return contains(e.lastDone("A"), "Hello Ada") },

	},

	{

		name: "ask",
		agents: []string{"A"},
		answers: map[string]string{"question": "Lisbon"},

		steps: []func(e *env) error{func(e *env) error { return e.send("A", "Ask me which city I live in, then save it to city.txt.") }},

		check: func(e *env) error { return contains(e.workspaceFile("A", "city.txt"), "Lisbon") },

	},

	{

		name: "submit",
		agents: []string{"A"},
		answers: map[string]string{"ask": "yes"},

		steps: []func(e *env) error{func(e *env) error { return e.send("A", "Go to "+e.site+"/contact and send Sam the message: lunch at noon?") }},

		check: func(e *env) error {

			e.siteMu.Lock()
			defer e.siteMu.Unlock()

			for _, hit := range e.siteHits {

				if strings.HasPrefix(hit, "/sent") && strings.Contains(hit, "noon") {

					return nil

				}

			}

			return fmt.Errorf("the form was never sent: %v", e.siteHits)

		},

	},

	{

		name: "routine",
		agents: []string{"A"},

		steps: []func(e *env) error{func(e *env) error { return e.send("A", "Every Monday at 9am, remind me to water the plants.") }},

		check: func(e *env) error {

			var routines []struct {

				Spec string `json:"spec"`

			}

			e.api("GET", fmt.Sprintf("/agents/%d/routines", e.agent("A").ID), nil, &routines)

			for _, routine := range routines {

				if routine.Spec == "0 9 * * 1" {

					return nil

				}

			}

			return fmt.Errorf("routines %+v", routines)

		},

	},

	{

		name: "answer-in-done",
		agents: []string{"A"},

		steps: []func(e *env) error{func(e *env) error { return e.send("A", "Write me a four-line poem about rain.") }},

		check: func(e *env) error {

			lines := 0

			for _, line := range strings.Split(e.lastDone("A"), "\n") {

				if strings.TrimSpace(line) != "" {

					lines++

				}

			}

			if lines < 4 {

				return fmt.Errorf("the poem is not in <done>: %q", clip(e.lastDone("A")))

			}

			return nil

		},

	},

	{

		name: "group-handoff",
		agents: []string{"A", "B"},
		group: true,

		steps: []func(e *env) error{func(e *env) error {

			return e.post(fmt.Sprintf("@%s work out 7*6 with python and give the number to @%s. @%s, double the number %s gives you.", e.name("A"), e.name("B"), e.name("B"), e.name("A")))

		}},

		check: func(e *env) error {

			for _, message := range e.groupMessages() {

				if strings.HasPrefix(message, e.name("B")+":") && strings.Contains(message, "84") {

					return nil

				}

			}

			return fmt.Errorf("B never doubled it: %v", e.groupMessages())

		},

	},

	{

		name: "direct-mention",
		agents: []string{"A", "B"},

		steps: []func(e *env) error{func(e *env) error {

			return e.send("A", fmt.Sprintf("Ask @%s to work out 12*12 with python, then tell me their answer.", e.name("B")))

		}},

		check: func(e *env) error {

			if len(e.since("B")) == 0 {

				return errors.New("B never ran")

			}

			return contains(e.lastDone("A"), "144")

		},

	},

}

type outcome struct {

	scenario string
	trial int

	err error

	turns int
	misses int
	errors int
	seconds float64

}

func (e *env) saveTranscript(scenario string) {

	var out strings.Builder

	for short, known := range e.agents {

		var view agentView

		e.api("GET", fmt.Sprintf("/agents/%d", known.ID), nil, &view)
		fmt.Fprintf(&out, "== %s is %s\n\n", e.name(short), view.State)

		for _, one := range e.events(short) {

			fmt.Fprintf(&out, "── %s %s ──\n%s\n\n", e.name(short), one.Kind, one.Text)

		}

	}

	os.MkdirAll(e.transcripts, 0o755)
	os.WriteFile(filepath.Join(e.transcripts, fmt.Sprintf("%s-%d.txt", scenario, e.trial)), []byte(out.String()), 0o644)

}

func run(e *env, s scenario) (result outcome) {

	result = outcome{scenario: s.name, trial: e.trial}
	started := time.Now()

	e.agents = map[string]agentView{}
	e.marks = map[int64]int64{}
	e.answers = s.answers
	e.group = 0

	defer func() {

		// the agents and their events go with the scenario, so a failure keeps its transcript first, a timeout's too
		if (result.err != nil || e.keepAll) && e.transcripts != "" {

			e.saveTranscript(s.name)

		}

		for _, known := range e.agents {

			e.api("DELETE", fmt.Sprintf("/agents/%d", known.ID), nil, nil)

		}

		if e.group != 0 {

			e.api("DELETE", fmt.Sprintf("/groups/%d", e.group), nil, nil)

		}

	}()

	for _, short := range s.agents {

		var created agentView

		if err := e.api("POST", "/agents", map[string]any{"name": e.name(short)}, &created); err != nil {

			result.err = err

			return result

		}

		e.agents[short] = created

	}

	if s.group {

		ids := []int64{}

		for _, short := range s.agents {

			ids = append(ids, e.agents[short].ID)

		}

		var group struct {

			ID int64 `json:"id"`

		}

		if err := e.api("POST", "/groups", map[string]any{"members": ids}, &group); err != nil {

			result.err = err

			return result

		}

		e.group = group.ID

	}

	if s.setup != nil {

		if err := s.setup(e); err != nil {

			result.err = err

			return result

		}

	}

	for _, step := range s.steps {

		e.mark()

		if err := step(e); err != nil {

			result.err = err

			return result

		}

		if err := e.settle(4 * time.Minute); err != nil {

			result.err = err

			return result

		}

	}

	result.seconds = time.Since(started).Seconds()
	e.marks = map[int64]int64{}

	for short := range e.agents {

		for _, one := range e.since(short) {

			switch one.Kind {

			case "assistant":

				result.turns++

				if len(protocol.ParseActions(one.Text)) == 0 {

					result.misses++

				}

			case "error":

				result.errors++

			}

		}

	}

	result.err = s.check(e)

	return result

}

// serveSite is the local pages the browser scenarios use, and a log of what was asked of them.
func serveSite(e *env) error {

	listener, err := net.Listen("tcp", "127.0.0.1:0")

	if err != nil {

		return err

	}

	mux := http.NewServeMux()

	page := func(w http.ResponseWriter, body string) {

		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, "<!doctype html>"+body)

	}

	mux.HandleFunc("/greet", func(w http.ResponseWriter, r *http.Request) {

		if name := r.URL.Query().Get("name"); name != "" {

			page(w, "<title>Greeter</title><h1>Hello "+name+"</h1>")

			return

		}

		page(w, `<title>Greeter</title><h1>Greeter</h1><form><label>Name <input name="name"></label><button>Greet</button></form>`)

	})

	mux.HandleFunc("/contact", func(w http.ResponseWriter, r *http.Request) {

		page(w, `<title>Contact</title><h1>Contact Sam</h1><form action="/sent"><label>Message <textarea name="message"></textarea></label><button>Send</button></form>`)

	})

	mux.HandleFunc("/sent", func(w http.ResponseWriter, r *http.Request) {

		e.siteMu.Lock()
		e.siteHits = append(e.siteHits, r.URL.RequestURI())
		e.siteMu.Unlock()

		page(w, "<title>Sent</title><h1>Message sent to Sam</h1>")

	})

	e.site = "http://" + listener.Addr().String()

	go http.Serve(listener, mux)

	return nil

}

func main() {

	base := flag.String("base", "http://127.0.0.1:7421", "the pts server")
	keyFile := flag.String("key", "", "file holding a sign-in key")
	user := flag.String("user", "tester", "the key's user, to find workspaces")
	trials := flag.Int("trials", 1, "runs of each scenario")
	only := flag.String("only", "", "comma-separated scenarios to run")
	first := flag.Int("first-trial", 1, "number of the first trial, so names stay unique across runs")
	transcripts := flag.String("transcripts", "", "folder for failed scenarios' transcripts")
	keepAll := flag.Bool("all", false, "keep passing scenarios' transcripts too")

	flag.Parse()

	key, err := os.ReadFile(*keyFile)

	if err != nil {

		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)

	}

	st, err := store.OpenDefault()

	if err != nil {

		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)

	}

	defer st.Close()

	owner, err := st.GetUser(*user)

	if err != nil {

		fmt.Fprintln(os.Stderr, "no such user:", *user)
		os.Exit(1)

	}

	e := &env{base: strings.TrimSuffix(*base, "/"), key: strings.TrimSpace(string(key)), st: st, userID: owner.ID, transcripts: *transcripts, keepAll: *keepAll}

	if err := serveSite(e); err != nil {

		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)

	}

	wanted := map[string]bool{}

	for _, name := range strings.Split(*only, ",") {

		if name != "" {

			wanted[name] = true

		}

	}

	results := []outcome{}

	for trial := *first; trial < *first+*trials; trial++ {

		for _, s := range scenarios {

			if len(wanted) > 0 && !wanted[s.name] {

				continue

			}

			e.trial = trial
			result := run(e, s)
			results = append(results, result)

			status := "pass"

			if result.err != nil {

				status = "FAIL " + result.err.Error()

			}

			fmt.Printf("%-15s trial %d  %5.0fs  turns %2d  misses %d  errors %d  %s\n", s.name, trial, result.seconds, result.turns, result.misses, result.errors, status)

		}

	}

	passed, turns, seconds := 0, 0, 0.0

	for _, result := range results {

		if result.err == nil {

			passed++

		}

		turns += result.turns
		seconds += result.seconds

	}

	fmt.Printf("\n%d of %d passed, %d turns, %.0fs\n", passed, len(results), turns, seconds)

}
