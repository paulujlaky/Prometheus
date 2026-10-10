package store

import (
	"database/sql"
	"errors"
)

// Routine is a schedule on a cron spec, or a watch that checks Target every Spec minutes and runs only when it changes.
type Routine struct {

	ID int64 `json:"id"`
	AgentID int64 `json:"agentId"`

	Kind string `json:"kind"`
	Spec string `json:"spec"`
	Target string `json:"target"`

	Title string `json:"title"`
	Task string `json:"task"`

	Enabled bool `json:"enabled"`

	LastOutput *string `json:"lastOutput"`
	LastAt *int64 `json:"lastAt"`

}

type RoutineInput struct {

	Kind string
	Spec string
	Target string

	Title string
	Task string

}

// RoutineChanges leaves a field alone when it is nil.
type RoutineChanges struct {

	Spec *string
	Target *string
	Task *string

	Enabled *bool

}

const routineColumns = "select id, agent_id, kind, spec, target, title, task, enabled = 1, last_output, last_at from routines"

func scanRoutine(row interface{ Scan(...any) error }) (*Routine, error) {

	var routine Routine
	var output sql.NullString
	var at sql.NullInt64

	err := row.Scan(&routine.ID, &routine.AgentID, &routine.Kind, &routine.Spec, &routine.Target, &routine.Title, &routine.Task, &routine.Enabled, &output, &at)

	if errors.Is(err, sql.ErrNoRows) {

		return nil, ErrNotFound

	}

	if err != nil {

		return nil, err

	}

	if output.Valid {

		routine.LastOutput = &output.String

	}

	if at.Valid {

		routine.LastAt = &at.Int64

	}

	return &routine, nil

}

// ListRoutines lists one agent's routines, or everyone's when agentID is 0.
func (s *Store) ListRoutines(agentID int64) ([]Routine, error) {

	var filter any

	if agentID != 0 {

		filter = agentID

	}

	rows, err := s.db.Query(routineColumns+" where ?1 is null or agent_id = ?1 order by id", filter)

	if err != nil {

		return nil, err

	}

	defer rows.Close()

	routines := []Routine{}

	for rows.Next() {

		routine, err := scanRoutine(rows)

		if err != nil {

			return nil, err

		}

		routines = append(routines, *routine)

	}

	return routines, rows.Err()

}

func (s *Store) GetRoutine(id int64) (*Routine, error) {

	return scanRoutine(s.db.QueryRow(routineColumns+" where id = ?", id))

}

func (s *Store) CreateRoutine(agentID int64, input RoutineInput) (*Routine, error) {

	var id int64

	err := s.db.QueryRow("insert into routines (agent_id, kind, spec, target, title, task) values (?, ?, ?, ?, ?, ?) returning id", agentID, input.Kind, input.Spec, input.Target, input.Title, input.Task).Scan(&id)

	if err != nil {

		return nil, err

	}

	return s.GetRoutine(id)

}

// UpdateRoutine starts a watch over when its spec or target changes, so the next check sets a fresh baseline instead of waking the agent.
func (s *Store) UpdateRoutine(id int64, changes RoutineChanges) error {

	value := func(field *string) any {

		if field == nil {

			return nil

		}

		return *field

	}

	var enabled any

	if changes.Enabled != nil {

		enabled = 0

		if *changes.Enabled {

			enabled = 1

		}

	}

	restart := 0

	if changes.Spec != nil || changes.Target != nil {

		restart = 1

	}

	return s.exec(`
  update routines set
    spec = coalesce(?, spec),
    target = coalesce(?, target),
    task = coalesce(?, task),
    enabled = coalesce(?, enabled),
    last_output = case when ? then null else last_output end
  where id = ?
`, value(changes.Spec), value(changes.Target), value(changes.Task), enabled, restart, id)

}

// MarkRoutine records a check or a firing; a nil output keeps the last one.
func (s *Store) MarkRoutine(id int64, lastOutput *string, lastAt int64) error {

	var output any

	if lastOutput != nil {

		output = *lastOutput

	}

	return s.exec("update routines set last_output = coalesce(?, last_output), last_at = ? where id = ?", output, lastAt, id)

}

func (s *Store) DeleteRoutine(id int64) error {

	return s.exec("delete from routines where id = ?", id)

}
