package sdk

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// ExtractText pulls human-readable text out of nested content arrays (PlainText, Stream, ...).
func ExtractText(content any) string {

	switch value := content.(type) {

	case string:

		return value

	case map[string]any:

		text, _ := value["content"].(string)

		return text

	case []any:

		var out strings.Builder

		for _, item := range value {

			if text, ok := item.(string); ok {

				out.WriteString(text)

				continue

			}

			if rec, ok := item.(map[string]any); ok {

				if text, ok := rec["content"].(string); ok {

					out.WriteString(text)

				}

			}

		}

		return out.String()

	}

	return ""

}

func sectionKey(index int64) string {

	return "section:" + strconv.FormatInt(index, 10)

}

type sectionState struct {

	index int64
	sectionType string

	text string

	streaming bool

}

func isReasoningSection(sectionType string) bool {

	return strings.EqualFold(sectionType, "reasoning")

}

// ResponseStream assembles one assistant generation from incremental parts or a full history row.
type ResponseStream struct {

	ChatID string

	SubmissionID string
	AssistantID string
	Status StreamStatus

	sections map[int64]*sectionState
	sectionOrder []int64

	progressItems []string
	latestProgress string

	links []ContentBlock
	images []ContentBlock
	codes []ContentBlock

	unknowns []ContentBlock
	errors []ContentBlock

	unknownSeq int
	errorSeq int

	lastError string
	usage map[string]any

}

func NewResponseStream(chatID, submissionID string) *ResponseStream {

	return &ResponseStream{

		ChatID: chatID,
		SubmissionID: submissionID,
		Status: StreamIdle,

		sections: map[int64]*sectionState{},

	}

}

func StreamFromHistory(chatID string, parts []RawPart, submissionID, assistantID string, complete bool) *ResponseStream {

	stream := NewResponseStream(chatID, submissionID)

	stream.AssistantID = assistantID
	stream.IngestParts(parts, true)

	if complete {

		stream.Status = StreamComplete

	} else {

		stream.Status = StreamStreaming

	}

	return stream

}

func (r *ResponseStream) clearParts() {

	r.sections = map[int64]*sectionState{}
	r.sectionOrder = nil

	r.progressItems = nil
	r.latestProgress = ""

	r.links = nil
	r.images = nil
	r.codes = nil

	r.unknowns = nil
	r.errors = nil

	r.lastError = ""

}

func (r *ResponseStream) reset() {

	r.clearParts()

	r.unknownSeq = 0
	r.errorSeq = 0

	r.usage = nil
	r.Status = StreamIdle
	r.AssistantID = ""

}

func (r *ResponseStream) Snapshot() ResponseSnapshot {

	return ResponseSnapshot{

		ChatID: r.ChatID,

		SubmissionID: r.SubmissionID,
		AssistantID: r.AssistantID,

		Status: r.Status,

		Text: r.FullText(),
		Reasoning: r.ReasoningText(),

		Blocks: r.Blocks(),

		Progress: r.latestProgress,

		Links: append([]ContentBlock(nil), r.links...),
		Images: append([]ContentBlock(nil), r.images...),

		Error: r.lastError,

		Usage: r.usage,

	}

}

// FullText is the answer surface only; reasoning is left out so command parsers stay clean.
func (r *ResponseStream) FullText() string {

	parts := []string{}

	for _, index := range r.sectionOrder {

		section := r.sections[index]

		if section == nil || section.text == "" || isReasoningSection(section.sectionType) {

			continue

		}

		parts = append(parts, section.text)

	}

	return strings.Join(parts, "\n\n")

}

func (r *ResponseStream) ReasoningText() string {

	parts := []string{}

	for _, index := range r.sectionOrder {

		section := r.sections[index]

		if section != nil && section.text != "" && isReasoningSection(section.sectionType) {

			parts = append(parts, section.text)

		}

	}

	return strings.Join(parts, "\n\n")

}

