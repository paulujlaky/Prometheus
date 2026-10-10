package server

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"boombox/agent"
	"boombox/agent/browser"
	"boombox/features"
	"boombox/glyph"
	"boombox/store"
	"boombox/sdk"
)

var (
	agentPath = regexp.MustCompile(`^/api/agents/(\d+)(?:/(\w+))?$`)
	routinePath = regexp.MustCompile(`^/api/routines/(\d+)(/run)?$`)

	// never 0: Everyone cannot be deleted
	groupPath = regexp.MustCompile(`^/api/groups/([1-9]\d*)$`)
)

func (s *Server) login(w http.ResponseWriter, r *http.Request) error {

	body, err := readBody(r)

	if err != nil {

		return err

	}

	key, _ := body["key"].(string)
	key = strings.TrimSpace(key)

	if _, err := s.st.UserByKey(key); key == "" || err != nil {

		// one guess a second keeps a long random key out of brute-force reach
		time.Sleep(time.Second)

		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "That key did not work"})

		return nil

	}

	setSession(w, key, 31536000)

	return ok(w)

}

func (s *Server) api(w http.ResponseWriter, r *http.Request) error {

	path := r.URL.Path
	route := r.Method + " " + path

	if route == "POST /api/login" {

		return s.login(w, r)

	}

	user := s.userOf(r)

	if user == nil {

		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "Unauthorized"})

		return nil

	}

	userID := user.ID
	ctx := r.Context()

	if path == "/api/ws" {

		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {

			return failWith(400, "Expected a WebSocket upgrade")

		}

		s.serveSocket(w, r, userID)

		return nil

	}

	if match := agentPath.FindStringSubmatch(path); match != nil {

		id, _ := strconv.ParseInt(match[1], 10, 64)
		found, err := s.agentOr404(userID, id)

		if err != nil {

			return err

		}

		return s.agentRoute(w, r, found, match[2])

	}

	if match := routinePath.FindStringSubmatch(path); match != nil {

		id, _ := strconv.ParseInt(match[1], 10, 64)

		return s.routineRoute(w, r, userID, id, match[2] != "")

	}

	if match := groupPath.FindStringSubmatch(path); match != nil && r.Method == http.MethodDelete {

		id, err := s.groupIDOr404(userID, match[1])

		if err != nil {

			return err

		}

		if err := s.st.DeleteGroupChat(userID, id); err != nil {

			return err

		}

		return ok(w)

	}

	switch route {

	case "POST /api/logout":

		setSession(w, "", 0)

		return ok(w)

	case "GET /api/agents":

		agents, err := s.st.ListAgents(userID)

		if err != nil {

			return err

		}

		views := make([]map[string]any, len(agents))

		for i := range agents {

			views[i] = s.agentView(&agents[i])

		}

		writeJSON(w, 200, views)

		return nil

	case "POST /api/agents":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		modelID, err := body.optional("modelId")

		if err != nil {

			return err

		}

		model := ""

		if modelID != nil {

			model = *modelID

		} else if model, err = s.defaultModel(ctx, userID); err != nil {

			return err

		}

		if model == "" {

			return failWith(503, "No model to give it yet. Connect Boodle in settings.")

		}

		name, err := body.text("name")

		if err != nil {

			return err

		}

		persona, err := body.optional("persona")

		if err != nil {

			return err

		}

		text := ""

		if persona != nil {

			text = *persona

		}

		created, err := s.st.CreateAgent(userID, strings.TrimSpace(name), model, text)

		if err != nil {

			return err

		}

		writeJSON(w, http.StatusCreated, s.agentView(created))

		return nil

	case "GET /api/settings":

		view, err := s.settingsView(ctx, userID)

		if err != nil {

			return err

		}

		writeJSON(w, 200, view)

		return nil

	case "PUT /api/settings":

		return s.saveSettings(w, r, userID)

	case "GET /api/group":

		groupID, err := s.groupIDOr404(userID, r.URL.Query().Get("group"))

		if err != nil {

			return err

		}

		limit, before := page(r)
		messages, err := s.st.ListGroupMessages(userID, groupID, limit, before)

		if err != nil {

			return err

		}

		writeJSON(w, 200, messages)

		return nil

	case "POST /api/group":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		message, err := body.filled("text")

		if err != nil {

			return err

		}

		groupID, err := s.groupIDOr404(userID, body["group"])

		if err != nil {

			return err

		}

		if _, err := s.Boodle(userID); err != nil {

			return err

		}

		s.postGroup(userID, groupID, "user", 0, message, nil)

		writeJSON(w, http.StatusCreated, map[string]any{"ok": true})

		return nil

	case "GET /api/groups":

		views, err := s.groupViews(userID)

		if err != nil {

			return err

		}

		writeJSON(w, 200, views)

		return nil

	case "POST /api/groups":

		return s.createGroup(w, r, userID)

	case "POST /api/read":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		if raw, present := body["agent"]; present {

			id, _ := integer(raw)
			found, err := s.agentOr404(userID, id)

			if err != nil {

				return err

			}

			if err := s.st.MarkRead(userID, false, found.ID); err != nil {

				return err

			}

			return ok(w)

		}

		groupID, err := s.groupIDOr404(userID, body["group"])

		if err != nil {

			return err

		}

		if err := s.st.MarkRead(userID, true, groupID); err != nil {

			return err

		}

		return ok(w)

	case "GET /api/models":

		models, err := s.modelsOf(ctx, userID)

		if err != nil {

			return err

		}

		writeJSON(w, 200, models)

		return nil

	case "GET /api/user":

		writeJSON(w, 200, map[string]any{"text": s.st.ReadUserDoc(userID)})

		return nil

	case "PUT /api/user":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		text, err := body.text("text")

		if err != nil {

			return err

		}

		if err := s.st.WriteUserDoc(userID, text); err != nil {

			return err

		}

		return ok(w)

	case "GET /api/cookie":

		return s.cookieView(w, ctx, user)

	case "PUT /api/cookie":

		return s.saveCookie(w, r, userID)

	case "GET /api/push":

		writeJSON(w, 200, map[string]any{"publicKey": s.push.PublicKey()})

		return nil

	case "POST /api/push":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		sub, _ := body["subscription"].(map[string]any)
		endpoint, isText := sub["endpoint"].(string)

		if !isText {

			return failWith(400, "subscription.endpoint must be a string")

		}

		encoded, _ := json.Marshal(sub)

		if err := s.st.SavePushSub(userID, endpoint, string(encoded)); err != nil {

			return err

		}

		return ok(w)

	case "DELETE /api/push":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		endpoint, err := body.text("endpoint")

		if err != nil {

			return err

		}

		if err := s.st.DeletePushSub(endpoint); err != nil {

			return err

		}

		return ok(w)

	}

	return failWith(404, "Not found")

}

