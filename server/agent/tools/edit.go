package tools

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"boombox/agent/protocol"
	"boombox/agent/shell"
)

type compare func(a, b string) bool

type looseMatch struct {

	same compare
	how string

}

var loose = []looseMatch{

	{same: func(a, b string) bool { return strings.TrimRight(a, " \t\r\n") == strings.TrimRight(b, " \t\r\n") }, how: "ignoring trailing space"},
	{same: func(a, b string) bool { return strings.TrimSpace(a) == strings.TrimSpace(b) }, how: "ignoring indentation"},

}

var (
	indent = regexp.MustCompile(`^[ \t]*`)
	gutter = regexp.MustCompile(`^\s*\d+\s{2}`)
)

func indentOf(line string) string {

	return indent.FindString(line)

}

func lineOf(text string, offset int) int {

	return strings.Count(text[:offset], "\n") + 1

}

// stripGutter drops the line numbers a copied FIND often carries from a read, when every line has one.
func stripGutter(text string) string {

	lines := strings.Split(text, "\n")

	if len(lines) < 2 {

		return text

	}

	for _, line := range lines {

		if strings.TrimSpace(line) != "" && !gutter.MatchString(line) {

			return text

		}

	}

	for i, line := range lines {

		lines[i] = gutter.ReplaceAllString(line, "")

	}

	return strings.Join(lines, "\n")

}

func lineMatches(lines, needle []string, same compare) []int {

	hits := []int{}

	for i := 0; i+len(needle) <= len(lines); i++ {

		matched := true

		for j, line := range needle {

			if !same(lines[i+j], line) {

				matched = false

				break

			}

		}

		if matched {

			hits = append(hits, i)

		}

	}

	return hits

}

// reindent moves the replacement by however far the real file sits from what the model typed.
func reindent(replace []string, from, to string) []string {

	if from == to {

		return replace

	}

	out := make([]string, len(replace))

	for i, line := range replace {

		switch {

		case strings.TrimSpace(line) == "":

			out[i] = line

		case strings.HasPrefix(line, from):

			out[i] = to + line[len(from):]

		default:

			out[i] = to + strings.TrimLeft(line, " \t")

		}

	}

	return out

}

func occurrences(text, needle string) []int {

	at := []int{}

	for i := strings.Index(text, needle); i != -1; {

		at = append(at, i)

		next := strings.Index(text[i+len(needle):], needle)

		if next == -1 {

			break

		}

		i += len(needle) + next

	}

	return at

}

// similarity scores an exact line 2 and a near miss (stale value, renamed word) 1.
func similarity(a, b string) int {

	x := strings.TrimSpace(a)
	y := strings.TrimSpace(b)

	if x == "" || y == "" {

		return 0

	}

	if x == y {

		return 2

	}

	shared := 0

	for shared < len(x) && shared < len(y) && x[shared] == y[shared] {

		shared++

	}

	if float64(shared)/float64(max(len(x), len(y))) >= 0.5 {

		return 1

	}

	return 0

}

// nearest shows the window that looks most like FIND, so a stale edit is fixed in one turn instead of three.
func nearest(lines, needle []string) string {

	best := -1
	bestScore := 0

	for i := range lines {

		score := 0

		for j, line := range needle {

			if i+j < len(lines) {

				score += similarity(lines[i+j], line)

			}

		}

		if score > bestScore {

			bestScore = score
			best = i

		}

	}

	if best == -1 {

		return "\n\nRead the file again — it does not look the way you expected."

	}

	from := max(0, best-2)
	to := min(len(lines), best+len(needle)+2)

	return "\n\nClosest match in the file:\n\n" + numbered(lines[from:to], from+1)

}

// preview shows three lines either side of the change, so the model can see it landed without another read.
func preview(text string, line int) string {

	lines := strings.Split(text, "\n")
	from := max(0, line-4)
	to := min(len(lines), line+4)

	return numbered(lines[from:to], from+1)

}

