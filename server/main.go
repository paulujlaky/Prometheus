// Command pts runs the Prometheus server, hands out sign-in keys, and drives agents from a terminal.
package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"boombox/agent"
	"boombox/agent/browser"
	"boombox/config"
	"boombox/server"
	"boombox/store"
	"boombox/sdk"
)

const usage = `usage:
  pts serve                    run the server
  pts key <user>               make the user, or give them a new key; the old one stops working
  pts remove <user>            delete the user and everything of theirs but their files
  pts list                     users and their agents
  pts models <user>
  pts new <user> <name> <modelId> [persona...]
  pts send <user> <name> <task...>
  pts log <user> <name>`

func main() {

	log.SetFlags(0)

	if err := run(os.Args[1:]); err != nil {

		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)

	}

}

func run(args []string) error {

	if len(args) == 0 {

		fmt.Println(usage)

		return nil

	}

	command, rest := args[0], args[1:]

	st, err := store.OpenDefault()

	if err != nil {

		return err

	}

	defer st.Close()

	switch command {

	case "serve":

		return serve(st)

	case "key":

		if len(rest) == 0 {

			return errors.New(usage)

		}

		key, err := st.IssueKey(rest[0])

		if err != nil {

			return err

		}

		fmt.Printf("%s signs in with this key. It is shown once; run this again for a new one.\n\n  %s\n\n", rest[0], key)

	case "remove":

		user, err := userNamed(st, rest)

		if err != nil {

			return err

		}

		if err := st.DeleteUser(user.ID); err != nil {

			return err

		}

		fmt.Printf("removed %s. Their workspaces are still in %s, and their Prometheus bots in their Boodle account.\n", user.Name, st.UserDir(user.ID))

	case "list":

		fmt.Printf("home: %s\n", st.Home)

		users, err := st.ListUsers()

		if err != nil {

			return err

		}

		for _, user := range users {

			note := ""

			if user.Cookie == "" {

				note = "  (Boodle not connected)"

			}

			fmt.Printf("\n%s%s\n", user.Name, note)

			agents, _ := st.ListAgents(user.ID)

			for _, one := range agents {

				bot := ""

				if one.BotAssistantID != "" {

					bot = "  bot " + one.BotAssistantID

				}

				fmt.Printf("  %s  model %s%s\n", one.Name, one.ModelID, bot)

			}

		}

	case "models":

		user, err := userNamed(st, rest)

		if err != nil {

			return err

		}

		client, err := clientOf(user)

		if err != nil {

			return err

		}

		models, err := client.ListCustomModels(context.Background())

		if err != nil {

			return err

		}

		for _, model := range models {

			fmt.Printf("%s  %s\n", model.ID, model.Name)

		}

	case "new":

		if len(rest) < 3 {

			return errors.New(usage)

		}

		user, err := userNamed(st, rest)

		if err != nil {

			return err

		}

		created, err := st.CreateAgent(user.ID, rest[1], rest[2], strings.Join(rest[3:], " "))

		if err != nil {

			return err

		}

		fmt.Printf("created %s → %s\n", created.Name, st.Workspace(created))

	case "send":

		return send(st, rest)

	case "log":

		user, err := userNamed(st, rest)

		if err != nil {

			return err

		}

		found, err := agentNamed(st, user, rest[1:])

		if err != nil {

			return err

		}

		events, err := st.ListEvents(found.ID, 200, store.Newest)

		if err != nil {

			return err

		}

		for _, event := range events {

			fmt.Printf("── %s  %s ──\n%s\n\n", event.Kind, time.UnixMilli(event.At).UTC().Format("2006-01-02T15:04:05.000Z"), event.Text)

		}

	default:

		fmt.Println(usage)

	}

	return nil

}

func userNamed(st *store.Store, args []string) (*store.User, error) {

	name := "(none)"

	if len(args) > 0 {

		name = args[0]

	}

	user, err := st.GetUser(name)

	if err != nil {

		return nil, fmt.Errorf("No user named %s. Try: pts list", name)

	}

	return user, nil

}

