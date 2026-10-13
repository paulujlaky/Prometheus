package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"boombox/agent/browser"
	"boombox/agent/protocol"
	"boombox/agent/shell"
	"boombox/agent/tools"
	"boombox/config"
	"boombox/features"
	"boombox/sdk"
	"boombox/store"
)

var maxSteps = config.Int("PTS_MAX_STEPS", 60)

const (
	// a model that will not emit a block usually keeps not emitting one; bail rather than burn the budget
	maxMisses = 3

	// a wall of blocks is a model that has stopped looking at its results
	maxActionsPerTurn = 8

	recentChars = 300

	// Boodle takes most of a minute to process even a small file before the model can see it
	processWait = 3 * time.Minute
)

// StoppedText is how a run the user stopped ends.
const StoppedText = "Stopped by the user."

// verbs whose output the model has to see before it can honestly report
var looking = map[protocol.Verb]bool{"run": true, "read": true, "grep": true, "ls": true, "view": true, "open": true, "look": true, "click": true, "press": true, "tab": true, "upload": true, "submit": true, "handoff": true, "ask": true, "create_agent": true}

// verbs that carry their own event, so they are not steps
var spoken = map[protocol.Verb]bool{"say": true, "notify": true, "card": true}

// verbs whose result opens with the page's URL and title
var paging = map[protocol.Verb]bool{"open": true, "look": true, "click": true, "press": true, "tab": true, "submit": true, "handoff": true}

// what Boodle can show the model; anything else stays a workspace file to <read> or <run>
var viewable = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".pdf": true, ".doc": true, ".docx": true, ".xlsx": true, ".pptx": true, ".txt": true, ".md": true, ".csv": true, ".json": true, ".html": true}

func canView(path string) bool { return viewable[strings.ToLower(filepath.Ext(path))] }

var errAborted = errors.New("aborted")

func clipLine(text string) string {

	one := strings.Join(strings.Fields(text), " ")

	if utf8.RuneCountInString(one) <= recentChars {

		return one

	}

	return string([]rune(one)[:recentChars-1]) + "…"

}

func newRunID() string {

	b := make([]byte, 16)

	rand.Read(b)

	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80

	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])

}

func botHash(modelID, instructions string) string {

	sum := sha256.Sum256([]byte(modelID + "\n" + instructions))

	return fmt.Sprintf("s%d:%s", protocol.GuideVersion, hex.EncodeToString(sum[:12]))

}

// Memory rides in each task, so re-minting for a new guide, model or persona preserves it.
func ensureBot(ctx context.Context, st *store.Store, client *sdk.Client, agent store.Agent) (string, error) {

	instructions := protocol.BotInstructions(agent.Name, agent.Persona)
	hash := botHash(agent.ModelID, instructions)

	// a delete in Boodle leaves the stored id behind, so it is reused only while the bot is still listed
	if agent.BotAssistantID != "" && agent.BotHash == hash {

		drafts, err := client.ListCustomBotDrafts(ctx, 50, 0)

		if err != nil {

			return "", err

		}

		for _, entry := range drafts.Entries {

			if entry.Published != nil && entry.Published.ID == agent.BotAssistantID {

				return agent.BotAssistantID, nil

			}

		}

	}

	created, err := client.CreateCustomBot(ctx, sdk.CustomBotInput{Name: "Prometheus · " + agent.Name, ModelID: agent.ModelID, Instructions: instructions, Description: "Prometheus agent"})

	if err != nil {

		return "", err

	}

	published, err := client.PublishCustomBot(ctx, created.Draft.ID)

	if err != nil {

		return "", err

	}

	if published.Published == nil || published.Published.ID == "" {

		return "", errors.New("Boodle published the bot without an assistant id")

	}

	if err := st.SaveBot(agent.ID, created.Draft.ID, published.Published.ID, hash); err != nil {

		return "", err

	}

	// Keep the previous bot until its replacement is safely stored.
	if agent.BotDraftID != "" {

		client.DeleteCustomBot(ctx, agent.BotDraftID)

	}

	return published.Published.ID, nil

}