func (s *Server) agentRoute(w http.ResponseWriter, r *http.Request, found *store.Agent, action string) error {

	switch r.Method + " " + action {

	case "GET ":

		writeJSON(w, 200, s.agentView(found))

		return nil

	case "PATCH ":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		changes := store.AgentChanges{}

		for field, target := range map[string]**string{"modelId": &changes.ModelID, "persona": &changes.Persona, "glyph": &changes.Glyph, "category": &changes.Category} {

			if *target, err = body.optional(field); err != nil {

				return err

			}

		}

		if changes.Glyph != nil && !glyph.Valid(*changes.Glyph) {

			return failWith(400, "glyph must be shape:color from the known sets")

		}

		if changes.Category != nil {

			trimmed := strings.TrimSpace(*changes.Category)
			changes.Category = &trimmed

			if len([]rune(trimmed)) > 32 {

				return failWith(400, "Categories are at most 32 characters")

			}

		}

		if err := s.st.UpdateAgent(found.ID, changes); err != nil {

			return err

		}

		updated, err := s.st.AgentByID(found.ID)

		if err != nil {

			return err

		}

		writeJSON(w, 200, s.agentView(updated))

		return nil

	case "DELETE ":

		s.queue.Stop(found.ID)
		browser.Close(s.st.Workspace(found), true)

		if found.BotDraftID != "" {

			if client, err := s.Boodle(found.UserID); err == nil {

				client.DeleteCustomBot(r.Context(), found.BotDraftID)

			}

		}

		if err := s.st.DeleteAgent(found.ID); err != nil {

			return err

		}

		return ok(w)

	case "GET events":

		limit, before := page(r)
		events, err := s.st.ListEvents(found.ID, limit, before)

		if err != nil {

			return err

		}

		writeJSON(w, 200, events)

		return nil

	case "POST messages":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		message, err := body.filled("text")

		if err != nil {

			return err

		}

		// fail now rather than queue a run that can only error once it starts
		if _, err := s.Boodle(found.UserID); err != nil {

			return err

		}

		s.queue.Send(*found, message)

		writeJSON(w, 200, s.agentView(found))

		return nil

	case "POST answer":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		allow, isBool := body["allow"].(bool)
		text, isText := body["text"].(string)

		if !isBool && !isText {

			return failWith(400, "allow must be true or false, or text the answer to a question")

		}

		// words only ever answer a question, never an approval
		answered := false

		if isText {

			answered = s.queue.Answer(found.ID, agent.Answer(text), agent.WaitQuestion)

		} else {

			answered = s.queue.Answer(found.ID, agent.Allow(allow), "")

		}

		if !answered {

			return failWith(409, "Nothing is waiting for an answer")

		}

		writeJSON(w, 200, s.agentView(found))

		return nil

	case "POST stop":

		s.queue.Stop(found.ID)

		writeJSON(w, 200, s.agentView(found))

		return nil

	case "GET memory":

		writeJSON(w, 200, map[string]any{"text": s.st.ReadMemory(found)})

		return nil

	case "PUT memory":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		text, err := body.text("text")

		if err != nil {

			return err

		}

		if err := s.st.WriteMemory(found, text); err != nil {

			return err

		}

		return ok(w)

	case "GET routines":

		zone := s.st.UserZone(found.UserID)
		routines, err := s.st.ListRoutines(found.ID)

		if err != nil {

			return err

		}

		views := make([]map[string]any, len(routines))

		for i, routine := range routines {

			views[i] = routineView(routine)
			views[i]["nextAt"] = features.NextAt(routine, zone, time.Now())

		}

		writeJSON(w, 200, views)

		return nil

	case "POST routines":

		body, err := readBody(r)

		if err != nil {

			return err

		}

		spec, err := body.text("spec")

		if err != nil {

			return err

		}

		target, err := body.optional("target")

		if err != nil {

			return err

		}

		title, err := body.optional("title")

		if err != nil {

			return err

		}

		kind, _ := body["kind"].(string)
		input := store.RoutineInput{Kind: kind, Spec: strings.TrimSpace(spec)}

		if target != nil {

			input.Target = strings.TrimSpace(*target)

		}

		if title != nil {

			input.Title = strings.ReplaceAll(strings.TrimSpace(*title), "\"", "")

		}

		if err := features.ValidateRoutine(kind, input.Spec, input.Target); err != nil {

			return err

		}

		task, err := body.text("task")

		if err != nil {

			return err

		}

		input.Task = strings.TrimSpace(task)
		created, err := s.st.CreateRoutine(found.ID, input)

		if err != nil {

			return err

		}

		writeJSON(w, http.StatusCreated, created)

		return nil

	}

	return failWith(404, "Not found")

}

