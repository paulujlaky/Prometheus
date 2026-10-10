// Package protocol is how agents talk to the harness: tagged blocks in, tagged results out, so nothing ever needs escaping.
package protocol

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

type Verb string

var Verbs = []Verb{"ls", "read", "grep", "edit", "write", "delete", "run", "open", "look", "click", "type", "press", "tab", "submit", "handoff", "ask", "routine", "say", "notify", "done"}

// models reach for whatever verb their training favours; accepting the synonym costs nothing
var aliases = map[string]Verb{

	"list": "ls",
	"dir": "ls",

	"cat": "read",
	"view": "read",

	"search": "grep",
	"find": "grep",
	"rg": "grep",

	"patch": "edit",
	"replace": "edit",
	"str_replace": "edit",

	"create": "write",
	"file": "write",

	"rm": "delete",
	"remove": "delete",

	"bash": "run",
	"sh": "run",
	"shell": "run",
	"exec": "run",
	"command": "run",

	"goto": "open",
	"visit": "open",
	"navigate": "open",
	"browse": "open",

	"snapshot": "look",
	"page": "look",

	"fill": "type",
	"input": "type",

	"key": "press",

	"tabs": "tab",

	"handover": "handoff",
	"human": "handoff",

	"question": "ask",
	"choose": "ask",

	"routines": "routine",
	"schedule": "routine",
	"remind": "routine",
	"cron": "routine",
	"watch": "routine",

	"message": "say",
	"tell": "say",

	"alert": "notify",
	"ping": "notify",
	"push": "notify",

	"finish": "done",
	"complete": "done",

}

// AsVerb names the verb for a tag, or "" when the tag is not one.
func AsVerb(name string) Verb {

	lower := strings.ToLower(name)

	for _, verb := range Verbs {

		if string(verb) == lower {

			return verb

		}

	}

	return aliases[lower]

}

type Action struct {

	Verb Verb

	// Path is the target from the open tag, <edit notes.md>; empty when the model gave none.
	Path string

	// Label is the short title line directly above the block.
	Label string

	Body string

	// Start and End are where the whole block sits in the reply, tags included.
	Start int
	End int

}

type Result struct {

	Verb Verb
	OK bool
	Text string

}

const labelMax = 90

var (
	openTag = regexp.MustCompile(`<([A-Za-z_][A-Za-z0-9_]*)([^>\n]*)>`)
	attrName = regexp.MustCompile(`(?i)^(?:path|file|filename|target)\s*=\s*`)
	trailingFence = regexp.MustCompile("(?i)```[a-z]*\\s*$")
	fenceLine = regexp.MustCompile("(?im)^```[a-z]*\\s*$")
	labelBullet = regexp.MustCompile(`^[-*>#\s]+`)
	labelNumber = regexp.MustCompile(`^\d+[.)]\s+`)
	labelMarks = regexp.MustCompile("[*_`]")
	labelEnd = regexp.MustCompile(`[:.]\s*$`)
	blockStart = regexp.MustCompile(`^[ \t]*\r?\n`)
	blockEnd = regexp.MustCompile(`\r?\n[ \t]*$`)
)

// trimQuotes drops one quote of any kind from each end, so `"a.md"` and 'a.md' both name a.md.
func trimQuotes(text string) string {

	if text != "" && strings.ContainsRune("\"'`", rune(text[0])) {

		text = text[1:]

	}

	if text != "" && strings.ContainsRune("\"'`", rune(text[len(text)-1])) {

		text = text[:len(text)-1]

	}

	return text

}

