// Package agent runs agents' tasks: a fair queue across users, and the loop that drives one task to <done>.
package agent

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"boombox/config"
	"boombox/features"
	"boombox/store"
)

var (
	maxRunning = config.Int("PTS_MAX_RUNNING", 5)

	// a run waiting on the user still holds one of the slots, so an unanswered question must end
	answerWait = config.Millis("PTS_ANSWER_MS", 30*time.Minute)
)

type State string

const (
	Idle State = "idle"
	Queued State = "queued"
	Running State = "running"
	Waiting State = "waiting"
)

// WaitKind is what a waiting run waits on: an OK for a <submit>, the user in the browser, or an answer to an <ask>.
type WaitKind string

const (
	WaitAsk WaitKind = "ask"
	WaitHandoff WaitKind = "handoff"
	WaitQuestion WaitKind = "question"
)

// Reply allows or refuses, or for an <ask> carries the answer in words.
type Reply struct {

	Allow bool

	Text string
	Written bool

}

func Allow(allow bool) Reply { return Reply{Allow: allow} }

func Answer(text string) Reply { return Reply{Text: text, Written: true} }

// RunEvent is a stored event, or a streamed piece of the agent's reply when Delta is set.
type RunEvent struct {

	Event store.AgentEvent

	Delta bool
	AgentID int64
	Text string

}

type RunListener func(RunEvent)

// RunControl is what a run gets from the queue: its stop signal, the user's notes, and a way to wait on the user.
type RunControl struct {

	Ctx context.Context

	// TakeNotes hands over the messages the user sent while this run was going.
	TakeNotes func() []string

	// Ask parks the run until the user answers; it allows nothing on stop or timeout.
	Ask func(question string, kind WaitKind) Reply

	Listen RunListener

}

type StartRun func(agent store.Agent, task string, control RunControl, origin *features.Origin)

type job struct {

	agent store.Agent
	task string

	origin *features.Origin

}

type pendingWait struct {

	question string
	kind WaitKind
	answer func(Reply)

}

type slot struct {

	userID int64

	ctx context.Context
	cancel context.CancelFunc
	notes []string

	pending *pendingWait

	origin *features.Origin

}

// Queue lets at most limit agents think at once across every user, one run per agent; everything else waits its turn.
type Queue struct {

	mu sync.Mutex

	running map[int64]*slot
	waiting []*job

	start StartRun
	listen RunListener
	onState func(agentID int64, state State)
	limit int

}

func NewQueue(start StartRun, listen RunListener, onState func(int64, State), limit int) *Queue {

	if limit <= 0 {

		limit = maxRunning

	}

	if onState == nil {

		onState = func(int64, State) {}

	}

	return &Queue{running: map[int64]*slot{}, start: start, listen: listen, onState: onState, limit: limit}

}

func (q *Queue) stateLocked(agentID int64) State {

	if running := q.running[agentID]; running != nil {

		if running.pending != nil {

			return Waiting

		}

		return Running

	}

	for _, queued := range q.waiting {

		if queued.agent.ID == agentID {

			return Queued

		}

	}

	return Idle

}

func (q *Queue) State(agentID int64) State {

	q.mu.Lock()
	defer q.mu.Unlock()

	return q.stateLocked(agentID)

}

// Question is what the agent waits on, with its kind; empty when it waits on nothing.
func (q *Queue) Question(agentID int64) (string, WaitKind) {

	q.mu.Lock()
	defer q.mu.Unlock()

	if running := q.running[agentID]; running != nil && running.pending != nil {

		return running.pending.question, running.pending.kind

	}

	return "", ""

}

// Answer is false when nothing was waiting, e.g. the question timed out; a non-empty kind limits it to one sort of wait.
func (q *Queue) Answer(agentID int64, reply Reply, kind WaitKind) bool {

	q.mu.Lock()

	var pending *pendingWait

	if running := q.running[agentID]; running != nil {

		pending = running.pending

	}

	q.mu.Unlock()

	if pending == nil || (kind != "" && pending.kind != kind) {

		return false

	}

	pending.answer(reply)

	return true

}

// Send is what a chat message does: joins the agent's current run if there is one, otherwise starts a new one.
func (q *Queue) Send(agent store.Agent, text string) {

	q.mu.Lock()

	if running := q.running[agent.ID]; running != nil {

		running.notes = append(running.notes, text)
		q.mu.Unlock()

		return

	}

	q.mu.Unlock()
	q.Enqueue(agent, text, nil)

}