// ChatDeleter is the part of the Boodle client that cleans up chats.
type ChatDeleter interface {

	DeleteChat(ctx context.Context, chatID string) error

}

// DropChats deletes the given chats from Boodle; one that fails stays tracked for the next sweep.
func DropChats(st *store.Store, client ChatDeleter, ids []string) {

	var wg sync.WaitGroup

	for _, id := range ids {

		wg.Add(1)

		go func() {

			defer wg.Done()

			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()

			err := client.DeleteChat(ctx, id)

			// already gone, or left on an account whose cookie was swapped out; retrying cannot help
			status := sdk.StatusOf(err)

			if err == nil || status == 403 || status == 404 {

				st.UntrackChat(id)

			}

		}()

	}

	wg.Wait()

}

type run struct {

	st *store.Store
	client *sdk.Client
	agent store.Agent
	control RunControl

	runID string
	cwd string
	zone string

	notified bool

	// knowledge is files uploaded to Boodle that go with the next message; page is the last page the chat was shown
	chatID string
	knowledge []string
	page string

}

// show uploads workspace files to Boodle and waits out its processing, so the model sees them with its next message.
func (r *run) show(paths []string) error {

	files, err := shell.InLane(r.control.Ctx, r.cwd, func() ([]shell.File, error) { return tools.Load(r.cwd, paths) })

	if err != nil {

		return err

	}

	for _, file := range files {

		if !canView(file.Name) {

			return fmt.Errorf("%s cannot be shown to you; use <read> or <run> on it instead", file.Name)

		}

	}

	ids := []string{}

	for _, file := range files {

		item, err := r.client.UploadKnowledge(r.control.Ctx, file.Name, file.Data)

		if err != nil {

			return err

		}

		ids = append(ids, item.ID)

	}

	if err := r.client.AttachKnowledge(r.control.Ctx, r.chatID, ids); err != nil {

		return err

	}

	if err := r.client.WaitKnowledge(r.control.Ctx, r.chatID, ids, processWait); err != nil {

		return err

	}

	r.knowledge = append(r.knowledge, ids...)

	return nil

}

// attached shows the model what the user's message came with; a file that cannot be shown is still in the workspace.
func (r *run) attached(text string) string {

	paths := []string{}

	for _, path := range protocol.Attached(text) {

		if canView(path) {

			paths = append(paths, path)

		}

	}

	if len(paths) == 0 {

		return ""

	}

	if err := r.show(paths); err != nil {

		return "\n\n[harness]\nThe attachments are in your workspace, but could not be shown to you: " + err.Error()

	}

	return ""

}

// after records what a block left for the chat to show: the page it ended on, or the routine it made.
func (r *run) after(action protocol.Action, result protocol.Result) {

	if !result.OK {

		return

	}

	if action.Verb == "routine" && strings.HasPrefix(result.Text, "created routine") {

		r.record(store.KindRoutine, result.Text)

		return

	}

	url, rest, _ := strings.Cut(result.Text, "\n")
	title, _, _ := strings.Cut(rest, "\n")

	if paging[action.Verb] && strings.HasPrefix(url, "http") && url != r.page {

		r.page = url
		r.record(store.KindPage, url+"\n"+title)

	}

}

func (r *run) record(kind store.EventKind, text string) store.AgentEvent {

	event := store.AgentEvent{AgentID: r.agent.ID, RunID: r.runID, Kind: kind, Text: text, At: time.Now().UnixMilli()}

	// an agent deleted mid-run is gone from the database; its run is already stopping and has nowhere to write
	if _, err := r.st.AgentByID(r.agent.ID); err == nil {

		if stored, err := r.st.AddEvent(r.agent.ID, r.runID, kind, text); err == nil {

			event = stored

		}

	}

	r.control.Listen(RunEvent{Event: event})

	return event

}

func (r *run) wait(question string, kind WaitKind) (Reply, error) {

	reply := r.control.Ask(question, kind)

	if r.control.Ctx.Err() != nil {

		return reply, errAborted

	}

	return reply, nil

}

