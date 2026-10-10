// Package store keeps users, agents, their events and routines in SQLite, on the schema the TypeScript server made, so its database opens as it is.
package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"boombox/agent/shell"
	"boombox/config"

	_ "modernc.org/sqlite"
)

var name = regexp.MustCompile(`^[A-Za-z][\w -]{0,31}$`)

var slug = regexp.MustCompile(`[^a-z0-9]+`)

// ErrNotFound is what a lookup of a missing row returns.
var ErrNotFound = errors.New("not found")

const schema = `
  pragma journal_mode = wal;

  create table if not exists users (
    id integer primary key,
    name text not null unique collate nocase,
    key_hash text not null unique,
    cookie text,
    created_at integer not null
  );

  -- autoincrement: a reused id would hand a deleted agent's late events to someone else's new one
  create table if not exists agents (
    id integer primary key autoincrement,
    user_id integer not null references users(id) on delete cascade,
    name text not null collate nocase,
    model_id text not null,
    persona text not null default '',
    bot_draft_id text,
    bot_assistant_id text,
    bot_hash text,
    glyph text not null default '',
    category text not null default '',
    created_at integer not null,
    unique (user_id, name)
  );

  create table if not exists settings (
    user_id integer not null references users(id) on delete cascade,
    key text not null,
    value text not null,
    primary key (user_id, key)
  );

  create table if not exists events (
    id integer primary key,
    agent_id integer not null references agents(id) on delete cascade,
    run_id text not null,
    kind text not null,
    text text not null,
    at integer not null
  );

  create table if not exists push_subs (
    endpoint text primary key,
    json text not null,
    user_id integer not null references users(id) on delete cascade
  );

  create table if not exists routines (
    id integer primary key,
    agent_id integer not null references agents(id) on delete cascade,
    kind text not null,
    spec text not null,
    target text not null default '',
    title text not null default '',
    task text not null,
    enabled integer not null default 1,
    last_output text,
    last_at integer
  );

  -- no cascade from agents: a deleted agent's chats still have to be deleted from Boodle
  create table if not exists chats (
    id text primary key,
    agent_id integer not null,
    user_id integer not null references users(id) on delete cascade
  );

  create table if not exists group_chats (
    id integer primary key,
    name text not null,
    created_at integer not null,
    user_id integer not null references users(id) on delete cascade
  );

  create table if not exists group_members (
    group_id integer not null references group_chats(id) on delete cascade,
    agent_id integer not null references agents(id) on delete cascade,
    primary key (group_id, agent_id)
  );

  -- group 0 is each user's Everyone, which has no row in group_chats
  create table if not exists group_messages (
    id integer primary key,
    author text not null,
    agent_id integer,
    text text not null,
    at integer not null,
    group_id integer not null default 0,
    user_id integer not null references users(id) on delete cascade
  );

  create index if not exists events_by_agent on events(agent_id, id);
  create index if not exists group_messages_by_thread on group_messages(user_id, group_id, id);
`

type Store struct {

	Home string

	db *sql.DB

}

// Open creates the home folder private to this user, since the database holds every user's Boodle cookie.
func Open(home string) (*Store, error) {

	if err := os.MkdirAll(home, 0o700); err != nil {

		return nil, err

	}

	if err := os.Chmod(home, 0o700); err != nil {

		return nil, err

	}

	path := filepath.ToSlash(filepath.Join(home, "pts.db"))

	// foreign keys are per connection, so every pooled one gets the pragma
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)")

	if err != nil {

		return nil, err

	}

	if _, err := db.Exec(schema); err != nil {

		db.Close()

		return nil, err

	}

	return &Store{Home: home, db: db}, nil

}

// OpenDefault opens the store in PTS_HOME.
func OpenDefault() (*Store, error) {

	return Open(config.Home())

}

func (s *Store) Close() error {

	return s.db.Close()

}

func now() int64 {

	return time.Now().UnixMilli()

}

func hashKey(key string) string {

	sum := sha256.Sum256([]byte(key))

	return hex.EncodeToString(sum[:])

}

// nullable maps "" to SQL null, which is how the schema stores an absent value.
func nullable(value string) any {

	if value == "" {

		return nil

	}

	return value

}

func (s *Store) exec(query string, args ...any) error {

	_, err := s.db.Exec(query, args...)

	return err

}

func (s *Store) count(query string, args ...any) int64 {

	var n int64

	s.db.QueryRow(query, args...).Scan(&n)

	return n

}

type User struct {

	ID int64
	Name string

	// Cookie is their Boodle cookie, empty until they paste one.
	Cookie string

	CreatedAt int64

}

const userColumns = "select id, name, coalesce(cookie, ''), created_at from users"

func scanUser(row interface{ Scan(...any) error }) (*User, error) {

	var user User

	if err := row.Scan(&user.ID, &user.Name, &user.Cookie, &user.CreatedAt); err != nil {

		if errors.Is(err, sql.ErrNoRows) {

			return nil, ErrNotFound

		}

		return nil, err

	}

	return &user, nil

}

// IssueKey makes the user if they are new and gives them a fresh key either way; only its hash is kept.
func (s *Store) IssueKey(userName string) (string, error) {

	if !name.MatchString(userName) {

		return "", errors.New("User names start with a letter and use up to 32 letters, digits, spaces, - or _")

	}

	random := make([]byte, 24)

	rand.Read(random)

	key := "pts_" + base64.RawURLEncoding.EncodeToString(random)
	err := s.exec("insert into users (name, key_hash, created_at) values (?, ?, ?) on conflict (name) do update set key_hash = excluded.key_hash", userName, hashKey(key), now())

	return key, err

}

