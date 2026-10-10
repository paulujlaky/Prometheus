// Package tools carries out an agent's blocks inside its workspace.
package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"boombox/agent/shell"
)

const (
	maxRead = 120_000
	maxGrepFile = 400_000
	maxWalk = 8000
	grepPerFile = 6
	grepMax = 120
)

var skip = map[string]bool{"node_modules": true, ".git": true, ".venv": true, "venv": true, "__pycache__": true}

func abs(cwd, rel string) string {

	if rel == "." {

		return cwd

	}

	return filepath.Join(cwd, filepath.FromSlash(rel))

}

func isBinary(text string) bool {

	if len(text) > 4000 {

		text = text[:4000]

	}

	return strings.ContainsRune(text, 0)

}

func readText(path string) (string, error) {

	text, err := shell.ReadRegular(path, true)

	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), err

}

func plural(n int, one, many string) string {

	if n == 1 {

		return "1 " + one

	}

	return strconv.Itoa(n) + " " + many

}

// splitLines treats a trailing newline as a terminator, not an extra line; counting it makes every number look wrong.
func splitLines(text string) []string {

	return strings.Split(strings.TrimSuffix(text, "\n"), "\n")

}

// RelPath normalises anything the model hands over to a workspace-relative path; escaping the workspace is an error.
func RelPath(raw, cwd string) (string, error) {

	root, err := filepath.Abs(cwd)

	if err != nil {

		return "", err

	}

	slashed := filepath.ToSlash(root)
	cleaned := strings.ReplaceAll(trimQuotes(strings.TrimSpace(raw)), `\`, "/")

	if cleaned == slashed {

		return ".", nil

	}

	cleaned = strings.TrimPrefix(cleaned, slashed+"/")
	cleaned = strings.TrimLeft(strings.TrimPrefix(cleaned, "./"), "/")

	if cleaned == "" {

		cleaned = "."

	}

	rel, err := filepath.Rel(root, filepath.Join(root, filepath.FromSlash(cleaned)))

	if err != nil || strings.HasPrefix(rel, "..") {

		return "", fmt.Errorf("%s is outside your workspace", raw)

	}

	return filepath.ToSlash(rel), nil

}

func trimQuotes(text string) string {

	if text != "" && strings.ContainsRune("\"'`", rune(text[0])) {

		text = text[1:]

	}

	if text != "" && strings.ContainsRune("\"'`", rune(text[len(text)-1])) {

		text = text[:len(text)-1]

	}

	return text

}

// inside is rel as an absolute path once its real location is checked: the agent's shell can point a link anywhere on the host.
func inside(cwd, rel string) (string, error) {

	root, err := filepath.EvalSymlinks(cwd)

	if err != nil {

		return "", err

	}

	root, _ = filepath.Abs(root)
	path := abs(cwd, rel)
	head := path

	// what does not exist yet cannot be a link; the deepest part that does decides where the path really goes
	for {

		if _, err := os.Lstat(head); err == nil || filepath.Dir(head) == head {

			break

		}

		head = filepath.Dir(head)

	}

	// a dangling link is refused like one that leads out
	real, err := filepath.EvalSymlinks(head)

	if err == nil {

		real, _ = filepath.Abs(real)

	}

	if err != nil || (real != root && !strings.HasPrefix(real, root+string(filepath.Separator))) {

		return "", fmt.Errorf("%s leads outside your workspace", rel)

	}

	return path, nil

}

type child struct {

	name string
	dir bool
	link bool

}

// children lists a folder; links are listed but never followed, since one may point anywhere on the host.
func children(path string) ([]child, error) {

	entries, err := os.ReadDir(path)

	if err != nil {

		return nil, err

	}

	kids := []child{}

	for _, entry := range entries {

		name := entry.Name()

		if skip[name] || strings.HasPrefix(name, ".") {

			continue

		}

		stat, err := os.Lstat(filepath.Join(path, name))

		if err != nil {

			continue

		}

		kids = append(kids, child{name: name, dir: stat.IsDir(), link: stat.Mode()&os.ModeSymlink != 0})

	}

	sort.SliceStable(kids, func(i, j int) bool {

		if kids[i].dir != kids[j].dir {

			return kids[i].dir

		}

		a, b := strings.ToLower(kids[i].name), strings.ToLower(kids[j].name)

		if a != b {

			return a < b

		}

		return kids[i].name < kids[j].name

	})

	return kids, nil

}

func walkFiles(cwd, rel string, out *[]string) {

	kids, _ := children(abs(cwd, rel))

	for _, kid := range kids {

		path := kid.name

		if rel != "." {

			path = rel + "/" + kid.name

		}

		if len(*out) >= maxWalk {

			return

		}

		if kid.dir && !kid.link {

			walkFiles(cwd, path, out)

		} else if !kid.link {

			*out = append(*out, path)

		}

	}

}

