// Package server is pts's HTTP API, its WebSocket, and the glue that turns messages and routines into agent runs.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"boombox/agent"
	"boombox/agent/browser"
	"boombox/config"
	"boombox/features"
	"boombox/store"
	"boombox/sdk"

	"github.com/coder/websocket"
)

const recentGroup = 20

type account struct {

	Name *string `json:"name"`
	Email *string `json:"email"`

}

// tenant is what the server keeps for each user between requests: their Boodle client and what it has looked up.
type tenant struct {

	client *sdk.Client
	models []modelView
	account *account

	// preferredModel is nil until looked up; an empty string when Boodle has no preference we can match.
	preferredModel *string

}

type modelView struct {

	ID string `json:"id"`
	Name string `json:"name"`

}

type Server struct {

	st *store.Store
	queue *agent.Queue
	live *Live
	push *Push
	hub *hub

	web string

	mu sync.Mutex
	tenants map[int64]*tenant

	// watching is the sockets whose window is on screen right now
	watching map[*client]bool

}

// New wires the queue, live view and push to the store; web is the built PWA's folder.
func New(st *store.Store, web string) (*Server, error) {

	push, err := NewPush(st)

	if err != nil {

		return nil, err

	}

	s := &Server{st: st, push: push, hub: newHub(), web: web, tenants: map[int64]*tenant{}, watching: map[*client]bool{}}

	s.queue = agent.NewQueue(s.startRun, s.onRunEvent, func(agentID int64, state agent.State) {

		if found, err := st.AgentByID(agentID); err == nil {

			s.hub.publish(found.UserID, map[string]any{"type": "state", "agentId": agentID, "state": state})

		}

	}, 0)

	// handing the browser back is how the user answers a <handoff>
	s.live = NewLive(st, func(agentID int64) { s.queue.Answer(agentID, agent.Allow(true), agent.WaitHandoff) })

	return s, nil

}

func (s *Server) Queue() *agent.Queue { return s.queue }

func (s *Server) tenant(userID int64) *tenant {

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.tenants[userID] == nil {

		s.tenants[userID] = &tenant{}

	}

	return s.tenants[userID]

}

// Boodle is the user's Boodle client, made from their stored cookie on first use.
func (s *Server) Boodle(userID int64) (*sdk.Client, error) {

	state := s.tenant(userID)

	s.mu.Lock()
	defer s.mu.Unlock()

	if state.client != nil {

		return state.client, nil

	}

	cookie := s.st.ReadCookie(userID)

	if cookie == "" {

		return nil, failWith(503, "No Boodle cookie yet. Paste one in settings.")

	}

	client, err := sdk.NewClient(sdk.ClientOptions{Cookie: cookie})

	if err != nil {

		return nil, failWith(503, err.Error())

	}

	state.client = client

	return client, nil

}

func (s *Server) modelsOf(ctx context.Context, userID int64) ([]modelView, error) {

	state := s.tenant(userID)

	s.mu.Lock()
	cached := state.models
	s.mu.Unlock()

	if cached != nil {

		return cached, nil

	}

	client, err := s.Boodle(userID)

	if err != nil {

		return nil, err

	}

	models, err := client.ListCustomModels(ctx)

	if err != nil {

		return nil, err

	}

	views := make([]modelView, len(models))

	for i, model := range models {

		views[i] = modelView{ID: model.ID, Name: model.Name}

	}

	s.mu.Lock()
	state.models = views
	s.mu.Unlock()

	return views, nil

}

// defaultModel is the user's pick in settings, else the one they prefer in Boodle, matched to a bot model by its upstream id.
func (s *Server) defaultModel(ctx context.Context, userID int64) (string, error) {

	if chosen := s.st.ReadSetting(userID, "defaultModel"); chosen != "" {

		return chosen, nil

	}

	state := s.tenant(userID)

	s.mu.Lock()
	known := state.preferredModel
	s.mu.Unlock()

	if known != nil {

		return *known, nil

	}

	client, err := s.Boodle(userID)

	if err != nil {

		return "", err

	}

	assistants, err := client.ListAssistants(ctx)

	if err != nil {

		return "", err

	}

	custom, err := client.ListCustomModels(ctx)

	if err != nil {

		return "", err

	}

	var preferred *sdk.AssistantSummary

	for i := range assistants {

		if assistants[i].ID == client.PreferredAssistantID() {

			preferred = &assistants[i]

		}

	}

	chosen := ""

	if preferred != nil {

		for _, model := range custom {

			if preferred.Model != "" && model.Model == preferred.Model {

				chosen = model.ID

				break

			}

		}

		if chosen == "" {

			for _, model := range custom {

				if model.Name == preferred.Name {

					chosen = model.ID

					break

				}

			}

		}

	}

	if chosen == "" && len(custom) > 0 {

		chosen = custom[0].ID

	}

	s.mu.Lock()
	state.preferredModel = &chosen
	s.mu.Unlock()

	return chosen, nil

}

