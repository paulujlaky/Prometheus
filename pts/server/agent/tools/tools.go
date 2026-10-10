package tools

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"

	"boombox/agent/browser"
	"boombox/agent/protocol"
	"boombox/agent/shell"
)

// reading through the shell loses the line numbers the next <edit> leans on
var readers = regexp.MustCompile(`^\s*(grep|rg|cat|head|tail|less|more|ls|tree|find)\b`)

// fileTarget is a write's or an edit's file and content; a model that put the file on the body's first line instead of the tag still means it.
func fileTarget(action protocol.Action) (string, string) {

	if action.Path != "" {

		return action.Path, action.Body

	}

	first, rest, _ := strings.Cut(action.Body, "\n")

	if protocol.FilePath.MatchString(strings.TrimSpace(first)) {

		return strings.TrimSpace(first), rest

	}

	return action.Path, action.Body

}

func bodyLines(body string) []string {

	lines := []string{}

	for _, line := range strings.Split(body, "\n") {

		if line = strings.TrimSpace(line); line != "" {

			lines = append(lines, line)

		}

	}

	return lines

}

// Execute runs every verb except the ones the loop owns; failures come back as failed results, never errors.
func Execute(ctx context.Context, action protocol.Action, cwd, zone string) protocol.Result {

	outcome := func(text string, err error) protocol.Result {

		if err != nil {

			return protocol.Result{Verb: action.Verb, OK: false, Text: err.Error()}

		}

		return protocol.Result{Verb: action.Verb, OK: true, Text: text}

	}

	target := action.Path

	if target == "" {

		if lines := bodyLines(action.Body); len(lines) > 0 {

			target = lines[0]

		}

	}

	// in the workspace's lane, so no command of the agent's can move a path between the check and the use
	files := func(work func() (string, error)) protocol.Result {

		return outcome(shell.InLane(ctx, cwd, work))

	}

	switch action.Verb {

	case "ls":

		return files(func() (string, error) {

			if target == "" {

				target = "."

			}

			return ListDir(cwd, target)

		})

	case "read":

		return files(func() (string, error) {

			lines := bodyLines(action.Body)

			if len(lines) == 0 && action.Path != "" {

				lines = []string{action.Path}

			}

			specs := make([]ReadSpec, len(lines))

			for i, line := range lines {

				specs[i] = ParseReadSpec(line)

			}

			return ReadFiles(cwd, specs)

		})

	case "grep":

		return files(func() (string, error) { return Grep(cwd, bodyLines(action.Body), action.Path) })

	case "write":

		path, body := fileTarget(action)

		return files(func() (string, error) { return WriteFile(cwd, path, body) })

	case "delete":

		return files(func() (string, error) {

			targets := bodyLines(action.Body)

			if action.Path != "" {

				targets = []string{action.Path}

			}

			return DeleteFiles(cwd, targets)

		})

	case "edit":

		path, body := fileTarget(action)
		result, err := shell.InLane(ctx, cwd, func() (protocol.Result, error) { return ApplyEdit(cwd, path, body), nil })

		if err != nil {

			return outcome("", err)

		}

		return result

	case "run":

		command := strings.TrimSpace(action.Body)

		if command == "" {

			return outcome("", errors.New("run needs a command"))

		}

		if readers.MatchString(command) {

			return outcome("", errors.New("Use <ls>, <read> or <grep> to look at files — they give line numbers. <run> is for everything else."))

		}

		ran := shell.Run(ctx, command, cwd, 0, zone)
		output := ran.Output

		if output == "" {

			output = "(no output)"

		}

		return protocol.Result{Verb: "run", OK: ran.ExitCode == 0, Text: "exit " + strconv.Itoa(ran.ExitCode) + "\n\n" + output}

	case "open":

		return outcome(browser.Open(ctx, cwd, target))

	case "look":

		return outcome(browser.Look(ctx, cwd))

	case "click":

		return outcome(browser.Click(ctx, cwd, target))

	case "type":

		return outcome(browser.Type(ctx, cwd, action.Path, action.Body))

	case "press":

		return outcome(browser.Press(ctx, cwd, target))

	case "tab":

		return outcome(browser.Tab(ctx, cwd, target))

	}

	return outcome("", errors.New(string(action.Verb)+" is handled by the loop"))

}