// Enqueue starts a fresh run, after the agent's current one if it has one; two waiting from one conversation fold into one.
func (q *Queue) Enqueue(agent store.Agent, task string, origin *features.Origin) {

	q.mu.Lock()

	for _, queued := range q.waiting {

		// a hand-off from another conversation keeps its own run, or its reply would go to the wrong place
		if queued.agent.ID != agent.ID || !queued.origin.Same(origin) {

			continue

		}

		// a routine that fires every minute behind a long run would otherwise pile up one copy per minute
		if !strings.Contains(queued.task, task) {

			queued.task += "\n\n" + task

		}

		q.mu.Unlock()

		return

	}

	q.waiting = append(q.waiting, &job{agent: agent, task: task, origin: origin})
	q.mu.Unlock()

	q.onState(agent.ID, Queued)
	q.pump()

}

func (q *Queue) Stop(agentID int64) {

	q.mu.Lock()

	before := len(q.waiting)
	kept := q.waiting[:0]

	for _, queued := range q.waiting {

		if queued.agent.ID != agentID {

			kept = append(kept, queued)

		}

	}

	q.waiting = kept
	running := q.running[agentID]
	dropped := before != len(q.waiting) && running == nil
	q.mu.Unlock()

	q.Answer(agentID, Allow(false), "")

	if running != nil {

		running.cancel()

	}

	if dropped {

		q.onState(agentID, Idle)

	}

}

// nextLocked is the oldest job of whichever user has the fewest runs going, so one user's burst cannot take every slot.
func (q *Queue) nextLocked() int {

	load := func(userID int64) int {

		n := 0

		for _, running := range q.running {

			if running.userID == userID {

				n++

			}

		}

		return n

	}

	best := -1

	for index, queued := range q.waiting {

		if q.running[queued.agent.ID] != nil {

			continue

		}

		if best == -1 || load(queued.agent.UserID) < load(q.waiting[best].agent.UserID) {

			best = index

		}

	}

	return best

}

func (q *Queue) pump() {

	for {

		q.mu.Lock()

		if len(q.running) >= q.limit {

			q.mu.Unlock()

			return

		}

		index := q.nextLocked()

		if index == -1 {

			q.mu.Unlock()

			return

		}

		next := q.waiting[index]
		q.waiting = append(q.waiting[:index], q.waiting[index+1:]...)

		ctx, cancel := context.WithCancel(context.Background())
		running := &slot{userID: next.agent.UserID, ctx: ctx, cancel: cancel, origin: next.origin}
		id := next.agent.ID

		q.running[id] = running
		q.mu.Unlock()

		q.onState(id, Running)

		control := RunControl{

			Ctx: ctx,

			TakeNotes: func() []string {

				q.mu.Lock()
				defer q.mu.Unlock()

				notes := running.notes
				running.notes = nil

				return notes

			},

			Ask: func(question string, kind WaitKind) Reply {

				return q.wait(running, id, question, kind)

			},

			Listen: q.listen,

		}

		go q.run(next, running, control)

	}

}

func (q *Queue) wait(running *slot, agentID int64, question string, kind WaitKind) Reply {

	replies := make(chan Reply, 1)

	var once sync.Once

	answer := func(reply Reply) {

		once.Do(func() {

			q.mu.Lock()
			running.pending = nil
			q.mu.Unlock()

			q.onState(agentID, Running)
			replies <- reply

		})

	}

	q.mu.Lock()
	running.pending = &pendingWait{question: question, kind: kind, answer: answer}
	q.mu.Unlock()

	q.onState(agentID, Waiting)

	timer := time.AfterFunc(answerWait, func() { answer(Allow(false)) })
	stop := context.AfterFunc(running.ctx, func() { answer(Allow(false)) })

	defer timer.Stop()
	defer stop()

	return <-replies

}

func (q *Queue) run(next *job, running *slot, control RunControl) {

	id := next.agent.ID

	defer func() {

		if recovered := recover(); recovered != nil {

			log.Printf("run for %s failed: %v", next.agent.Name, recovered)

		}

		stopped := running.ctx.Err() != nil

		running.cancel()

		q.mu.Lock()
		delete(q.running, id)
		notes := running.notes
		running.notes = nil
		q.mu.Unlock()

		// a message that arrived after the agent's last step still deserves an answer
		if len(notes) > 0 && !stopped {

			q.Enqueue(next.agent, strings.Join(notes, "\n\n"), nil)

		}

		q.onState(id, q.State(id))
		q.pump()

	}()

	q.start(next.agent, next.task, control, next.origin)

}