func agentNamed(st *store.Store, user *store.User, args []string) (*store.Agent, error) {

	name := "(none)"

	if len(args) > 0 {

		name = args[0]

	}

	found, err := st.GetAgent(user.ID, name)

	if err != nil {

		return nil, fmt.Errorf("%s has no agent named %s. Try: pts list", user.Name, name)

	}

	return found, nil

}

func clientOf(user *store.User) (*sdk.Client, error) {

	if user.Cookie == "" {

		return nil, fmt.Errorf("%s has not connected Boodle yet; they paste their cookie in the app", user.Name)

	}

	return sdk.NewClient(sdk.ClientOptions{Cookie: user.Cookie})

}

// webDir is the built PWA: PTS_WEB, else web/dist found from the working directory or the binary.
func webDir() string {

	if dir := os.Getenv("PTS_WEB"); dir != "" {

		return dir

	}

	// run from the repository root, or from server
	candidates := []string{filepath.Join("web", "dist"), filepath.Join("..", "web", "dist")}

	// the binary is server/bin/pts, two folders below the repository that holds web
	if exe, err := os.Executable(); err == nil {

		candidates = append(candidates, filepath.Join(filepath.Dir(exe), "..", "..", "web", "dist"))

	}

	for _, dir := range candidates {

		if _, err := os.Stat(filepath.Join(dir, "index.html")); err == nil {

			return dir

		}

	}

	return candidates[0]

}

func serve(st *store.Store) error {

	srv, err := server.New(st, webDir())

	if err != nil {

		return err

	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// a failure stops the server rather than let a browser start without the proxy
	if err := srv.Start(ctx); err != nil {

		return fmt.Errorf("pts: %w", err)

	}

	// a proxy in front terminates TLS; nothing else should reach the server directly
	address := net.JoinHostPort(config.String("PTS_HOST", "127.0.0.1"), config.String("PTS_PORT", "7420"))
	httpServer := &http.Server{Addr: address, Handler: srv}
	failed := make(chan error, 1)

	go func() {

		log.Printf("pts listening on http://%s", address)
		failed <- httpServer.ListenAndServe()

	}()

	select {

	case err := <-failed:

		return err

	case <-ctx.Done():

	}

	// closing the browser writes each agent's logins to its workspace; a hard kill would lose the latest
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	httpServer.Shutdown(shutdown)
	browser.CloseAll()

	return nil

}

func send(st *store.Store, args []string) error {

	user, err := userNamed(st, args)

	if err != nil {

		return err

	}

	found, err := agentNamed(st, user, args[1:])

	if err != nil {

		return err

	}

	if len(args) < 3 {

		return errors.New(usage)

	}

	client, err := clientOf(user)

	if err != nil {

		return err

	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	if err := browser.SetProxy(config.Proxy()); err != nil {

		return err

	}

	if err := browser.SetZone(st.UserDir(user.ID), st.ReadSetting(user.ID, "timezone")); err != nil {

		return err

	}

	// the browser keeps Chromium running until its contexts close
	defer browser.CloseAll()

	input := bufio.NewReader(os.Stdin)

	listen := func(event agent.RunEvent) {

		if event.Delta {

			fmt.Print(event.Text)

			return

		}

		if event.Event.Kind == store.KindAssistant {

			fmt.Println()

			return

		}

		fmt.Printf("\n── %s ──\n%s\n\n", event.Event.Kind, event.Event.Text)

	}

	ask := func(question string, kind agent.WaitKind) agent.Reply {

		if kind == agent.WaitQuestion {

			fmt.Printf("\n%s\n>", question)

		} else {

			fmt.Printf("\n%s\nAllow? [y/N] ", question)

		}

		line, err := input.ReadString('\n')

		if err != nil {

			return agent.Allow(false)

		}

		line = strings.TrimSpace(line)

		if kind == agent.WaitQuestion {

			return agent.Answer(line)

		}

		return agent.Allow(strings.EqualFold(line, "y") || strings.EqualFold(line, "yes"))

	}

	control := agent.RunControl{Ctx: ctx, TakeNotes: func() []string { return nil }, Ask: ask, Listen: listen}

	agent.RunAgent(st, client, *found, strings.Join(args[2:], " "), control)

	return nil

}
