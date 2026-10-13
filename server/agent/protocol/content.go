package protocol

import (
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strings"
)

func decodeContent(body string, target any) error {

	if len(body) > 65536 {

		return errors.New("JSON blocks are limited to 64 KiB")

	}

	var object map[string]any

	if err := json.Unmarshal([]byte(body), &object); err != nil {

		return err

	}

	if !contentValue(object, 0) {

		return errors.New("Use a JSON object without null values or excessive nesting")

	}

	decoder := json.NewDecoder(strings.NewReader(body))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(target); err != nil {

		return err

	}

	if err := decoder.Decode(new(any)); err != io.EOF {

		return errors.New("Provide one JSON object")

	}

	return nil

}

func contentValue(value any, depth int) bool {

	if value == nil || depth > 16 {

		return false

	}

	switch value := value.(type) {

	case map[string]any:

		if value == nil {

			return false

		}

		for key, item := range value {

			if key != strings.ToLower(key) || !contentValue(item, depth+1) {

				return false

			}

		}

	case []any:

		for _, item := range value {

			if !contentValue(item, depth+1) {

				return false

			}

		}

	}

	return true

}

type AgentSpec struct {

	Name string `json:"name"`
	Instructions string `json:"instructions"`
	Glyph string `json:"glyph,omitempty"`
	Category string `json:"category,omitempty"`
	Task string `json:"task,omitempty"`

}

func ParseAgentSpec(body string) (AgentSpec, error) {

	var spec AgentSpec

	if err := decodeContent(body, &spec); err != nil {

		return spec, err

	}

	spec.Name = strings.TrimSpace(spec.Name)
	spec.Instructions = strings.TrimSpace(spec.Instructions)
	spec.Task = strings.TrimSpace(spec.Task)

	if spec.Name == "" || spec.Instructions == "" {

		return spec, errors.New("create_agent needs name and instructions; glyph, category and task are optional")

	}

	return spec, nil

}

type Card struct {

	Title string `json:"title,omitempty"`
	Icon string `json:"icon,omitempty"`
	Blocks []CardBlock `json:"blocks"`
	Actions []CardAction `json:"actions,omitempty"`
	Fields []CardField `json:"fields,omitempty"`
	Submit string `json:"submit,omitempty"`

}

type CardBlock struct {

	Type string `json:"type"`
	Icon string `json:"icon,omitempty"`
	Text string `json:"text,omitempty"`
	Items []string `json:"items,omitempty"`
	Columns []string `json:"columns,omitempty"`
	Rows [][]string `json:"rows,omitempty"`
	Label string `json:"label,omitempty"`
	Value string `json:"value,omitempty"`
	Detail string `json:"detail,omitempty"`
	URL string `json:"url,omitempty"`
	Alt string `json:"alt,omitempty"`
	Title string `json:"title,omitempty"`
	Blocks []CardBlock `json:"blocks,omitempty"`

}

type CardAction struct {

	Label string `json:"label"`
	Reply string `json:"reply"`
	Icon string `json:"icon,omitempty"`

}

type CardField struct {

	Name string `json:"name"`
	Label string `json:"label"`
	Placeholder string `json:"placeholder,omitempty"`
	Required bool `json:"required,omitempty"`
	Multiline bool `json:"multiline,omitempty"`

}

func webURL(value string) bool {

	parsed, err := url.Parse(value)

	return err == nil && (strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://")) && parsed.Hostname() != "" && parsed.User == nil

}

var iconName = regexp.MustCompile(`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`)

func validIcon(value string) bool {

	return value == "" || (len(value) <= 64 && iconName.MatchString(value))

}

func validateBlocks(blocks []CardBlock, depth int, count *int) error {

	if len(blocks) == 0 || depth > 3 {

		return errors.New("Use nonempty blocks, nested at most three sections deep")

	}

	for _, block := range blocks {

		if !validIcon(block.Icon) {

			return errors.New("icon must be a Lucide name in lowercase kebab-case, at most 64 characters")

		}

		*count++

		if *count > 100 {

			return errors.New("A card supports at most 100 blocks")

		}

		valid := false

		switch block.Type {

		case "text":

			valid = strings.TrimSpace(block.Text) != ""

		case "list":

			valid = len(block.Items) > 0 && len(block.Items) <= 100

		case "table":

			valid = len(block.Columns) > 0 && len(block.Columns) <= 12 && block.Rows != nil && len(block.Rows) <= 100

			for _, row := range block.Rows {

				valid = valid && len(row) == len(block.Columns)

			}

		case "metric":

			valid = strings.TrimSpace(block.Label) != "" && strings.TrimSpace(block.Value) != ""

		case "image":

			valid = webURL(block.URL) && strings.TrimSpace(block.Alt) != ""

		case "link":

			valid = webURL(block.URL) && strings.TrimSpace(block.Label) != ""

		case "section":

			if err := validateBlocks(block.Blocks, depth+1, count); err != nil {

				return err

			}

			valid = true

		}

		if !valid {

			return errors.New("Invalid card block: " + block.Type)

		}

		if block.Type != "section" && block.Blocks != nil {

			return errors.New("Only sections can contain blocks")

		}

	}

	return nil

}

func ParseCard(body string) (Card, error) {

	var card Card

	if err := decodeContent(body, &card); err != nil {

		return card, err

	}

	if !validIcon(card.Icon) {

		return card, errors.New("icon must be a Lucide name in lowercase kebab-case, at most 64 characters")

	}

	count := 0

	if err := validateBlocks(card.Blocks, 0, &count); err != nil {

		return card, err

	}

	if len(card.Actions) > 8 || len(card.Fields) > 12 {

		return card, errors.New("Use at most eight actions and twelve fields")

	}

	for _, action := range card.Actions {

		if strings.TrimSpace(action.Label) == "" || strings.TrimSpace(action.Reply) == "" || !validIcon(action.Icon) {

			return card, errors.New("Each action needs label, reply and an optional lowercase kebab-case Lucide icon")

		}

	}

	names := map[string]bool{}

	for _, field := range card.Fields {

		if strings.TrimSpace(field.Name) == "" || strings.TrimSpace(field.Label) == "" || names[field.Name] {

			return card, errors.New("Each field needs a unique name and a label")

		}

		names[field.Name] = true

	}

	return card, nil

}