// routineView is a routine as the PWA reads it, with room for the nextAt only the list works out.
func routineView(routine store.Routine) map[string]any {

	encoded, _ := json.Marshal(routine)

	var view map[string]any

	json.Unmarshal(encoded, &view)

	return view

}

func (s *Server) routineRoute(w http.ResponseWriter, r *http.Request, userID, id int64, run bool) error {

	routine, err := s.st.GetRoutine(id)

	if err != nil {

		return failWith(404, "No such routine")

	}

	owner, err := s.st.AgentByID(routine.AgentID)

	if err != nil || owner.UserID != userID {

		return failWith(404, "No such routine")

	}

	if run && r.Method == http.MethodPost {

		// a watch run by hand skips the check and just does its task
		byHand := *routine
		byHand.Kind = "schedule"

		s.queue.Enqueue(*owner, features.RoutineTask(byHand, s.st.UserZone(userID), ""), nil)

		return ok(w)

	}

	if r.Method == http.MethodDelete {

		if err := s.st.DeleteRoutine(routine.ID); err != nil {

			return err

		}

		return ok(w)

	}

	if r.Method != http.MethodPatch {

		return failWith(404, "Not found")

	}

	body, err := readBody(r)

	if err != nil {

		return err

	}

	changes := store.RoutineChanges{}

	for field, target := range map[string]**string{"spec": &changes.Spec, "target": &changes.Target, "task": &changes.Task} {

		if *target, err = body.optional(field); err != nil {

			return err

		}

	}

	for _, field := range []**string{&changes.Spec, &changes.Target} {

		if *field != nil {

			trimmed := strings.TrimSpace(**field)
			*field = &trimmed

		}

	}

	if raw, present := body["enabled"]; present {

		enabled, isBool := raw.(bool)

		if !isBool {

			return failWith(400, "enabled must be true or false")

		}

		changes.Enabled = &enabled

	}

	spec, target := routine.Spec, routine.Target

	if changes.Spec != nil {

		spec = *changes.Spec

	}

	if changes.Target != nil {

		target = *changes.Target

	}

	if err := features.ValidateRoutine(routine.Kind, spec, target); err != nil {

		return err

	}

	if err := s.st.UpdateRoutine(routine.ID, changes); err != nil {

		return err

	}

	updated, err := s.st.GetRoutine(routine.ID)

	if err != nil {

		return err

	}

	writeJSON(w, 200, updated)

	return nil

}