func (r *ResponseStream) Blocks() []ContentBlock {

	out := []ContentBlock{}

	for _, index := range r.sectionOrder {

		section := r.sections[index]

		if section == nil {

			continue

		}

		kind := "text"

		if isReasoningSection(section.sectionType) {

			kind = "reasoning"

		}

		out = append(out, ContentBlock{

			Kind: kind,
			Key: sectionKey(index),

			SectionType: section.sectionType,
			Text: section.text,
			Streaming: section.streaming,

		})

	}

	for _, content := range r.progressItems {

		out = append(out, ContentBlock{Kind: "progress", Key: "progress:" + content, Content: content})

	}

	out = append(out, r.links...)
	out = append(out, r.images...)
	out = append(out, r.codes...)
	out = append(out, r.errors...)
	out = append(out, r.unknowns...)

	return out

}

func (r *ResponseStream) HandleData(data WsData) []StreamChange {

	if chatID, ok := data["chatId"].(string); ok && chatID != "" && chatID != r.ChatID {

		return nil

	}

	switch data["type"] {

	case "MessageSubmission":

		return r.onSubmission(data)

	case "MessageIncrementalResponse":

		r.bindMeta(data)
		r.Status = StreamStreaming

		return r.IngestParts(asPartArray(data["message"]), false)

	case "MessageFinalResponse":

		return r.onFinal(data)

	}

	return []StreamChange{{Kind: ChangeUnknown, Snapshot: r.Snapshot(), Data: data}}

}

// IngestParts applies a batch of parts, optionally replacing everything seen so far.
func (r *ResponseStream) IngestParts(parts []RawPart, replace bool) []StreamChange {

	if replace {

		r.clearParts()

	}

	changes := []StreamChange{}

	for _, part := range parts {

		changes = append(changes, r.applyPart(part)...)

	}

	return changes

}

func (r *ResponseStream) onSubmission(data WsData) []StreamChange {

	submissionID, ok := str(data["submissionId"])

	if !ok {

		submissionID, ok = str(data["id"])

	}

	if !ok {

		submissionID = r.SubmissionID

	}

	r.reset()

	r.SubmissionID = submissionID
	r.AssistantID, _ = str(data["assistantId"])
	r.Status = StreamStreaming

	userText := ""

	if message, ok := data["message"].(map[string]any); ok {

		userText = ExtractText(message)

		if userText == "" {

			userText = ExtractText(message["content"])

		}

	}

	return []StreamChange{{Kind: ChangeStarted, Snapshot: r.Snapshot(), UserText: userText}}

}

func (r *ResponseStream) onFinal(data WsData) []StreamChange {

	r.bindMeta(data)

	if usage, ok := data["usage"].(map[string]any); ok {

		r.usage = usage

	}

	// the final payload is authoritative, so text and links are rebuilt from it
	changes := r.IngestParts(asPartArray(data["message"]), true)

	r.latestProgress = ""

	for _, section := range r.sections {

		section.streaming = false

	}

	if r.lastError != "" && r.FullText() == "" {

		r.Status = StreamError

		return append(changes, StreamChange{Kind: ChangeError, Snapshot: r.Snapshot(), Content: r.lastError})

	}

	r.Status = StreamComplete

	return append(changes, StreamChange{Kind: ChangeComplete, Snapshot: r.Snapshot()})

}

func (r *ResponseStream) bindMeta(data WsData) {

	if submissionID, ok := str(data["submissionId"]); ok && submissionID != "" {

		r.SubmissionID = submissionID

	}

	if assistantID, present := data["assistantId"]; present {

		r.AssistantID, _ = str(assistantID)

	}

}

func (r *ResponseStream) applyPart(part RawPart) []StreamChange {

	kind := "Unknown"

	if value, ok := part["type"]; ok && value != nil {

		kind = fmt.Sprint(value)

	}

	switch kind {

	case "StreamSectionStart":

		return r.onSectionStart(part)

	case "StreamSection":

		return r.onStreamSection(part)

	case "SectionResponse":

		return r.onSectionResponse(part)

	case "Progress":

		return r.onProgress(textOf(part["content"]))

	case "Link":

		return r.onLink(part)

	case "Image":

		return r.onImage(part)

	case "CodeBlock":

		return r.onCode(part)

	case "SectionHeader":

		content := textOf(part["content"])

		if content == "" {

			content, _ = str(part["sectionType"])

		}

		return r.onProgress(content)

	case "Error":

		return r.onError(part)

	}

	return r.onUnknownPart(part, kind)

}

