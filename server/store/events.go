package store

import (
	"math"
	"strconv"
)

type EventKind string

const (
	KindTask EventKind = "task"
	KindUser EventKind = "user"
	KindAssistant EventKind = "assistant"
	KindResult EventKind = "result"
	KindSay EventKind = "say"
	KindNotify EventKind = "notify"
	KindAsk EventKind = "ask"
	KindQuestion EventKind = "question"
	KindHandoff EventKind = "handoff"
	KindDone EventKind = "done"
	KindError EventKind = "error"
)

// AgentEvent is sent to the PWA as it is, so its JSON names are the ones in web/Lib/types.ts.
type AgentEvent struct {

	ID int64 `json:"id"`
	AgentID int64 `json:"agentId"`
	RunID string `json:"runId"`

	Kind EventKind `json:"kind"`
	Text string `json:"text"`

	At int64 `json:"at"`

}

// Newest is the "before" that pages from the latest row.
const Newest = math.MaxInt64

const eventColumns = "id, agent_id, run_id, kind, text, at"

func itoa(id int64) string {

	return strconv.FormatInt(id, 10)

}

func (s *Store) AddEvent(agentID int64, runID string, kind EventKind, text string) (AgentEvent, error) {

	event := AgentEvent{AgentID: agentID, RunID: runID, Kind: kind, Text: text, At: now()}
	err := s.db.QueryRow("insert into events (agent_id, run_id, kind, text, at) values (?, ?, ?, ?, ?) returning id", agentID, runID, kind, text, event.At).Scan(&event.ID)

	return event, err

}

func (s *Store) scanEvents(query string, args ...any) ([]AgentEvent, error) {

	rows, err := s.db.Query(query, args...)

	if err != nil {

		return nil, err

	}

	defer rows.Close()

	events := []AgentEvent{}

	for rows.Next() {

		var event AgentEvent

		if err := rows.Scan(&event.ID, &event.AgentID, &event.RunID, &event.Kind, &event.Text, &event.At); err != nil {

			return nil, err

		}

		events = append(events, event)

	}

	return events, rows.Err()

}

// ListEvents is the newest limit events before before, oldest first: a page of history scrolling upward.
func (s *Store) ListEvents(agentID int64, limit int, before int64) ([]AgentEvent, error) {

	return s.scanEvents("select * from (select "+eventColumns+" from events where agent_id = ? and id < ? order by id desc limit ?) order by id", agentID, before, limit)

}

type RecentRun struct {

	Task string
	Outcome string

	At int64

}

// RecentRuns is the task and ending of each recent run, oldest first: what an agent sees of its own past.
func (s *Store) RecentRuns(agentID int64, runs int) ([]RecentRun, error) {

	events, err := s.scanEvents(`
    select `+eventColumns+` from events
    where agent_id = ?1 and kind in ('task', 'done', 'error')
    and run_id in (select run_id from events where agent_id = ?1 and kind = 'task' order by id desc limit ?2)
    order by id
  `, agentID, runs)

	if err != nil {

		return nil, err

	}

	order := []string{}
	byRun := map[string]*RecentRun{}

	for _, event := range events {

		entry := byRun[event.RunID]

		if entry == nil {

			entry = &RecentRun{At: event.At}
			byRun[event.RunID] = entry
			order = append(order, event.RunID)

		}

		switch event.Kind {

		case KindTask:

			entry.Task = event.Text

		case KindError:

			entry.Outcome = "failed: " + event.Text

		default:

			entry.Outcome = event.Text

		}

	}

	recent := make([]RecentRun, 0, len(order))

	for _, runID := range order {

		recent = append(recent, *byRun[runID])

	}

	return recent, nil

}

func (s *Store) readMark(userID int64, key string) int64 {

	mark, _ := strconv.ParseInt(s.ReadSetting(userID, key), 10, 64)

	return mark

}

// UnreadEvents counts what the agent said since its chat was last open: says, and every done but a "wait".
func (s *Store) UnreadEvents(agent *Agent) int64 {

	return s.count("select count(*) from events where agent_id = ? and id > ? and (kind = 'say' or (kind = 'done' and lower(trim(text, ' .!' || char(9, 10, 13))) != 'wait'))", agent.ID, s.readMark(agent.UserID, "read:agent:"+itoa(agent.ID)))

}

func (s *Store) UnreadGroup(userID, groupID int64) int64 {

	return s.count("select count(*) from group_messages where user_id = ? and group_id = ? and author != 'user' and id > ?", userID, groupID, s.readMark(userID, "read:group:"+itoa(groupID)))

}

// MarkRead marks an agent's chat, or a group thread when group is true, read up to its latest row.
func (s *Store) MarkRead(userID int64, group bool, id int64) error {

	if group {

		latest := s.count("select coalesce(max(id), 0) from group_messages where user_id = ? and group_id = ?", userID, id)

		return s.WriteSetting(userID, "read:group:"+itoa(id), itoa(latest))

	}

	latest := s.count("select coalesce(max(id), 0) from events where agent_id = ?", id)

	return s.WriteSetting(userID, "read:agent:"+itoa(id), itoa(latest))

}