// step runs one block that is not <done>; a failed result stops the blocks behind it, except a refused <notify>.
func (r *run) step(action protocol.Action) (protocol.Result, error) {

	body := strings.TrimSpace(action.Body)
	line, _, _ := strings.Cut(body, "\n")
	pass := func(text string) protocol.Result { return protocol.Result{Verb: action.Verb, OK: true, Text: text} }
	fail := func(text string) protocol.Result { return protocol.Result{Verb: action.Verb, OK: false, Text: text} }

	switch action.Verb {

	case "create_agent":

		spec, err := protocol.ParseAgentSpec(body)

		if err != nil {

			return fail(err.Error()), nil

		}

		if r.control.CreateAgent == nil {

			return fail("Agent creation is unavailable in this runner"), nil

		}

		created, err := r.control.CreateAgent(spec)

		if err != nil {

			return fail(err.Error()), nil

		}

		state := "idle"

		if spec.Task != "" {

			state = "initial task queued"

		}

		return pass(fmt.Sprintf("created agent %d: @%s (%s)", created.ID, created.Name, state)), nil

	case "card":

		_, err := protocol.ParseCard(body)

		if err != nil {

			return fail(err.Error()), nil

		}

		r.record(store.KindCard, body)

		return pass("shown to the user"), nil

	case "say":

		r.record(store.KindSay, body)

		return pass("shown to the user"), nil

	case "view":

		paths := []string{}

		if action.Path != "" {

			paths = append(paths, action.Path)

		}

		for _, line := range strings.Split(body, "\n") {

			if line = strings.TrimSpace(line); line != "" {

				paths = append(paths, line)

			}

		}

		if err := r.show(paths); err != nil {

			return fail(err.Error()), nil

		}

		return pass("attached; you see them with this message"), nil

	case "notify":

		// one buzz per task: a second would be the agent narrating, which is what the limit exists to stop
		if r.notified {

			return fail("You already notified the user this task. Put the rest in <done>."), nil

		}

		if line == "" {

			return fail("notify needs one line to send."), nil

		}

		r.notified = true
		r.record(store.KindNotify, line)

		return pass("sent to the user's phone"), nil

	case "routine":

		ok, text := features.RoutineBlock(r.st, r.agent, action.Body)

		return protocol.Result{Verb: action.Verb, OK: ok, Text: text}, nil

	case "submit":

		if action.Path == "" || body == "" {

			return fail("submit needs the button's ref on the tag and one line saying what it sends:\n\n  <submit e31>\n  Send the reply to Sam\n  </submit>"), nil

		}

		question := body + "\n" + browser.PageURL(r.cwd)

		r.record(store.KindAsk, question)

		reply, err := r.wait(question, WaitAsk)

		if err != nil {

			return protocol.Result{}, err

		}

		allowed := reply.Allow && !reply.Written

		if allowed {

			r.record(store.KindUser, "Allowed.")

		} else {

			r.record(store.KindUser, "Not allowed.")

			return fail("The user did not allow this. Do not send it another way. If the task cannot go on without it, say so in <done>."), nil

		}

		click := action
		click.Verb = "click"

		result := tools.Execute(r.control.Ctx, click, r.cwd, r.zone)
		result.Verb = "submit"

		return result, nil

	case "ask":

		if protocol.ParseQuestion(body).Prompt == "" {

			return fail("ask needs the question on its first line, then any choices one per line:\n\n  <ask>\n  Which one?\n  - The first\n  - The second\n  </ask>"), nil

		}

		r.record(store.KindQuestion, body)

		reply, err := r.wait(body, WaitQuestion)

		if err != nil {

			return protocol.Result{}, err

		}

		answer := ""

		if reply.Written {

			answer = strings.TrimSpace(reply.Text)

		}

		if answer == "" {

			r.record(store.KindUser, "Skipped.")

			return pass("The user skipped the question. Decide it yourself and keep going."), nil

		}

		r.record(store.KindUser, answer)

		return pass("The user answered: " + answer), nil

	case "handoff":

		if line == "" {

			return fail("handoff needs one line saying what the user should do in the browser."), nil

		}

		r.record(store.KindHandoff, line)

		type waited struct {

			reply Reply
			err error

		}

		outcome := browser.Pinned(r.cwd, func() waited {

			reply, err := r.wait(line, WaitHandoff)

			return waited{reply: reply, err: err}

		})

		if outcome.err != nil {

			return protocol.Result{}, outcome.err

		}

		if !outcome.reply.Allow {

			r.record(store.KindUser, "Skipped.")

			return fail("The user did not do it. If the task cannot go on without it, say so in <done>."), nil

		}

		r.record(store.KindUser, "Done.")

		page, err := browser.Look(r.control.Ctx, r.cwd, "")

		if err != nil {

			page = err.Error()

		}

		// the page first, like every browser result, so the chat shows where the user left off
		return pass(page + "\n\n[harness]\nThe user handed the browser back; this is the page as they left it."), nil

	}

	return tools.Execute(r.control.Ctx, action, r.cwd, r.zone), nil

}