// ApplyEdit applies every pair or none: a failure leaves the file untouched and says so, so the model never edits around half an edit.
func ApplyEdit(cwd, target, body string) protocol.Result {

	fail := func(text string) protocol.Result { return protocol.Result{Verb: "edit", OK: false, Text: text} }

	rel, err := RelPath(target, cwd)

	if err != nil {

		return fail(err.Error())

	}

	if rel == "." {

		return fail("edit needs its file on the tag:\n\n  <edit notes/plan.md>\n  @@ FIND\n  ...\n  </edit>")

	}

	path, err := inside(cwd, rel)

	if err != nil {

		return fail(err.Error())

	}

	if _, err := os.Stat(path); err != nil {

		return fail(fmt.Sprintf("%s does not exist. Use <write %s> to create it.", rel, rel))

	}

	pairs := protocol.ParsePairs(body)

	if len(pairs) == 0 {

		// the agent's own file in the example, since a model copies the example it is shown
		return fail("No @@ FIND / @@ REPLACE pair in that block. The file goes on the tag and the pairs inside the block. To add text, FIND the line it goes after and REPLACE it with that line plus the new text.\n\n  <edit " + rel + ">\n  @@ FIND\n  old text\n  @@ REPLACE\n  new text\n  </edit>")

	}

	raw, err := shell.ReadRegular(path, true)

	if err != nil {

		return fail(err.Error())

	}

	original := strings.ReplaceAll(raw, "\r\n", "\n")

	rolledBack := func(text string) protocol.Result {

		applied := "Nothing was applied"

		if len(pairs) > 1 {

			applied = "No pairs were applied"

		}

		return fail(fmt.Sprintf("%s\n\n%s — %s is unchanged. Fix it and send the whole block again.", text, applied, rel))

	}

	ambiguous := func(label string, lines []int) protocol.Result {

		shown := make([]string, 0, 6)

		for _, line := range lines[:min(len(lines), 6)] {

			shown = append(shown, fmt.Sprint(line))

		}

		return rolledBack(fmt.Sprintf("%sFIND matches %d places in %s (lines %s). Include more surrounding lines so it is unique.", label, len(lines), rel, strings.Join(shown, ", ")))

	}

	text := original
	notes := []string{}
	previews := []string{}

pairs:
	for index, pair := range pairs {

		find := stripGutter(pair.Find)
		label := ""

		if len(pairs) > 1 {

			label = fmt.Sprintf("pair %d of %d: ", index+1, len(pairs))

		}

		if strings.TrimSpace(find) == "" {

			return rolledBack(label + "FIND is empty. Copy the exact lines you want to change.")

		}

		exact := occurrences(text, find)

		if len(exact) > 1 {

			lines := make([]int, len(exact))

			for i, at := range exact {

				lines[i] = lineOf(text, at)

			}

			return ambiguous(label, lines)

		}

		if len(exact) == 1 {

			text = text[:exact[0]] + pair.Replace + text[exact[0]+len(find):]
			previews = append(previews, preview(text, lineOf(text, exact[0])))

			continue

		}

		lines := strings.Split(text, "\n")
		needle := strings.Split(find, "\n")

		for _, match := range loose {

			hits := lineMatches(lines, needle, match.same)

			if len(hits) > 1 {

				numbers := make([]int, len(hits))

				for i, hit := range hits {

					numbers[i] = hit + 1

				}

				return ambiguous(label, numbers)

			}

			if len(hits) == 1 {

				replaced := reindent(strings.Split(pair.Replace, "\n"), indentOf(needle[0]), indentOf(lines[hits[0]]))
				spliced := append(append(append([]string{}, lines[:hits[0]]...), replaced...), lines[hits[0]+len(needle):]...)

				text = strings.Join(spliced, "\n")
				notes = append(notes, label+"matched "+match.how)
				previews = append(previews, preview(text, hits[0]+1))

				continue pairs

			}

		}

		if strings.TrimSpace(pair.Replace) != "" && strings.Contains(text, pair.Replace) {

			notes = append(notes, label+"already applied, left alone")

			continue

		}

		// numbered against the file on disk, since nothing earlier in this block was written
		return rolledBack(fmt.Sprintf("%sFIND is not in %s.%s", label, rel, nearest(strings.Split(original, "\n"), needle)))

	}

	if strings.Contains(raw, "\r\n") {

		text = strings.ReplaceAll(text, "\n", "\r\n")

	}

	if err := shell.WriteRegular(path, text); err != nil {

		return fail(err.Error())

	}

	head := "edited " + rel

	if len(notes) > 0 {

		head += "  (" + strings.Join(notes, "; ") + ")"

	}

	return protocol.Result{Verb: "edit", OK: true, Text: strings.Join(append([]string{head}, previews...), "\n\n")}

}