func (s *Server) settingsView(ctx context.Context, userID int64) (map[string]any, error) {

	view := map[string]any{"defaultModel": nil, "timezone": nil}

	if s.st.ReadCookie(userID) != "" {

		model, err := s.defaultModel(ctx, userID)

		if err != nil {

			return nil, err

		}

		if model != "" {

			view["defaultModel"] = model

		}

	}

	if zone := s.st.ReadSetting(userID, "timezone"); zone != "" {

		view["timezone"] = zone

	}

	return view, nil

}

// accountOf reads the person Boodle nests two levels down, as user.user.
func accountOf(bootstrap map[string]any) *account {

	person, _ := bootstrap["user"].(map[string]any)
	person, _ = person["user"].(map[string]any)
	found := &account{}

	if name, ok := person["name"].(string); ok {

		found.Name = &name

	}

	if email, ok := person["email"].(string); ok {

		found.Email = &email

	}

	return found

}

func (s *Server) watched(userID int64) bool {

	s.mu.Lock()
	defer s.mu.Unlock()

	for c := range s.watching {

		if c.userID == userID {

			return true

		}

	}

	return false

}

// a finished task does not buzz on its own: the agent decides, with <notify>, when it is worth it
var buzz = map[store.EventKind]func(name string) string{

	store.KindNotify: func(name string) string { return name },
	store.KindAsk: func(name string) string { return name + " needs your OK" },
	store.KindHandoff: func(name string) string { return name + " needs you in the browser" },
	store.KindQuestion: func(name string) string { return name + " has a question" },

}

var (
	expired = regexp.MustCompile(`failed: 40[13]\b`)
	bearer = regexp.MustCompile(`(?i)^Bearer\s+`)
)

func (s *Server) onRunEvent(event agent.RunEvent) {

	agentID := event.Event.AgentID

	if event.Delta {

		agentID = event.AgentID

	}

	// an agent deleted mid-run has nobody left to tell
	owner, err := s.st.AgentByID(agentID)

	if err != nil {

		return

	}

	if event.Delta {

		s.hub.publish(owner.UserID, map[string]any{"type": "delta", "agentId": agentID, "text": event.Text})

		return

	}

	s.hub.publish(owner.UserID, map[string]any{"type": "event", "event": event.Event})

	// someone with the app open sees all of this live; buzzing their phone as well is noise
	if s.watched(owner.UserID) {

		return

	}

	first, _, _ := strings.Cut(event.Event.Text, "\n")

	if title := buzz[event.Event.Kind]; title != nil {

		go s.push.Notify(owner.UserID, Notice{Title: title(owner.Name), Body: first, AgentID: agentID})

		return

	}

	if event.Event.Kind == store.KindError && event.Event.Text != agent.StoppedText {

		// the SDK puts Boodle's status in the message; a 401 means the pasted cookie has expired
		notice := Notice{Title: owner.Name + " hit a problem", Body: clipBytes(event.Event.Text, 200), AgentID: agentID}

		if expired.MatchString(event.Event.Text) {

			notice = Notice{Title: "Boodle cookie expired", Body: "Paste a fresh cookie in settings to get agents working again.", AgentID: agentID}

		}

		go s.push.Notify(owner.UserID, notice)

	}

}

func clipBytes(text string, limit int) string {

	if len(text) <= limit {

		return text

	}

	return strings.ToValidUTF8(text[:limit], "")

}

func (s *Server) postSystem(userID, groupID int64, author string, agentID int64, text string) {

	message, err := s.st.AddGroupMessage(userID, groupID, author, agentID, text)

	if err == nil {

		s.hub.publish(userID, map[string]any{"type": "group", "message": message})

	}

}

// postGroup saves and shows a thread message, then wakes whoever in that thread it routes to; group 0 is Everyone.
func (s *Server) postGroup(userID, groupID int64, author string, agentID int64, text string, origin *features.Origin) {

	var group *store.GroupChat

	if groupID != 0 {

		found, err := s.st.GetGroupChat(userID, groupID)

		// a reply finishing after its group was deleted has nowhere to go
		if err != nil {

			return

		}

		group = found

	}

	recent, _ := s.st.ListGroupMessages(userID, groupID, recentGroup, store.Newest)
	message, err := s.st.AddGroupMessage(userID, groupID, author, agentID, text)

	if err != nil {

		return

	}

	all, _ := s.st.ListAgents(userID)
	agents := []store.Agent{}

	for _, one := range all {

		if group == nil || containsID(group.Members, one.ID) {

			agents = append(agents, one)

		}

	}

	s.hub.publish(userID, map[string]any{"type": "group", "message": message})

	next := features.RouteMessage(message, agents, origin)

	if next.Capped {

		// posted directly: routed like a user message, the note would wake everyone
		s.postSystem(userID, groupID, "system", 0, "Hand-off limit reached ("+strconv.Itoa(features.MaxHops)+" in a row). @mention an agent to keep going.")

		return

	}

	title := "Everyone"

	if group != nil {

		title = group.Name

	}

	// an agent still busy on this chain, say replying "wait", gets the hand-off once that run ends rather than never
	for _, recipient := range next.Recipients {

		origin := next.Origin

		s.queue.Enqueue(recipient, features.GroupTask(recipient, agents, recent, message, title), &origin)

	}

}

