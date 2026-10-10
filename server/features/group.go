// Package features holds group threads and routines, which wake agents with tasks.
package features

import (
	"sort"
	"strings"
	"unicode/utf8"

	"boombox/config"
	"boombox/store"
)

// each agent-to-agent hand-off costs a full run; a loop of two polite agents would otherwise never end
var MaxHops = config.Int("PTS_MAX_HOPS", 6)

const (
	recentMessages = 20
	recentChars = 600
)

// Origin is the chain one user message starts; every hand-off it causes carries the count forward.
type Origin struct {

	Chain int64
	Hops int

	// Group is the thread replies go back to; 0 is Everyone.
	Group int64

	// Direct is a chain between agents' own chats, outside any thread; ReplyTo is the agent waiting on this run's <done>.
	Direct bool
	ReplyTo int64

}

// Same is true for two runs of one conversation, which may fold into one; Hops does not tell them apart.
func (o *Origin) Same(other *Origin) bool {

	if o == nil || other == nil {

		return o == nil && other == nil

	}

	return o.Chain == other.Chain && o.Group == other.Group && o.Direct == other.Direct && o.ReplyTo == other.ReplyTo

}

// Mentioned finds agents named as @Name, longest names first so "@Scout Two" is not read as "@Scout".
func Mentioned(text string, agents []store.Agent) []store.Agent {

	rest := strings.ToLower(text)
	sorted := append([]store.Agent(nil), agents...)
	found := []store.Agent{}

	sort.SliceStable(sorted, func(i, j int) bool { return len(sorted[i].Name) > len(sorted[j].Name) })

	for _, agent := range sorted {

		tag := "@" + strings.ToLower(agent.Name)

		if strings.Contains(rest, tag) {

			found = append(found, agent)
			rest = strings.ReplaceAll(rest, tag, "")

		}

	}

	return found

}

// Route is who a message wakes, or Capped when the hand-off limit stops the chain.
type Route struct {

	Recipients []store.Agent
	Origin Origin

	Capped bool

}

// RouteMessage picks recipients from the thread's agents: the user wakes whoever they @mention or everyone, an agent only whom it @mentions.
func RouteMessage(message store.GroupMessage, agents []store.Agent, origin *Origin) Route {

	named := []store.Agent{}

	for _, agent := range Mentioned(message.Text, agents) {

		if message.AgentID == nil || agent.ID != *message.AgentID {

			named = append(named, agent)

		}

	}

	group := message.GroupID

	if message.AgentID == nil {

		recipients := named

		if len(recipients) == 0 {

			recipients = agents

		}

		return Route{Recipients: recipients, Origin: Origin{Chain: message.ID, Group: group}}

	}

	if len(named) == 0 {

		next := Origin{Chain: message.ID, Group: group}

		if origin != nil {

			next = *origin

		}

		return Route{Recipients: []store.Agent{}, Origin: next}

	}

	hops := 1
	chain := message.ID

	if origin != nil {

		hops = origin.Hops + 1
		chain = origin.Chain

	}

	if hops > MaxHops {

		return Route{Capped: true}

	}

	return Route{Recipients: named, Origin: Origin{Chain: chain, Hops: hops, Group: group}}

}

// IsWaiting is <done>wait</done>: the agent's turn comes after someone else's, so there is nothing to post.
func IsWaiting(done string) bool {

	text := strings.ToLower(strings.TrimSpace(done))

	if strings.HasSuffix(text, ".") || strings.HasSuffix(text, "!") {

		text = text[:len(text)-1]

	}

	return text == "wait"

}

func clip(text string, limit int) string {

	if utf8.RuneCountInString(text) <= limit {

		return text

	}

	return string([]rune(text)[:limit-1]) + "…"

}

func GroupTask(agent store.Agent, agents []store.Agent, recent []store.GroupMessage, message store.GroupMessage, title string) string {

	others := []string{}

	for _, other := range agents {

		if other.ID != agent.ID {

			others = append(others, other.Name)

		}

	}

	if len(recent) > recentMessages {

		recent = recent[len(recent)-recentMessages:]

	}

	history := make([]string, len(recent))

	for i, line := range recent {

		history[i] = line.Author + ": " + clip(line.Text, recentChars)

	}

	with := ""

	if len(others) > 0 {

		with = " and " + strings.Join(others, ", ")

	}

	// the PWA reads the thread's name and the new message back out of this shape
	parts := []string{"[Group thread \"" + title + "\", with the user" + with + ".]"}

	if len(history) > 0 {

		parts = append(parts, "Recent messages:\n\n"+strings.Join(history, "\n\n"))

	}

	return strings.Join(append(parts,

		"New message from "+message.Author+":\n\n"+message.Text,
		"Your <done> is posted to the thread: a sentence, like a group chat message. If your part needs another agent's result first, reply only <done>wait</done>; nothing is posted, and you are woken when they @mention you.",

	), "\n\n")

}