func ListDir(cwd, target string) (string, error) {

	if target == "" {

		target = "."

	}

	rel, err := RelPath(target, cwd)

	if err != nil {

		return "", err

	}

	path, err := inside(cwd, rel)

	if err != nil {

		return "", err

	}

	stat, err := os.Stat(path)

	if err != nil {

		return "", fmt.Errorf("%s does not exist", rel)

	}

	if !stat.IsDir() {

		return ReadFiles(cwd, []ReadSpec{{Path: rel}})

	}

	kids, err := children(path)

	if err != nil {

		return "", err

	}

	lines := []string{}

	for _, kid := range kids {

		childRel := kid.name

		if rel != "." {

			childRel = rel + "/" + kid.name

		}

		switch {

		case kid.link:

			lines = append(lines, "  "+kid.name+"  link")

		case kid.dir:

			files := []string{}

			walkFiles(cwd, childRel, &files)
			lines = append(lines, fmt.Sprintf("  %s/  %d files", kid.name, len(files)))

		default:

			text, err := readText(filepath.Join(cwd, filepath.FromSlash(childRel)))

			switch {

			case err != nil:

				lines = append(lines, "  "+kid.name)

			case isBinary(text):

				lines = append(lines, "  "+kid.name+"  binary")

			default:

				lines = append(lines, fmt.Sprintf("  %s  %d lines", kid.name, len(splitLines(text))))

			}

		}

	}

	head := rel + "/"

	if rel == "." {

		head = "."

	}

	if len(lines) == 0 {

		return head + "  empty", nil

	}

	return head + "\n" + strings.Join(lines, "\n"), nil

}

type ReadSpec struct {

	Path string

	Start int
	End int

}

var readRange = regexp.MustCompile(`^(.*?)[\s:]+(\d+)\s*(?:[-–:]\s*(\d+))?$`)

// ParseReadSpec reads "notes.md 40-120", "notes.md:40-120" and "notes.md:40" alike.
func ParseReadSpec(line string) ReadSpec {

	raw := trimQuotes(strings.TrimSpace(line))
	match := readRange.FindStringSubmatch(raw)

	if match == nil {

		return ReadSpec{Path: raw}

	}

	start, _ := strconv.Atoi(match[2])

	if match[3] != "" {

		end, _ := strconv.Atoi(match[3])

		return ReadSpec{Path: strings.TrimSpace(match[1]), Start: start, End: end}

	}

	// a bare line number is usually a grep hit pasted back; show its neighbourhood
	return ReadSpec{Path: strings.TrimSpace(match[1]), Start: max(1, start-25), End: start + 55}

}

func numbered(lines []string, start int) string {

	width := len(strconv.Itoa(start + len(lines) - 1))
	out := make([]string, len(lines))

	for i, line := range lines {

		out[i] = fmt.Sprintf("%*d  %s", width, start+i, line)

	}

	return strings.Join(out, "\n")

}

func readOne(cwd string, spec ReadSpec, budget int) (string, error) {

	rel, err := RelPath(spec.Path, cwd)

	if err != nil {

		return "", err

	}

	path, err := inside(cwd, rel)

	if err != nil {

		return "", err

	}

	stat, err := os.Stat(path)

	if err != nil {

		return rel + "  no such file", nil

	}

	if stat.IsDir() {

		return ListDir(cwd, rel)

	}

	text, err := readText(path)

	if err != nil {

		return "", err

	}

	if isBinary(text) {

		return rel + "  binary file", nil

	}

	if strings.TrimSpace(text) == "" {

		return rel + "  empty file", nil

	}

	all := splitLines(text)
	start := spec.Start

	if start == 0 {

		start = 1

	}

	start = max(1, min(start, len(all)))
	end := len(all)

	if spec.End != 0 {

		end = min(len(all), spec.End)

	}

	if end < start {

		end = start - 1

	}

	body := numbered(all[start-1:end], start)
	shown := end

	if len(body) > budget {

		kept := strings.Split(body[:budget], "\n")
		kept = kept[:len(kept)-1]
		shown = start + len(kept) - 1
		body = strings.Join(kept, "\n")

	}

	header := fmt.Sprintf("%s  lines %d-%d of %d", rel, start, shown, len(all))

	if start == 1 && shown == len(all) {

		header = fmt.Sprintf("%s  %d lines", rel, len(all))

	}

	more := ""

	if shown < end {

		more = fmt.Sprintf("\n\n... read %s %d-%d for the rest", rel, shown+1, end)

	}

	return header + "\n\n" + strings.ToValidUTF8(body, "") + more, nil

}

func ReadFiles(cwd string, specs []ReadSpec) (string, error) {

	if len(specs) == 0 {

		return "", errors.New("read needs at least one path")

	}

	parts := make([]string, 0, len(specs))

	for _, spec := range specs {

		part, err := readOne(cwd, spec, maxRead/len(specs))

		if err != nil {

			return "", err

		}

		parts = append(parts, part)

	}

	return strings.Join(parts, "\n\n"), nil

}