func (r *ResponseStream) onSectionStart(part RawPart) []StreamChange {

	index, ok := num(part["index"])

	if !ok {

		return nil

	}

	sectionType, ok := str(part["sectionType"])

	if !ok {

		sectionType = "Text"

	}

	r.ensureSection(index, sectionType, true)

	return []StreamChange{{Kind: ChangeSection, Snapshot: r.Snapshot(), SectionKey: sectionKey(index), SectionType: sectionType}}

}

func (r *ResponseStream) onStreamSection(part RawPart) []StreamChange {

	index, ok := num(part["index"])

	if !ok {

		return nil

	}

	// an existing Reasoning or Text type is kept; Text is only the default for a new section
	sectionType := "Text"

	if existing := r.sections[index]; existing != nil {

		sectionType = existing.sectionType

	}

	section := r.ensureSection(index, sectionType, true)
	chunks, _ := part["content"].([]any)
	changes := []StreamChange{}

	for _, chunk := range chunks {

		rec, ok := chunk.(map[string]any)

		if !ok {

			continue

		}

		piece, isText := rec["content"].(string)

		if typed, has := rec["type"]; has && typed != nil && typed != "Stream" && !isText {

			continue

		}

		if piece == "" {

			// empty content with seq -1 marks the end of the section, not a delta
			if seq, ok := num(rec["seq"]); ok && seq == -1 {

				section.streaming = false

			}

			continue

		}

		section.text += piece
		section.streaming = true

		changes = append(changes, StreamChange{

			Kind: ChangeDelta,
			Snapshot: r.Snapshot(),

			Text: piece,
			SectionKey: sectionKey(index),
			SectionType: section.sectionType,

		})

	}

	return changes

}

func (r *ResponseStream) onSectionResponse(part RawPart) []StreamChange {

	index, ok := num(part["index"])

	if !ok {

		index = int64(len(r.sectionOrder))

	}

	sectionType, ok := str(part["sectionType"])

	if !ok {

		sectionType = "Text"

	}

	section := r.ensureSection(index, sectionType, false)

	section.text = ExtractText(part["content"])
	section.sectionType = sectionType
	section.streaming = false

	return []StreamChange{{Kind: ChangeSection, Snapshot: r.Snapshot(), SectionKey: sectionKey(index), SectionType: sectionType}}

}

func (r *ResponseStream) onError(part RawPart) []StreamChange {

	content := textOf(part["content"])

	if content == "" {

		content = "Something went wrong."

	}

	var opcode *int

	if value, ok := num(part["opcode"]); ok {

		code := int(value)
		opcode = &code

	}

	r.lastError = content
	r.errorSeq++

	r.errors = append(r.errors, ContentBlock{

		Kind: "error",
		Key: "error:" + strconv.Itoa(r.errorSeq),

		Content: content,
		Opcode: opcode,

	})

	r.Status = StreamError

	return []StreamChange{{Kind: ChangeError, Snapshot: r.Snapshot(), Content: content, Opcode: opcode}}

}

func (r *ResponseStream) onProgress(content string) []StreamChange {

	if content == "" {

		return nil

	}

	r.latestProgress = content

	// a repeated step moves to the end as the latest
	kept := r.progressItems[:0]

	for _, item := range r.progressItems {

		if item != content {

			kept = append(kept, item)

		}

	}

	r.progressItems = append(kept, content)

	return []StreamChange{{Kind: ChangeProgress, Snapshot: r.Snapshot(), Content: content}}

}

func (r *ResponseStream) onLink(part RawPart) []StreamChange {

	title, _ := str(part["title"])
	url, _ := str(part["url"])

	linkType, ok := str(part["linkType"])

	if !ok {

		linkType = "Web"

	}

	key := "link:" + url

	if url == "" {

		key = "link:" + title

	}

	for _, link := range r.links {

		if link.Key == key {

			return nil

		}

	}

	block := ContentBlock{Kind: "link", Key: key, Title: title, URL: url, LinkType: linkType}

	r.links = append(r.links, block)

	return []StreamChange{{Kind: ChangeBlock, Snapshot: r.Snapshot(), Block: &block}}

}