// RunAgent drives one task from start to <done> in a fresh chat; everything lands in the store as it happens, and it returns the ending event.
func RunAgent(st *store.Store, client *sdk.Client, queued store.Agent, task string, control RunControl) store.AgentEvent {

	// the row may have changed while this run waited in the queue, e.g. an earlier run minted the bot
	agent := queued

	if latest, err := st.AgentByID(queued.ID); err == nil {

		agent = *latest

	}

	r := &run{st: st, client: client, agent: agent, control: control, runID: newRunID(), cwd: st.Workspace(&agent), zone: st.UserZone(agent.UserID)}
	ctx := control.Ctx

	recentRuns, _ := st.RecentRuns(agent.ID, 6)
	recent := make([]string, len(recentRuns))

	for i, past := range recentRuns {

		outcome := clipLine(past.Outcome)

		if outcome == "" {

			outcome = "no outcome"

		}

		recent[i] = "- " + time.UnixMilli(past.At).UTC().Format("2006-01-02 15:04") + " — " + clipLine(past.Task) + " → " + outcome

	}

	r.record(store.KindTask, task)

	var sessionMu sync.Mutex
	var session *sdk.ChatSession

	// a stop has to reach a reply that is still streaming, not just the gap between steps
	stopWatching := context.AfterFunc(ctx, func() {

		sessionMu.Lock()
		current := session
		sessionMu.Unlock()

		if current != nil {

			cancelCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()

			current.Cancel(cancelCtx)
			current.Dispose()

		}

	})

	defer func() {

		stopWatching()

		sessionMu.Lock()

		if session != nil {

			session.Dispose()

		}

		sessionMu.Unlock()

		// an agent runs one task at a time, so every chat tracked for it is finished, including earlier failed deletes
		chats, _ := st.TrackedChats(agent.UserID, agent.ID)

		DropChats(st, client, chats)

	}()

	ended := func(err error) store.AgentEvent {

		if ctx.Err() != nil {

			return r.record(store.KindError, StoppedText)

		}

		return r.record(store.KindError, err.Error())

	}

	assistantID, err := ensureBot(ctx, st, client, agent)

	if err != nil {

		return ended(err)

	}

	if ctx.Err() != nil {

		return ended(ctx.Err())

	}

	chat, err := client.CreateChat(ctx)

	if err != nil {

		return ended(err)

	}

	// tracked before connecting, so a chat whose socket never opens is still cleaned up
	st.TrackChat(chat.ID, agent.ID, agent.UserID)

	r.chatID = chat.ID

	opened, err := sdk.OpenSession(ctx, client, chat.ID, sdk.SessionOptions{AssistantID: assistantID})

	if err != nil {

		return ended(err)

	}

	sessionMu.Lock()
	session = opened
	sessionMu.Unlock()

	if ctx.Err() != nil {

		opened.Dispose()

		return ended(ctx.Err())

	}

	opened.On(func(event sdk.SessionEvent) {

		if event.Change != nil && event.Change.Kind == sdk.ChangeDelta && !strings.EqualFold(event.Change.SectionType, "reasoning") {

			control.Listen(RunEvent{Delta: true, AgentID: agent.ID, Text: event.Change.Text})

		}

	})

	others := []string{}
	peers := []store.Agent{}

	if all, err := st.ListAgents(agent.UserID); err == nil {

		for _, other := range all {

			if other.ID != agent.ID {

				others = append(others, other.Name)
				peers = append(peers, other)

			}

		}

	}

	message := protocol.TaskMessage(protocol.TaskContext{

		User: st.ReadUserDoc(agent.UserID),
		Memory: st.ReadMemory(&agent),
		Recent: recent,
		Agents: others,
		Now: features.LocalTime(time.Now(), r.zone) + " (" + r.zone + ")",

	}, task) + r.attached(task)

	misses := 0
	mentionHeld := false

	for turnNo := 1; turnNo <= maxSteps; turnNo++ {

		// newly created agents must be available to the same run's hand-off checks
		if all, err := st.ListAgents(agent.UserID); err == nil {

			peers = peers[:0]

			for _, other := range all {

				if other.ID != agent.ID {

					peers = append(peers, other)

				}

			}

		}

		notes := control.TakeNotes()

		for _, note := range notes {

			r.record(store.KindUser, note)

		}

		if len(notes) > 0 {

			joined := strings.Join(notes, "\n\n")
			message += "\n\n[user]\nSent while you worked:\n\n" + joined + r.attached(joined)

		}

		turn, err := opened.Send(ctx, message, sdk.SendOptions{AssistantID: assistantID, KnowledgeIDs: r.knowledge})

		if err != nil {

			return ended(err)

		}

		r.knowledge = nil

		actions := protocol.ParseActions(turn.Text)

		if len(actions) == 0 {

			misses++

			if misses >= maxMisses {

				return r.record(store.KindError, fmt.Sprintf("%d replies in a row had no block, so nothing could run.", misses))

			}

			message = protocol.Nudge

			continue

		}

		misses = 0

		results := []protocol.Result{}
		unseen := false
		heldDone := false
		misplaced := []string{}

		for _, action := range actions[:min(len(actions), maxActionsPerTurn)] {

			// a report written before the output came back can only guess at it
			if action.Verb == "done" && unseen {

				heldDone = true

				break

			}

			// an @mention in the thinking reaches no one; say so once rather than end on "waiting for them"
			if action.Verb == "done" && !mentionHeld && len(features.Mentioned(action.Body, peers)) == 0 {

				for _, named := range features.Mentioned(protocol.Prose(turn.Text, actions), peers) {

					misplaced = append(misplaced, "@"+named.Name)

				}

				if len(misplaced) > 0 {

					mentionHeld = true

					break

				}

			}

			if action.Verb == "done" {

				done := strings.TrimSpace(action.Body)

				if done == "" {

					done = "Done."

				}

				return r.record(store.KindDone, done)

			}

			unseen = unseen || looking[action.Verb]

			if !spoken[action.Verb] {

				r.record(store.KindStep, action.Title())

			}

			result, err := r.step(action)

			if err == nil && ctx.Err() != nil {

				err = ctx.Err()

			}

			if err != nil {

				return ended(err)

			}

			result.Verb = action.Verb
			results = append(results, result)

			r.after(action, result)

			// a failed block usually invalidates the ones behind it; let the model look first
			if !result.OK && action.Verb != "notify" {

				break

			}

		}

		held := len(actions) - len(results)

		if heldDone || len(misplaced) > 0 {

			held--

		}

		message = protocol.FormatResults(results)

		if heldDone {

			message += "\n\n[harness]\nYour <done> was held: it came before this output. Check it, then send <done> again."

		}

		if len(misplaced) > 0 {

			message += "\n\n[harness]\nYour <done> was held: you mentioned " + strings.Join(misplaced, ", ") + " outside it, so nobody was asked. To hand them work, put the @mention and what you need inside <done>."

		}

		if held > 0 {

			noun, pronoun := "blocks", "them"

			if held == 1 {

				noun, pronoun = "block", "it"

			}

			message += fmt.Sprintf("\n\n[harness]\n%d later %s did not run; send %s again if still needed.", held, noun, pronoun)

		}

	}

	return r.record(store.KindError, fmt.Sprintf("Stopped after %d steps without <done>.", maxSteps))

}