func (s *Server) saveSettings(w http.ResponseWriter, r *http.Request, userID int64) error {

	body, err := readBody(r)

	if err != nil {

		return err

	}

	modelID, err := body.optional("defaultModel")

	if err != nil {

		return err

	}

	zone, err := body.optional("timezone")

	if err != nil {

		return err

	}

	if modelID == nil && zone == nil {

		return failWith(400, "Nothing to save")

	}

	if modelID != nil {

		models, err := s.modelsOf(r.Context(), userID)

		if err != nil {

			return err

		}

		known := false

		for _, model := range models {

			known = known || model.ID == *modelID

		}

		if !known {

			return failWith(400, "That model is not available to this Boodle account")

		}

	}

	if zone != nil {

		trimmed := strings.TrimSpace(*zone)
		zone = &trimmed

		if trimmed != "" && !features.IsTimeZone(trimmed) {

			return failWith(400, "Unknown time zone. Use a name like America/New_York.")

		}

	}

	if modelID != nil {

		if err := s.st.WriteSetting(userID, "defaultModel", *modelID); err != nil {

			return err

		}

	}

	if zone != nil {

		if err := s.st.WriteSetting(userID, "timezone", *zone); err != nil {

			return err

		}

		if err := browser.SetZone(s.st.UserDir(userID), *zone); err != nil {

			return err

		}

	}

	view, err := s.settingsView(r.Context(), userID)

	if err != nil {

		return err

	}

	writeJSON(w, 200, view)

	return nil

}

func (s *Server) createGroup(w http.ResponseWriter, r *http.Request, userID int64) error {

	body, err := readBody(r)

	if err != nil {

		return err

	}

	raw, _ := body["members"].([]any)
	seen := map[int64]bool{}
	members := []*store.Agent{}
	valid := true

	for _, value := range raw {

		id, whole := integer(value)

		if seen[id] {

			continue

		}

		seen[id] = true
		found, err := s.st.AgentByID(id)

		if !whole || err != nil || found.UserID != userID {

			valid = false

			continue

		}

		members = append(members, found)

	}

	if len(seen) < 2 || !valid {

		return failWith(400, "members must name at least two agents")

	}

	name, err := body.optional("name")

	if err != nil {

		return err

	}

	// quotes would break the thread title the agent's chat reads back
	title := ""

	if name != nil {

		title = strings.ReplaceAll(strings.TrimSpace(*name), "\"", "")

		if runes := []rune(title); len(runes) > 60 {

			title = string(runes[:60])

		}

	}

	ids := make([]int64, len(members))
	names := make([]string, len(members))

	for i, member := range members {

		ids[i] = member.ID
		names[i] = member.Name

	}

	if title == "" {

		title = strings.Join(names, ", ")

	}

	group, err := s.st.CreateGroupChat(userID, title, ids)

	if err != nil {

		return err

	}

	writeJSON(w, http.StatusCreated, map[string]any{"id": group.ID, "name": group.Name, "members": group.Members, "createdAt": group.CreatedAt, "unread": 0})

	return nil

}

func (s *Server) cookieView(w http.ResponseWriter, ctx context.Context, user *store.User) error {

	state := s.tenant(user.ID)

	s.mu.Lock()
	known := state.account
	s.mu.Unlock()

	// an expired cookie still reads as set; the PWA shows it without a name, and runs say why they fail
	if user.Cookie != "" && known == nil {

		if client, err := s.Boodle(user.ID); err == nil {

			if bootstrap, err := client.GetUser(ctx); err == nil {

				known = accountOf(bootstrap)

				s.mu.Lock()
				state.account = known
				s.mu.Unlock()

			}

		}

	}

	view := map[string]any{"set": user.Cookie != "", "userId": nil, "name": nil, "email": nil}

	if user.Cookie != "" {

		if session, err := sdk.ParseSession(user.Cookie); err == nil {

			view["userId"] = session.UserID

		}

	}

	if known != nil {

		view["name"] = known.Name
		view["email"] = known.Email

	}

	writeJSON(w, 200, view)

	return nil

}

func (s *Server) saveCookie(w http.ResponseWriter, r *http.Request, userID int64) error {

	body, err := readBody(r)

	if err != nil {

		return err

	}

	cookie, err := body.text("cookie")

	if err != nil {

		return err

	}

	cookie = strings.TrimSpace(cookie)
	next, err := sdk.NewClient(sdk.ClientOptions{Cookie: cookie})

	if err != nil {

		return err

	}

	// a cookie that cannot load the user is one that will fail every run
	bootstrap, err := next.GetUser(r.Context())

	if err != nil {

		return failWith(400, "Boodle rejected that cookie: "+err.Error())

	}

	if err := s.st.WriteCookie(userID, cookie); err != nil {

		return err

	}

	found := accountOf(bootstrap)

	s.mu.Lock()
	s.tenants[userID] = &tenant{client: next, account: found}
	s.mu.Unlock()

	writeJSON(w, 200, map[string]any{"ok": true, "userId": next.UserID(), "name": found.Name, "email": found.Email})

	return nil

}