func (r *ResponseStream) onImage(part RawPart) []StreamChange {

	url, ok := str(part["imageUrl"])

	if !ok {

		url, _ = str(part["url"])

	}

	title, _ := str(part["title"])
	key := "image:" + url

	if url == "" {

		return nil

	}

	for _, image := range r.images {

		if image.Key == key {

			return nil

		}

	}

	block := ContentBlock{Kind: "image", Key: key, URL: url, Title: title}

	r.images = append(r.images, block)

	return []StreamChange{{Kind: ChangeBlock, Snapshot: r.Snapshot(), Block: &block}}

}

func (r *ResponseStream) onCode(part RawPart) []StreamChange {

	text := textOf(part["content"])

	if text == "" {

		text, _ = str(part["code"])

	}

	language, ok := str(part["language"])

	if !ok {

		language, _ = str(part["lang"])

	}

	if text == "" {

		return nil

	}

	block := ContentBlock{Kind: "code", Key: fmt.Sprintf("code:%d:%s", len(r.codes), language), Language: language, Text: text}

	r.codes = append(r.codes, block)

	return []StreamChange{{Kind: ChangeBlock, Snapshot: r.Snapshot(), Block: &block}}

}

func (r *ResponseStream) onUnknownPart(part RawPart, kind string) []StreamChange {

	hasSection := part["sectionType"] != nil
	hasIndex := part["index"] != nil

	// text-shaped content under a section is surfaced as a text block
	if text := ExtractText(part["content"]); text != "" && (hasSection || hasIndex) {

		index, ok := num(part["index"])

		if !ok {

			index = time.Now().UnixMilli()

		}

		sectionType, ok := str(part["sectionType"])

		if !ok {

			sectionType = kind

		}

		section := r.ensureSection(index, sectionType, false)

		section.text = text
		section.streaming = false

		return []StreamChange{{Kind: ChangeSection, Snapshot: r.Snapshot(), SectionKey: sectionKey(index), SectionType: section.sectionType}}

	}

	r.unknownSeq++

	raw := make(map[string]any, len(part))

	for key, value := range part {

		raw[key] = value

	}

	block := ContentBlock{Kind: "unknown", Key: fmt.Sprintf("unknown:%s:%d", kind, r.unknownSeq), Type: kind, Raw: raw}

	r.unknowns = append(r.unknowns, block)

	return []StreamChange{{Kind: ChangeBlock, Snapshot: r.Snapshot(), Block: &block}}

}

func (r *ResponseStream) ensureSection(index int64, sectionType string, streaming bool) *sectionState {

	section := r.sections[index]

	if section == nil {

		section = &sectionState{index: index, sectionType: sectionType, streaming: streaming}

		r.sections[index] = section
		r.sectionOrder = append(r.sectionOrder, index)

	} else if sectionType != "" && section.sectionType == "Text" && sectionType != "Text" {

		section.sectionType = sectionType

	}

	if streaming {

		section.streaming = true

	}

	return section

}

func asPartArray(value any) []RawPart {

	items, _ := value.([]any)
	parts := make([]RawPart, 0, len(items))

	for _, item := range items {

		if part, ok := item.(map[string]any); ok {

			parts = append(parts, part)

		}

	}

	return parts

}

// textOf is a part's content as a plain string, or the text nested inside it.
func textOf(value any) string {

	if text, ok := str(value); ok {

		return text

	}

	return ExtractText(value)

}

func str(value any) (string, bool) {

	switch v := value.(type) {

	case string:

		return v, true

	case float64:

		return strconv.FormatFloat(v, 'f', -1, 64), true

	case bool:

		return strconv.FormatBool(v), true

	}

	return "", false

}

func num(value any) (int64, bool) {

	switch v := value.(type) {

	case float64:

		if math.IsInf(v, 0) || math.IsNaN(v) {

			return 0, false

		}

		return int64(v), true

	case string:

		parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64)

		if strings.TrimSpace(v) == "" || err != nil {

			return 0, false

		}

		return int64(parsed), true

	}

	return 0, false

}
