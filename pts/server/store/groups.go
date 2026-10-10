package store

import (
	"database/sql"
	"errors"
	"strconv"
	"strings"
)

// GroupMessage's Author is "user", "system" or the agent's name; AgentID is set only for agents, and group 0 is Everyone.
type GroupMessage struct {

	ID int64 `json:"id"`
	GroupID int64 `json:"groupId"`

	Author string `json:"author"`
	AgentID *int64 `json:"agentId"`

	Text string `json:"text"`

	At int64 `json:"at"`

}

// GroupChat is a thread with some of the agents; its name defaults to theirs, joined.
type GroupChat struct {

	ID int64 `json:"id"`
	Name string `json:"name"`
	Members []int64 `json:"members"`

	CreatedAt int64 `json:"createdAt"`

}

const groupMessageColumns = "id, group_id, author, agent_id, text, at"

const groupChats = "select g.id, g.name, g.created_at, group_concat(m.agent_id) from group_chats g left join group_members m on m.group_id = g.id where g.user_id = ?"

func scanGroupChat(row interface{ Scan(...any) error }) (*GroupChat, error) {

	var group GroupChat
	var members sql.NullString

	err := row.Scan(&group.ID, &group.Name, &group.CreatedAt, &members)

	if errors.Is(err, sql.ErrNoRows) {

		return nil, ErrNotFound

	}

	if err != nil {

		return nil, err

	}

	group.Members = []int64{}

	if members.Valid && members.String != "" {

		for _, part := range strings.Split(members.String, ",") {

			id, _ := strconv.ParseInt(part, 10, 64)
			group.Members = append(group.Members, id)

		}

	}

	return &group, nil

}

// AddGroupMessage records a thread message; agentID 0 means it is not from an agent.
func (s *Store) AddGroupMessage(userID, groupID int64, author string, agentID int64, text string) (GroupMessage, error) {

	message := GroupMessage{GroupID: groupID, Author: author, Text: text, At: now()}

	var agent any

	if agentID != 0 {

		message.AgentID = &agentID
		agent = agentID

	}

	err := s.db.QueryRow("insert into group_messages (user_id, group_id, author, agent_id, text, at) values (?, ?, ?, ?, ?, ?) returning id", userID, groupID, author, agent, text, message.At).Scan(&message.ID)

	return message, err

}

// ListGroupMessages is the newest limit messages before before, oldest first.
func (s *Store) ListGroupMessages(userID, groupID int64, limit int, before int64) ([]GroupMessage, error) {

	rows, err := s.db.Query("select * from (select "+groupMessageColumns+" from group_messages where user_id = ? and group_id = ? and id < ? order by id desc limit ?) order by id", userID, groupID, before, limit)

	if err != nil {

		return nil, err

	}

	defer rows.Close()

	messages := []GroupMessage{}

	for rows.Next() {

		var message GroupMessage
		var agentID sql.NullInt64

		if err := rows.Scan(&message.ID, &message.GroupID, &message.Author, &agentID, &message.Text, &message.At); err != nil {

			return nil, err

		}

		if agentID.Valid {

			message.AgentID = &agentID.Int64

		}

		messages = append(messages, message)

	}

	return messages, rows.Err()

}

func (s *Store) CreateGroupChat(userID int64, groupName string, members []int64) (*GroupChat, error) {

	var id int64

	if err := s.db.QueryRow("insert into group_chats (user_id, name, created_at) values (?, ?, ?) returning id", userID, groupName, now()).Scan(&id); err != nil {

		return nil, err

	}

	for _, agentID := range members {

		if err := s.exec("insert or ignore into group_members (group_id, agent_id) values (?, ?)", id, agentID); err != nil {

			return nil, err

		}

	}

	return s.GetGroupChat(userID, id)

}

func (s *Store) GetGroupChat(userID, id int64) (*GroupChat, error) {

	return scanGroupChat(s.db.QueryRow(groupChats+" and g.id = ? group by g.id", userID, id))

}

func (s *Store) ListGroupChats(userID int64) ([]GroupChat, error) {

	rows, err := s.db.Query(groupChats+" group by g.id order by g.id", userID)

	if err != nil {

		return nil, err

	}

	defer rows.Close()

	groups := []GroupChat{}

	for rows.Next() {

		group, err := scanGroupChat(rows)

		if err != nil {

			return nil, err

		}

		groups = append(groups, *group)

	}

	return groups, rows.Err()

}

func (s *Store) DeleteGroupChat(userID, id int64) error {

	if err := s.exec("delete from group_chats where user_id = ? and id = ?", userID, id); err != nil {

		return err

	}

	if err := s.exec("delete from group_messages where user_id = ? and group_id = ?", userID, id); err != nil {

		return err

	}

	return s.exec("delete from settings where user_id = ? and key = ?", userID, "read:group:"+itoa(id))

}