// routeDirect passes a run in an agent's own chat on to the agents it @mentions, and back to the one that asked for it.
func (s *Server) routeDirect(author store.Agent, end store.AgentEvent, origin *features.Origin) {

	agents, err := s.st.ListAgents(author.UserID)

	if err != nil {

		return

	}

	route := features.RouteDirect(author, end, agents, origin)

	if route.Capped {

		log.Printf("hand-off limit reached for %s (%d in a row)", author.Name, features.MaxHops)

		return

	}

	for _, delivery := range route.Deliveries {

		next := delivery.Origin

		s.queue.Enqueue(delivery.To, delivery.Task, &next)

	}

}

func containsID(ids []int64, id int64) bool {

	for _, one := range ids {

		if one == id {

			return true

		}

	}

	return false

}

func (s *Server) startRun(queued store.Agent, task string, control agent.RunControl, origin *features.Origin) {

	client, err := s.Boodle(queued.UserID)

	if err != nil {

		log.Printf("run for %s failed: %v", queued.Name, err)

		return

	}

	end := agent.RunAgent(s.st, client, queued, task, control)

	if end.Text == agent.StoppedText {

		return

	}

	if origin == nil || origin.Direct {

		s.routeDirect(queued, end, origin)

		return

	}

	if features.IsWaiting(end.Text) {

		return

	}

	if end.Kind == store.KindDone {

		s.postGroup(queued.UserID, origin.Group, queued.Name, queued.ID, end.Text, origin)

		return

	}

	if origin.Group == 0 {

		s.postSystem(queued.UserID, 0, queued.Name, queued.ID, "Could not finish: "+end.Text)

		return

	}

	if _, err := s.st.GetGroupChat(queued.UserID, origin.Group); err == nil {

		s.postSystem(queued.UserID, origin.Group, queued.Name, queued.ID, "Could not finish: "+end.Text)

	}

}

func (s *Server) agentView(found *store.Agent) map[string]any {

	question, kind := s.queue.Question(found.ID)

	view := map[string]any{

		"id": found.ID,
		"name": found.Name,
		"modelId": found.ModelID,
		"persona": found.Persona,
		"glyph": found.Glyph,
		"category": found.Category,
		"createdAt": found.CreatedAt,

		"state": s.queue.State(found.ID),
		"question": nil,
		"waitingOn": nil,
		"unread": s.st.UnreadEvents(found),

	}

	if kind != "" {

		view["question"] = question
		view["waitingOn"] = kind

	}

	return view

}

// groupViews puts Everyone first, as group 0 with no member list, since it is all of them.
func (s *Server) groupViews(userID int64) ([]map[string]any, error) {

	groups, err := s.st.ListGroupChats(userID)

	if err != nil {

		return nil, err

	}

	views := []map[string]any{{"id": 0, "name": "Everyone", "members": []int64{}, "createdAt": 0, "unread": s.st.UnreadGroup(userID, 0)}}

	for _, group := range groups {

		views = append(views, map[string]any{"id": group.ID, "name": group.Name, "members": group.Members, "createdAt": group.CreatedAt, "unread": s.st.UnreadGroup(userID, group.ID)})

	}

	return views, nil

}

func (s *Server) groupIDOr404(userID int64, value any) (int64, error) {

	id, whole := integer(value)

	if !whole {

		return 0, failWith(404, "No such group chat")

	}

	if id != 0 {

		if _, err := s.st.GetGroupChat(userID, id); err != nil {

			return 0, failWith(404, "No such group chat")

		}

	}

	return id, nil

}

// agentOr404 answers for another user's agent exactly as for one that does not exist.
func (s *Server) agentOr404(userID, id int64) (*store.Agent, error) {

	found, err := s.st.AgentByID(id)

	if err != nil || found.UserID != userID {

		return nil, failWith(404, "No such agent")

	}

	return found, nil

}