func (s *Store) UserByKey(key string) (*User, error) {

	if key == "" {

		return nil, ErrNotFound

	}

	return scanUser(s.db.QueryRow(userColumns+" where key_hash = ?", hashKey(key)))

}

func (s *Store) GetUser(userName string) (*User, error) {

	return scanUser(s.db.QueryRow(userColumns+" where name = ?", userName))

}

func (s *Store) ListUsers() ([]User, error) {

	rows, err := s.db.Query(userColumns + " order by name")

	if err != nil {

		return nil, err

	}

	defer rows.Close()

	users := []User{}

	for rows.Next() {

		user, err := scanUser(rows)

		if err != nil {

			return nil, err

		}

		users = append(users, *user)

	}

	return users, rows.Err()

}

// DeleteUser removes everything of theirs in the database; their workspaces stay on disk, like a deleted agent's.
func (s *Store) DeleteUser(id int64) error {

	return s.exec("delete from users where id = ?", id)

}

func (s *Store) ReadCookie(userID int64) string {

	var cookie sql.NullString

	s.db.QueryRow("select cookie from users where id = ?", userID).Scan(&cookie)

	return cookie.String

}

func (s *Store) WriteCookie(userID int64, cookie string) error {

	return s.exec("update users set cookie = ? where id = ?", strings.TrimSpace(cookie), userID)

}

// UserDir is where a user's agents and USER.md live; browser settings are scoped to it too.
func (s *Store) UserDir(userID int64) string {

	return filepath.Join(s.Home, "users", strconv.FormatInt(userID, 10))

}

// WorkspaceOf is the folder an agent's commands run in, named after it so it reads well in a shell.
func (s *Store) WorkspaceOf(userID int64, agentName string) string {

	return filepath.Join(s.UserDir(userID), "agents", slug.ReplaceAllString(strings.ToLower(agentName), "-"))

}

func (s *Store) Workspace(agent *Agent) string {

	return s.WorkspaceOf(agent.UserID, agent.Name)

}

func (s *Store) ReadUserDoc(userID int64) string {

	data, err := os.ReadFile(filepath.Join(s.UserDir(userID), "USER.md"))

	if err != nil {

		return ""

	}

	return string(data)

}

func (s *Store) WriteUserDoc(userID int64, text string) error {

	if err := os.MkdirAll(s.UserDir(userID), 0o755); err != nil {

		return err

	}

	return os.WriteFile(filepath.Join(s.UserDir(userID), "USER.md"), []byte(text), 0o644)

}

// ReadMemory never follows MEMORY.md, which the agent's shell can swap for a link or a FIFO at any moment.
func (s *Store) ReadMemory(agent *Agent) string {

	text, err := shell.ReadRegular(filepath.Join(s.Workspace(agent), "MEMORY.md"), false)

	if err != nil {

		return ""

	}

	return text

}

func (s *Store) WriteMemory(agent *Agent, text string) error {

	return shell.WriteRegular(filepath.Join(s.Workspace(agent), "MEMORY.md"), text)

}

func (s *Store) ReadSetting(userID int64, key string) string {

	var value string

	s.db.QueryRow("select value from settings where user_id = ? and key = ?", userID, key).Scan(&value)

	return value

}

func (s *Store) WriteSetting(userID int64, key, value string) error {

	return s.exec("insert into settings (user_id, key, value) values (?, ?, ?) on conflict (user_id, key) do update set value = excluded.value", userID, key, value)

}

// UserZone is the one clock a user's schedules, agents and shells read: their zone from Settings, else this machine's.
func (s *Store) UserZone(userID int64) string {

	if zone := s.ReadSetting(userID, "timezone"); zone != "" {

		return zone

	}

	return config.SystemZone()

}

func (s *Store) ListPushSubs(userID int64) ([]string, error) {

	rows, err := s.db.Query("select json from push_subs where user_id = ?", userID)

	if err != nil {

		return nil, err

	}

	defer rows.Close()

	subs := []string{}

	for rows.Next() {

		var sub string

		if err := rows.Scan(&sub); err != nil {

			return nil, err

		}

		subs = append(subs, sub)

	}

	return subs, rows.Err()

}

// SavePushSub gives a device to whoever subscribed it last.
func (s *Store) SavePushSub(userID int64, endpoint, json string) error {

	return s.exec("insert into push_subs (endpoint, json, user_id) values (?, ?, ?) on conflict (endpoint) do update set json = excluded.json, user_id = excluded.user_id", endpoint, json, userID)

}

func (s *Store) DeletePushSub(endpoint string) error {

	return s.exec("delete from push_subs where endpoint = ?", endpoint)

}

// TrackChat records a Boodle chat a run opened and has not deleted yet.
func (s *Store) TrackChat(id string, agentID, userID int64) error {

	return s.exec("insert or ignore into chats (id, agent_id, user_id) values (?, ?, ?)", id, agentID, userID)

}

func (s *Store) UntrackChat(id string) error {

	return s.exec("delete from chats where id = ?", id)

}

// TrackedChats lists a user's chats, or one agent's when agentID is not 0.
func (s *Store) TrackedChats(userID, agentID int64) ([]string, error) {

	var filter any

	if agentID != 0 {

		filter = agentID

	}

	rows, err := s.db.Query("select id from chats where user_id = ?1 and (?2 is null or agent_id = ?2)", userID, filter)

	if err != nil {

		return nil, err

	}

	defer rows.Close()

	ids := []string{}

	for rows.Next() {

		var id string

		if err := rows.Scan(&id); err != nil {

			return nil, err

		}

		ids = append(ids, id)

	}

	return ids, rows.Err()

}
