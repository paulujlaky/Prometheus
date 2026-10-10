package agent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"boombox/agent/browser"
	"boombox/agent/protocol"
	"boombox/agent/tools"
	"boombox/config"
	"boombox/features"
	"boombox/store"
	"boombox/sdk"
)

var maxSteps = config.Int("PTS_MAX_STEPS", 60)

const (
	// a model that will not emit a block usually keeps not emitting one; bail rather than burn the budget
	maxMisses = 3

	// a wall of blocks is a model that has stopped looking at its results
	maxActionsPerTurn = 8

	recentChars = 300
)

// StoppedText is how a run the user stopped ends.
const StoppedText = "Stopped by the user."

// verbs whose output the model has to see before it can honestly report
var looking = map[protocol.Verb]bool{"run": true, "read": true, "grep": true, "ls": true, "open": true, "look": true, "click": true, "press": true, "tab": true, "submit": true, "handoff": true, "ask": true}

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

// botHash differs in form from the TypeScript server's, so an agent moved from it mints its bot once more.
func botHash(modelID, instructions string) string {

	sum := sha256.Sum256([]byte(modelID + "\n" + instructions))

	return "s" + hex.EncodeToString(sum[:12])

}

// ensureBot re-mints the agent's bot when its persona or model changes, or when the bot is gone; memory rides in each task instead.
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

	// the old bot is dead weight in the account, but losing it is not worth failing the run
	if agent.BotDraftID != "" {

		client.DeleteCustomBot(ctx, agent.BotDraftID)

	}

	if err := st.SaveBot(agent.ID, created.Draft.ID, published.Published.ID, hash); err != nil {

		return "", err

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
	agent store.Agent
	control RunControl

	runID string
	cwd string
	zone string

	notified bool

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

	case "say":

		r.record(store.KindSay, body)

		return pass("shown to the user"), nil

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

		page, err := browser.Look(r.control.Ctx, r.cwd)

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

	r := &run{st: st, agent: agent, control: control, runID: newRunID(), cwd: st.Workspace(&agent), zone: st.UserZone(agent.UserID)}
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

	}, task)

	misses := 0
	mentionHeld := false

	for turnNo := 1; turnNo <= maxSteps; turnNo++ {

		notes := control.TakeNotes()

		for _, note := range notes {

			r.record(store.KindUser, note)

		}

		if len(notes) > 0 {

			message += "\n\n[user]\nSent while you worked:\n\n" + strings.Join(notes, "\n\n")

		}

		turn, err := opened.Send(ctx, message, sdk.SendOptions{AssistantID: assistantID})

		if err != nil {

			return ended(err)

		}

		r.record(store.KindAssistant, turn.Text)

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

			result, err := r.step(action)

			if err == nil && ctx.Err() != nil {

				err = ctx.Err()

			}

			if err != nil {

				return ended(err)

			}

			result.Verb = action.Verb
			results = append(results, result)

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

		r.record(store.KindResult, message)

	}

	return r.record(store.KindError, fmt.Sprintf("Stopped after %d steps without <done>.", maxSteps))

}