func (s *Server) userOf(r *http.Request) *store.User {

	if key := bearer.ReplaceAllString(r.Header.Get("Authorization"), ""); key != "" {

		if user, err := s.st.UserByKey(key); err == nil {

			return user

		}

	}

	if cookie, err := r.Cookie(sessionCookie); err == nil {

		if user, err := s.st.UserByKey(cookie.Value); err == nil {

			return user

		}

	}

	return nil

}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {

	if !strings.HasPrefix(r.URL.Path, "/api/") {

		s.serveWeb(w, r)

		return

	}

	if err := s.api(w, r); err != nil {

		status, message := errorStatus(err)

		writeJSON(w, status, map[string]any{"error": message})

	}

}

// serveWeb serves the built PWA; unknown paths get index.html, since the app routes in the hash.
func (s *Server) serveWeb(w http.ResponseWriter, r *http.Request) {

	root, _ := filepath.Abs(s.web)

	// left percent-encoded on purpose: decoding would let %2e%2e climb out, and no built file needs it
	target := filepath.Join(root, filepath.FromSlash(r.URL.EscapedPath()))
	index := filepath.Join(root, "index.html")
	stat, err := os.Stat(target)
	inside := strings.HasPrefix(target, root+string(filepath.Separator)) && err == nil && stat.Mode().IsRegular()

	if !inside {

		if _, err := os.Stat(index); err != nil {

			http.Error(w, "The PWA is not built yet. From web: bun run pts:web", http.StatusNotFound)

			return

		}

		target = index

	}

	// hashed bundles never change under one name; everything else must be re-checked or a deploy never lands
	if inside && strings.HasPrefix(r.URL.Path, "/assets/") {

		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")

	} else {

		w.Header().Set("Cache-Control", "no-cache")

	}

	file, err := os.Open(target)

	if err != nil {

		http.Error(w, err.Error(), http.StatusNotFound)

		return

	}

	defer file.Close()

	info, _ := file.Stat()

	http.ServeContent(w, r, filepath.Base(target), info.ModTime(), file)

}

func (s *Server) serveSocket(w http.ResponseWriter, r *http.Request, userID int64) {

	// a TLS proxy in front may rewrite Host, so the origin is not compared; the session cookie is SameSite=Strict
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})

	if err != nil {

		return

	}

	ws.SetReadLimit(1 << 20)

	c := newClient(ws, userID)

	s.hub.add(c)

	defer func() {

		s.hub.remove(c)

		s.mu.Lock()
		delete(s.watching, c)
		s.mu.Unlock()

		s.live.Close(c)
		c.close()

	}()

	for {

		_, data, err := ws.Read(r.Context())

		if err != nil {

			return

		}

		// a window says whether it is on screen, and drives the live browser; everything else is HTTP
		var message map[string]json.RawMessage

		if json.Unmarshal(data, &message) != nil {

			continue

		}

		if _, isLive := message["live"]; isLive {

			var live liveMessage

			if json.Unmarshal(data, &live) == nil {

				s.live.Message(c, live)

			}

			continue

		}

		s.mu.Lock()

		if string(message["visible"]) == "true" {

			s.watching[c] = true

		} else {

			delete(s.watching, c)

		}

		s.mu.Unlock()

	}

}

// Sweep deletes chats a crash or a failed delete left behind; nothing runs yet, so every tracked chat is finished.
func (s *Server) Sweep() {

	users, err := s.st.ListUsers()

	if err != nil {

		return

	}

	for _, user := range users {

		if user.Cookie == "" {

			continue

		}

		client, err := s.Boodle(user.ID)

		if err != nil {

			continue

		}

		chats, _ := s.st.TrackedChats(user.ID, 0)

		go agent.DropChats(s.st, client, chats)

	}

}

// Start applies the proxy and every user's zone before the scheduler, so no browser starts without them.
func (s *Server) Start(ctx context.Context) error {

	users, err := s.st.ListUsers()

	if err != nil {

		return err

	}

	if len(users) == 0 {

		log.Print("pts: nobody can sign in yet. Make a key: pts key <name>")

	}

	s.Sweep()

	proxy := config.Proxy()

	// localhost goes through the proxy too; without one, agents' browsers can reach every service on this machine
	if parsed, err := browser.ProxyURL(proxy); err != nil {

		return err

	} else if parsed != nil {

		log.Printf("pts: browsers go through %s", browser.ProxyLabel(parsed))

	} else {

		log.Print("pts: no PTS_PROXY, so agents' browsers can reach this machine's local services")

	}

	if err := browser.SetProxy(proxy); err != nil {

		return errors.New("could not apply a browser proxy: " + err.Error())

	}

	for _, user := range users {

		if err := browser.SetZone(s.st.UserDir(user.ID), s.st.ReadSetting(user.ID, "timezone")); err != nil {

			return errors.New("could not apply a browser time zone: " + err.Error())

		}

	}

	browser.Warm()

	features.StartScheduler(ctx, s.st, func(target store.Agent, task string) { s.queue.Enqueue(target, task, nil) })

	return nil

}
