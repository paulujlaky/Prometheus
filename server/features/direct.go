package features

import (
	"strings"

	"boombox/store"
)

// Delivery is one task a finished run hands to another agent.
type Delivery struct {

	To store.Agent
	Task string
	Origin Origin

}

// DirectRoute is where a run outside any thread sends its <done>, or Capped when the hand-off limit stops the chain.
type DirectRoute struct {

	Deliveries []Delivery

	Capped bool

}

// DirectTask is what an agent gets when another @mentions it from its own chat; the PWA shows the line under the header as a note.
func DirectTask(from store.Agent, text string) string {

	return "[Message from " + from.Name + "]\n\n" + strings.TrimSpace(text) + "\n\n[Your <done> goes back to " + from.Name + ": put the result itself in it.]"

}

// ReplyTask is what the asking agent gets back, so it can carry on with the user's task.
func ReplyTask(from store.Agent, text string, failed bool) string {

	body := strings.TrimSpace(text)

	if failed {

		body = "Could not finish: " + body

	}

	return "[Reply from " + from.Name + "]\n\n" + body + "\n\n[Carry on with the task it was for; your <done> goes to the user.]"

}

// RouteDirect hands a run's ending on: back to whoever asked for it, and to every other agent it @mentions.
func RouteDirect(author store.Agent, end store.AgentEvent, agents []store.Agent, origin *Origin) DirectRoute {

	chain, hops, replyTo := end.ID, 0, int64(0)

	if origin != nil {

		chain, hops, replyTo = origin.Chain, origin.Hops, origin.ReplyTo

	}

	others := []store.Agent{}

	var asker *store.Agent

	for i, agent := range agents {

		if agent.ID == author.ID {

			continue

		}

		others = append(others, agent)

		if agent.ID == replyTo {

			asker = &agents[i]

		}

	}

	deliveries := []Delivery{}
	failed := end.Kind != store.KindDone

	if failed || IsWaiting(end.Text) {

		// a failure still goes back, so the asker is not left waiting on it
		if failed && asker != nil {

			deliveries = append(deliveries, Delivery{To: *asker, Task: ReplyTask(author, end.Text, true), Origin: Origin{Chain: chain, Hops: hops + 1, Direct: true}})

		}

	} else {

		if asker != nil {

			deliveries = append(deliveries, Delivery{To: *asker, Task: ReplyTask(author, end.Text, false), Origin: Origin{Chain: chain, Hops: hops + 1, Direct: true}})

		}

		for _, named := range Mentioned(end.Text, others) {

			if named.ID != replyTo {

				deliveries = append(deliveries, Delivery{To: named, Task: DirectTask(author, end.Text), Origin: Origin{Chain: chain, Hops: hops + 1, Direct: true, ReplyTo: author.ID}})

			}

		}

	}

	if len(deliveries) > 0 && hops+1 > MaxHops {

		return DirectRoute{Capped: true}

	}

	return DirectRoute{Deliveries: deliveries}

}