func attrPath(raw string) string {

	cleaned := attrName.ReplaceAllString(strings.TrimSpace(raw), "")

	return strings.TrimSpace(strings.ReplaceAll(trimQuotes(cleaned), `\`, "/"))

}

func cleanThinking(text string) string {

	return strings.TrimSpace(fenceLine.ReplaceAllString(trailingFence.ReplaceAllString(text, ""), ""))

}

// labelOf takes the last short line before a block as its title; everything above it is thinking.
func labelOf(lead string) string {

	last := ""

	for _, line := range strings.Split(cleanThinking(lead), "\n") {

		if strings.TrimSpace(line) != "" {

			last = line

		}

	}

	last = labelBullet.ReplaceAllString(last, "")
	last = labelNumber.ReplaceAllString(last, "")
	last = labelMarks.ReplaceAllString(last, "")
	last = strings.TrimSpace(labelEnd.ReplaceAllString(last, ""))

	if utf8.RuneCountInString(last) > labelMax {

		return ""

	}

	return last

}

// trimBlock drops the newline the tags sit on and keeps everything else byte-exact.
func trimBlock(body string) string {

	return blockEnd.ReplaceAllString(blockStart.ReplaceAllString(body, ""), "")

}

// indexFold finds needle at or after from, ignoring ASCII case, without shifting offsets the way lowering the whole text can.
func indexFold(text, needle string, from int) int {

	for i := from; i+len(needle) <= len(text); i++ {

		if strings.EqualFold(text[i:i+len(needle)], needle) {

			return i

		}

	}

	return -1

}

// FilePath is a workspace file named on its own, like notes/plan.md: a word, a dot, an extension.
var FilePath = regexp.MustCompile(`^[\w.-]+(?:/[\w.-]+)*\.[A-Za-z0-9]{1,8}$`)

// verbs whose body is a line or two, never file content that could itself hold a tag
var shortBody = map[Verb]bool{"ls": true, "read": true, "grep": true, "delete": true, "open": true, "look": true, "click": true, "press": true, "tab": true}

// nextBlock is where the next block opens at the start of a line after from, or -1.
func nextBlock(text string, from int) int {

	for at := from; at < len(text); {

		match := openTag.FindStringSubmatchIndex(text[at:])

		if match == nil {

			return -1

		}

		start := at + match[0]
		lineStart := strings.TrimRight(text[:start], " \t")

		if AsVerb(text[at+match[2]:at+match[3]]) != "" && (lineStart == "" || strings.HasSuffix(lineStart, "\n")) {

			return start

		}

		at += match[1]

	}

	return -1

}

// Prose is the reply with its blocks taken out: the thinking, which the user never sees.
func Prose(text string, actions []Action) string {

	var out strings.Builder

	from := 0

	for _, action := range actions {

		out.WriteString(text[from:action.Start])
		from = action.End

	}

	out.WriteString(text[from:])

	return out.String()

}

// ParseActions reads every block in a reply; unknown tags are prose and an unclosed block runs to the end.
func ParseActions(text string) []Action {

	actions := []Action{}
	cursor := 0
	leadFrom := 0

	for cursor < len(text) {

		match := openTag.FindStringSubmatchIndex(text[cursor:])

		if match == nil {

			break

		}

		openStart := cursor + match[0]
		openEnd := cursor + match[1]
		tag := text[cursor+match[2] : cursor+match[3]]
		attrs := text[cursor+match[4] : cursor+match[5]]
		verb := AsVerb(tag)

		// "`<run>`" is the model talking about a block, not opening one
		if verb == "" || (openStart > 0 && text[openStart-1] == '`') {

			cursor = openEnd

			continue

		}

		closeAt := indexFold(text, "</"+tag+">", openEnd)
		bodyEnd := len(text)
		cursor = len(text)

		if closeAt != -1 {

			bodyEnd = closeAt
			cursor = closeAt + len(tag) + 3

		} else if next := nextBlock(text, openEnd); next != -1 && shortBody[verb] {

			// models often leave <read notes.md> unclosed; its body would otherwise swallow the blocks after it
			bodyEnd = next
			cursor = next

		}

		path := attrPath(attrs)
		body := trimBlock(text[openEnd:bodyEnd])

		// "<edit>plan.md</edit>" then the pairs and a second </edit>: the model meant one block on that file
		if second := indexFold(text, "</"+tag+">", cursor); closeAt != -1 && path == "" && (verb == "edit" || verb == "write") && FilePath.MatchString(strings.TrimSpace(body)) && second != -1 {

			if next := nextBlock(text, cursor); next == -1 || next > second {

				path = strings.TrimSpace(body)
				body = trimBlock(text[cursor:second])
				cursor = second + len(tag) + 3

			}

		}

		actions = append(actions, Action{

			Verb: verb,
			Path: path,
			Label: labelOf(text[leadFrom:openStart]),

			Body: body,

			Start: openStart,
			End: cursor,

		})

		leadFrom = cursor

	}

	return actions

}

type Pair struct {

	Find string
	Replace string

}

var (
	findMark = regexp.MustCompile(`(?i)^\s*(?:@@\s*FIND|<{5,}\s*SEARCH|@@\s*SEARCH)\s*$`)
	replaceMark = regexp.MustCompile(`(?i)^\s*(?:@@\s*REPLACE|={5,}|>{5,}\s*REPLACE)\s*$`)
	endMark = regexp.MustCompile(`(?i)^\s*(?:>{5,}\s*REPLACE|@@\s*END)\s*$`)
)

