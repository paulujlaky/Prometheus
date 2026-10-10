package sdk

import (
	"encoding/json"
	"strconv"
)

// Millis is a Unix time in milliseconds; Boodle sometimes sends it as a float or null.
type Millis int64

func (m *Millis) UnmarshalJSON(data []byte) error {

	var value *float64

	if err := json.Unmarshal(data, &value); err != nil {

		var text string

		if json.Unmarshal(data, &text) != nil {

			return err

		}

		parsed, parseErr := strconv.ParseFloat(text, 64)

		if parseErr != nil {

			return err

		}

		value = &parsed

	}

	if value == nil {

		*m = 0

		return nil

	}

	*m = Millis(*value)

	return nil

}

type Chat struct {

	ID string `json:"id"`
	Name string `json:"name"`

	ChatType string `json:"chatType"`
	State string `json:"state"`

	CreatedBy string `json:"createdBy"`
	OrgID string `json:"orgId"`

	LastMessage Millis `json:"lastMessage"`
	Created Millis `json:"created"`
	Modified Millis `json:"modified"`

}

type ChatListResponse struct {

	Entries []Chat `json:"entries"`

	Total int `json:"total"`
	Offset int `json:"offset"`
	Limit int `json:"limit"`

}

type AssistantSummary struct {

	ID string `json:"id"`
	Name string `json:"name"`

	Alias string `json:"alias,omitempty"`
	Description string `json:"description,omitempty"`

	// API is the provider slug from the catalog, Model the upstream model id.
	API string `json:"api,omitempty"`
	Model string `json:"model,omitempty"`

	ContextLength int `json:"contextLength,omitempty"`
	MaxTokens int `json:"maxTokens,omitempty"`

}

type CustomModel struct {

	ID string `json:"id"`
	Name string `json:"name"`

	TaskID string `json:"taskId,omitempty"`

	API string `json:"api,omitempty"`
	Model string `json:"model,omitempty"`

	ContextLength int `json:"contextLength,omitempty"`
	MaxTokens int `json:"maxTokens,omitempty"`

}

type CustomBotDraft struct {

	ID string `json:"id"`
	Name string `json:"name"`

	CurrentVersionID string `json:"currentVersionId,omitempty"`

	Description string `json:"description,omitempty"`

}

type PublishedBot struct {

	ID string `json:"id"`
	Name string `json:"name"`

}

type CustomBotGroup struct {

	ChatID string `json:"chatId"`
	BotBuilderChatID string `json:"botBuilderChatId"`

	Draft CustomBotDraft `json:"draft"`

	Published *PublishedBot `json:"published"`

}

type CustomBotList struct {

	Total int `json:"total"`
	Entries []CustomBotGroup `json:"entries"`

}

type CustomBotInput struct {

	Name string
	ModelID string

	Instructions string
	Description string

}

// RawPart is an opaque message part from the stream or history.
type RawPart = map[string]any

// Message is either row type of a chat's history; Type is "User" or "Assistant".
type Message struct {

	ID string `json:"id"`
	ChatID string `json:"chatId"`

	Type string `json:"type"`
	State string `json:"state"`

	// On Assistant rows this is the user's prompt for the turn, never the answer.
	Submission string `json:"submission"`
	Responses []RawPart `json:"responses"`

	PromptAssistantID *string `json:"promptAssistantId"`
	ResponseAssistantID *string `json:"responseAssistantId"`

	CreatedBy string `json:"createdBy"`

	Created Millis `json:"created"`
	Modified Millis `json:"modified"`

}

type ChatDetail struct {

	Chat Chat `json:"chat"`

	Messages []Message `json:"messages"`

}

type SendOptions struct {

	// AssistantID falls back to the cookie's preferred assistant.
	AssistantID string

}

type sendRequest struct {

	CoachModeUsed bool `json:"coachModeUsed"`
	FullTextSearchUsed bool `json:"fullTextSearchUsed"`
	MemoryModeUsed bool `json:"memoryModeUsed"`

	Mentions []any `json:"mentions"`

	Message sendContent `json:"message"`

	AssistantID string `json:"assistantId"`

}

type sendContent struct {

	Content string `json:"content"`
	Type string `json:"type"`

}

// WsData is any inbound parrot payload; it always has a string "type".
type WsData = map[string]any

type WsEnvelope struct {

	EntityID string
	UserID string

	Data WsData

	Timestamp float64

}

type wsOutbound struct {

	Type string `json:"type"`

	ChatID string `json:"chatId"`
	UserID string `json:"userId"`

}

type TurnStatus string

const (
	TurnPending TurnStatus = "pending"
	TurnStreaming TurnStatus = "streaming"
	TurnComplete TurnStatus = "complete"
	TurnError TurnStatus = "error"
)

// ContentBlock is one piece of an assistant turn; Kind says which fields mean something.
type ContentBlock struct {

	Kind string `json:"kind"`
	Key string `json:"key"`

	// text and reasoning
	SectionType string `json:"sectionType,omitempty"`
	Text string `json:"text,omitempty"`
	Streaming bool `json:"streaming,omitempty"`

	// progress and error
	Content string `json:"content,omitempty"`
	Opcode *int `json:"opcode,omitempty"`

	// link and image
	Title string `json:"title,omitempty"`
	URL string `json:"url,omitempty"`
	LinkType string `json:"linkType,omitempty"`

	Language string `json:"language,omitempty"`

	// unknown
	Type string `json:"type,omitempty"`
	Raw map[string]any `json:"raw,omitempty"`

}

type ChatTurn struct {

	ID string `json:"id"`

	Role string `json:"role"`
	Status TurnStatus `json:"status"`

	// Text is the visible answer; reasoning sections are kept apart in Reasoning.
	Text string `json:"text"`
	Reasoning string `json:"reasoning,omitempty"`

	Blocks []ContentBlock `json:"blocks"`

	SubmissionID string `json:"submissionId,omitempty"`
	AssistantID string `json:"assistantId,omitempty"`

	Created Millis `json:"created,omitempty"`
	Error string `json:"error,omitempty"`

	Usage map[string]any `json:"usage,omitempty"`

}

type StreamStatus string

const (
	StreamIdle StreamStatus = "idle"
	StreamStreaming StreamStatus = "streaming"
	StreamComplete StreamStatus = "complete"
	StreamError StreamStatus = "error"
)

type ResponseSnapshot struct {

	ChatID string

	SubmissionID string
	AssistantID string

	Status StreamStatus

	// Text is answer text only, safe for parsing commands out of.
	Text string
	Reasoning string

	Blocks []ContentBlock

	Progress string

	Links []ContentBlock
	Images []ContentBlock

	Error string

	Usage map[string]any

}

type ChangeKind string

const (
	ChangeStarted ChangeKind = "started"
	ChangeDelta ChangeKind = "delta"
	ChangeSection ChangeKind = "section"
	ChangeProgress ChangeKind = "progress"
	ChangeBlock ChangeKind = "block"
	ChangeComplete ChangeKind = "complete"
	ChangeError ChangeKind = "error"
	ChangeUnknown ChangeKind = "unknown"
)

// StreamChange is one mutation of a ResponseStream; Kind says which fields are set.
type StreamChange struct {

	Kind ChangeKind

	Snapshot ResponseSnapshot

	// delta and section
	Text string
	SectionKey string
	SectionType string

	// progress and error
	Content string
	Opcode *int

	Block *ContentBlock

	UserText string

	Data WsData

}