var regexPattern = regexp.MustCompile(`^/(.+)/[gimsu]*$`)

// toMatcher treats /pattern/ as a regex and anything else as literal; several patterns match as alternatives.
func toMatcher(patterns []string) (*regexp.Regexp, error) {

	parts := make([]string, len(patterns))

	for i, pattern := range patterns {

		if match := regexPattern.FindStringSubmatch(pattern); match != nil {

			if _, err := regexp.Compile(match[1]); err != nil {

				return nil, fmt.Errorf("%s is not a pattern grep understands: %v", pattern, err)

			}

			parts[i] = match[1]

		} else {

			parts[i] = regexp.QuoteMeta(pattern)

		}

	}

	return regexp.Compile(strings.Join(parts, "|"))

}

// Grep groups hits by file, so paths never blur into line numbers the way path:12: does.
func Grep(cwd string, patterns []string, where string) (string, error) {

	if len(patterns) == 0 {

		return "", errors.New("grep needs a pattern")

	}

	if where == "" {

		where = "."

	}

	root, err := RelPath(where, cwd)

	if err != nil {

		return "", err

	}

	path, err := inside(cwd, root)

	if err != nil {

		return "", err

	}

	stat, err := os.Stat(path)

	if err != nil {

		return "", fmt.Errorf("%s does not exist", root)

	}

	matcher, err := toMatcher(patterns)

	if err != nil {

		return "", err

	}

	files := []string{}

	if stat.IsDir() {

		walkFiles(cwd, root, &files)

	} else {

		files = append(files, root)

	}

	groups := []string{}
	hits := 0
	shown := 0

	for _, file := range files {

		if shown >= grepMax {

			break

		}

		text, _ := readText(filepath.Join(cwd, filepath.FromSlash(file)))

		if isBinary(text) || len(text) > maxGrepFile {

			continue

		}

		found := []string{}

		for i, line := range strings.Split(text, "\n") {

			if matcher.MatchString(line) {

				found = append(found, fmt.Sprintf("  %5d  %s", i+1, clipRunes(strings.TrimSpace(line), 200)))

			}

		}

		if len(found) == 0 {

			continue

		}

		hits += len(found)
		shown += min(len(found), grepPerFile)

		head := file

		if len(found) > grepPerFile {

			head += fmt.Sprintf("  (%d matches, first %d)", len(found), grepPerFile)

		}

		groups = append(groups, head+"\n"+strings.Join(found[:min(len(found), grepPerFile)], "\n"))

	}

	if len(groups) == 0 {

		where := ""

		if root != "." {

			where = " in " + root

		}

		return "no matches for " + strings.Join(patterns, " or ") + where, nil

	}

	return plural(hits, "match", "matches") + " in " + plural(len(groups), "file", "files") + "\n\n" + strings.Join(groups, "\n\n"), nil

}

func clipRunes(text string, limit int) string {

	if utf8.RuneCountInString(text) <= limit {

		return text

	}

	return string([]rune(text)[:limit])

}

func WriteFile(cwd, target, content string) (string, error) {

	rel, err := RelPath(target, cwd)

	if err != nil {

		return "", err

	}

	if rel == "." {

		return "", errors.New("write needs its file on the tag, with the content below it:\n\n  <write notes/plan.md>\n  ...\n  </write>")

	}

	path, err := inside(cwd, rel)

	if err != nil {

		return "", err

	}

	_, statErr := os.Stat(path)
	body := content

	if !strings.HasSuffix(body, "\n") {

		body += "\n"

	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {

		return "", err

	}

	if err := shell.WriteRegular(path, body); err != nil {

		return "", err

	}

	verb := "created"

	if statErr == nil {

		verb = "replaced"

	}

	return fmt.Sprintf("%s %s  %d lines", verb, rel, len(splitLines(body))), nil

}

func DeleteFiles(cwd string, targets []string) (string, error) {

	if len(targets) == 0 {

		return "", errors.New("delete needs a path")

	}

	lines := []string{}

	for _, target := range targets {

		rel, err := RelPath(target, cwd)

		if err != nil {

			return "", err

		}

		if rel == "." {

			return "", errors.New("refusing to delete your workspace")

		}

		if rel == "MEMORY.md" {

			return "", errors.New("refusing to delete MEMORY.md")

		}

		// only the folder it sits in has to be inside: removing a link removes the link, not what it points at
		if _, err := inside(cwd, filepath.ToSlash(filepath.Dir(filepath.FromSlash(rel)))); err != nil {

			return "", err

		}

		if _, err := os.Lstat(abs(cwd, rel)); err != nil {

			lines = append(lines, rel+"  already gone")

			continue

		}

		if err := os.RemoveAll(abs(cwd, rel)); err != nil {

			return "", err

		}

		lines = append(lines, "deleted "+rel)

	}

	return strings.Join(lines, "\n"), nil

}