// ParsePairs reads both the @@ FIND form we document and the <<<<<<< SEARCH form models arrive knowing.
func ParsePairs(body string) []Pair {

	pairs := []Pair{}

	var find, replace []string

	inFind := false
	inReplace := false

	flush := func() {

		if inFind && inReplace {

			pairs = append(pairs, Pair{Find: strings.Join(find, "\n"), Replace: strings.Join(replace, "\n")})

		}

		find, replace = nil, nil
		inFind, inReplace = false, false

	}

	for _, line := range strings.Split(body, "\n") {

		switch {

		case findMark.MatchString(line):

			flush()
			inFind = true

		case inFind && !inReplace && replaceMark.MatchString(line):

			inReplace = true

		case inReplace && endMark.MatchString(line):

			flush()

		case inReplace:

			replace = append(replace, line)

		case inFind:

			find = append(find, line)

		}

	}

	flush()

	return pairs

}

type Question struct {

	Prompt string
	Choices []string

	// Write is the placeholder for a written answer; empty when only the choices are offered.
	Write string

}

var choice = regexp.MustCompile(`^(?:[-*•]|\d+[.)])\s+`)

// ParseQuestion reads an <ask>: the question, "- " choices and a "+ " write-in; with no choices, writing is the only answer.
func ParseQuestion(body string) Question {

	prompt := []string{}
	question := Question{Choices: []string{}}

	for _, raw := range strings.Split(body, "\n") {

		line := strings.TrimSpace(raw)

		switch {

		case choice.MatchString(line):

			question.Choices = append(question.Choices, choice.ReplaceAllString(line, ""))

		case strings.HasPrefix(line, "+"):

			question.Write = strings.TrimSpace(line[1:])

			if question.Write == "" {

				question.Write = "Something else"

			}

		case line != "" && len(question.Choices) == 0:

			prompt = append(prompt, line)

		}

	}

	question.Prompt = strings.Join(prompt, " ")

	if question.Write == "" && len(question.Choices) == 0 {

		question.Write = "Your answer"

	}

	return question

}

// FormatResults gives every result one shape: [verb ok] then the body.
func FormatResults(results []Result) string {

	parts := make([]string, 0, len(results))

	for _, result := range results {

		state := "failed"

		if result.OK {

			state = "ok"

		}

		parts = append(parts, "["+string(result.Verb)+" "+state+"]\n"+strings.TrimSpace(result.Text))

	}

	return strings.Join(parts, "\n\n")

}

// BotInstructions is the bot's system prompt; only what rarely changes lives here, because changing it means minting a new bot.
func BotInstructions(name, persona string) string {

	text := guide + "\n\n## Who you are\n\nYour name is " + name + "."

	if persona = strings.TrimSpace(persona); persona != "" {

		text += "\n\n" + persona

	}

	return text

}

type TaskContext struct {

	User string
	Memory string

	// Recent is recent tasks and how they ended, oldest first.
	Recent []string

	// Agents is the user's other agents, by name.
	Agents []string

	// Now is the time on the user's clock, with its zone.
	Now string

}

func section(title, body string) string {

	return "## " + title + "\n\n" + strings.TrimSpace(body)

}

// TaskMessage is the first message of a run: what changes between tasks, then the task; an empty section is left out.
func TaskMessage(context TaskContext, task string) string {

	parts := []string{}

	if strings.TrimSpace(context.User) != "" {

		parts = append(parts, section("About the user (USER.md)", context.User))

	}

	memory := context.Memory

	// the edit example assumes a line to FIND, which an empty file does not have
	if strings.TrimSpace(memory) == "" {

		memory = "Empty. Start it with <write MEMORY.md>."

	}

	parts = append(parts, section("Your memory (MEMORY.md)", memory))

	if len(context.Recent) > 0 {

		parts = append(parts, section("Recent tasks", strings.Join(context.Recent, "\n")))

	}

	if len(context.Agents) > 0 {

		parts = append(parts, section("Other agents", strings.Join(context.Agents, ", ")))

	}

	return strings.Join(append(parts, section("Now", context.Now), section("Task", task)), "\n\n")

}

const Nudge = "[harness]\nNothing ran: that reply had no block. End with <done> if the task is finished; otherwise send the next block."
