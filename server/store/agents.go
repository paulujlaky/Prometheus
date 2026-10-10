package store

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"

	"boombox/glyph"
)

type Agent struct {

	ID int64
	UserID int64
	Name string

	ModelID string
	Persona string

	BotDraftID string
	BotAssistantID string
	BotHash string

	// Glyph is "shape:color"; Category is the sidebar heading it sits under, empty for none.
	Glyph string
	Category string

	CreatedAt int64

}

const agentColumns = "select id, user_id, name, model_id, persona, coalesce(bot_draft_id, ''), coalesce(bot_assistant_id, ''), coalesce(bot_hash, ''), glyph, category, created_at from agents"

func scanAgent(row interface{ Scan(...any) error }) (*Agent, error) {

	var agent Agent

	err := row.Scan(&agent.ID, &agent.UserID, &agent.Name, &agent.ModelID, &agent.Persona, &agent.BotDraftID, &agent.BotAssistantID, &agent.BotHash, &agent.Glyph, &agent.Category, &agent.CreatedAt)

	if errors.Is(err, sql.ErrNoRows) {

		return nil, ErrNotFound

	}

	if err != nil {

		return nil, err

	}

	return &agent, nil

}

func (s *Store) CreateAgent(userID int64, agentName, modelID, persona string) (*Agent, error) {

	if !name.MatchString(agentName) {

		return nil, errors.New("Agent names start with a letter and use up to 32 letters, digits, spaces, - or _")

	}

	workspace := s.WorkspaceOf(userID, agentName)

	if err := os.MkdirAll(workspace, 0o755); err != nil {

		return nil, err

	}

	// a deleted agent's workspace comes back with its name, and O_EXCL never creates through a link left in it
	if file, err := os.OpenFile(filepath.Join(workspace, "MEMORY.md"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644); err == nil {

		file.Close()

	}

	row := s.db.QueryRow("insert into agents (user_id, name, model_id, persona, glyph, created_at) values (?, ?, ?, ?, ?, ?) returning id", userID, agentName, modelID, persona, glyph.Random(), now())

	var id int64

	if err := row.Scan(&id); err != nil {

		return nil, err

	}

	return s.AgentByID(id)

}

func (s *Store) GetAgent(userID int64, agentName string) (*Agent, error) {

	return scanAgent(s.db.QueryRow(agentColumns+" where user_id = ? and name = ?", userID, agentName))

}

func (s *Store) AgentByID(id int64) (*Agent, error) {

	return scanAgent(s.db.QueryRow(agentColumns+" where id = ?", id))

}

func (s *Store) ListAgents(userID int64) ([]Agent, error) {

	rows, err := s.db.Query(agentColumns+" where user_id = ? order by name", userID)

	if err != nil {

		return nil, err

	}

	defer rows.Close()

	agents := []Agent{}

	for rows.Next() {

		agent, err := scanAgent(rows)

		if err != nil {

			return nil, err

		}

		agents = append(agents, *agent)

	}

	return agents, rows.Err()

}

// AgentChanges leaves a field alone when it is nil.
type AgentChanges struct {

	ModelID *string
	Persona *string
	Glyph *string
	Category *string

}

func (s *Store) UpdateAgent(id int64, changes AgentChanges) error {

	value := func(field *string) any {

		if field == nil {

			return nil

		}

		return *field

	}

	return s.exec("update agents set model_id = coalesce(?, model_id), persona = coalesce(?, persona), glyph = coalesce(?, glyph), category = coalesce(?, category) where id = ?", value(changes.ModelID), value(changes.Persona), value(changes.Glyph), value(changes.Category), id)

}

// DeleteAgent keeps the workspace on disk: an agent's files are worth more than the row that pointed at them.
func (s *Store) DeleteAgent(id int64) error {

	if err := s.exec("delete from agents where id = ?", id); err != nil {

		return err

	}

	return s.exec("delete from settings where key = ?", "read:agent:"+itoa(id))

}

func (s *Store) SaveBot(agentID int64, draftID, assistantID, hash string) error {

	return s.exec("update agents set bot_draft_id = ?, bot_assistant_id = ?, bot_hash = ? where id = ?", draftID, assistantID, hash, agentID)

}
