package sdk

import (
	"fmt"
	"strings"
)

func mapAPIState(state string) TurnStatus {

	normalized := strings.ToLower(state)

	switch {

	case normalized == "pending":

		return TurnPending

	case normalized == "error" || normalized == "failed":

		return TurnError

	case strings.Contains(normalized, "stream") || normalized == "running":

		return TurnStreaming

	}

	return TurnComplete

}

func deref(value *string) string {

	if value == nil {

		return ""

	}

	return *value

}

func TurnFromUserMessage(message Message) ChatTurn {

	return ChatTurn{

		ID: message.ID,
		Role: "user",

		Status: mapAPIState(message.State),

		Text: message.Submission,
		Blocks: []ContentBlock{},

		SubmissionID: message.ID,

		Created: message.Created,

	}

}

func TurnFromAssistantMessage(message Message, chatID string) ChatTurn {

	submissionID := message.ID

	if submissionID == "" {

		submissionID = fmt.Sprintf("assistant-%d", message.Created)

	}

	assistantID := deref(message.ResponseAssistantID)

	if assistantID == "" {

		assistantID = deref(message.PromptAssistantID)

	}

	status := mapAPIState(message.State)
	snapshot := StreamFromHistory(chatID, message.Responses, submissionID, assistantID, status == TurnComplete).Snapshot()

	turn := ChatTurn{

		ID: submissionID,
		Role: "assistant",

		Status: status,

		Text: snapshot.Text,
		Reasoning: snapshot.Reasoning,

		Blocks: []ContentBlock{},

		SubmissionID: submissionID,
		AssistantID: snapshot.AssistantID,

		Created: message.Created,

	}

	for _, block := range snapshot.Blocks {

		if block.Kind == "error" && turn.Error == "" {

			turn.Status = TurnError
			turn.Error = block.Content

		}

		if block.Kind != "progress" {

			turn.Blocks = append(turn.Blocks, block)

		}

	}

	return turn

}

// TurnsFromChatDetail lists a chat's turns; when Boodle keeps prompts only on Assistant rows, user turns are rebuilt from them.
func TurnsFromChatDetail(detail ChatDetail) []ChatTurn {

	hasUsers := false

	for _, message := range detail.Messages {

		if message.Type == "User" {

			hasUsers = true

		}

	}

	turns := []ChatTurn{}

	for _, message := range detail.Messages {

		switch message.Type {

		case "User":

			turns = append(turns, TurnFromUserMessage(message))

		case "Assistant":

			assistant := TurnFromAssistantMessage(message, detail.Chat.ID)

			if prompt := strings.TrimSpace(message.Submission); !hasUsers && prompt != "" {

				turns = append(turns, ChatTurn{

					ID: "user:" + assistant.ID,
					Role: "user",

					Status: TurnComplete,

					Text: prompt,
					Blocks: []ContentBlock{},

					SubmissionID: assistant.ID,

					Created: message.Created,

				})

			}

			turns = append(turns, assistant)

		}

	}

	return turns

}

func TurnFromSnapshot(snapshot ResponseSnapshot, id string) ChatTurn {

	status := TurnPending

	switch {

	case snapshot.Status == StreamError || snapshot.Error != "":

		status = TurnError

	case snapshot.Status == StreamComplete:

		status = TurnComplete

	case snapshot.Status == StreamStreaming:

		status = TurnStreaming

	}

	if id == "" {

		id = snapshot.SubmissionID

	}

	if id == "" {

		id = "stream-" + snapshot.ChatID

	}

	return ChatTurn{

		ID: id,
		Role: "assistant",

		Status: status,

		Text: snapshot.Text,
		Reasoning: snapshot.Reasoning,

		Blocks: snapshot.Blocks,

		SubmissionID: snapshot.SubmissionID,
		AssistantID: snapshot.AssistantID,

		Error: snapshot.Error,

		Usage: snapshot.Usage,

	}

}
