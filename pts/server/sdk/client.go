package sdk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

const defaultBase = "https://box.boodle.ai/api"

const defaultUserAgent = "Mozilla/5.0 (compatible; Boombox/0.1; +https://box.boodle.ai)"

type ClientOptions struct {

	Cookie string

	BaseURL string
	UserAgent string

	HTTPClient *http.Client

}

// APIError puts the status in its message, since callers match "failed: 401" in the text.
type APIError struct {

	Method string
	Path string

	Status int
	StatusText string

	Body string

}

func (e *APIError) Error() string {

	message := fmt.Sprintf("%s %s failed: %d %s", e.Method, e.Path, e.Status, e.StatusText)

	if e.Body != "" {

		message += " — " + e.Body

	}

	return message

}

// StatusOf is the HTTP status behind err, or 0 when it did not come from Boodle.
func StatusOf(err error) int {

	var apiErr *APIError

	if errors.As(err, &apiErr) {

		return apiErr.Status

	}

	return 0

}

type Client struct {

	Session SessionInfo
	BaseURL string

	userAgent string
	http *http.Client

}

func NewClient(options ClientOptions) (*Client, error) {

	session, err := ParseSession(options.Cookie)

	if err != nil {

		return nil, err

	}

	client := &Client{

		Session: session,
		BaseURL: strings.TrimSuffix(options.BaseURL, "/"),

		userAgent: options.UserAgent,
		http: options.HTTPClient,

	}

	if client.BaseURL == "" {

		client.BaseURL = defaultBase

	}

	if client.userAgent == "" {

		client.userAgent = defaultUserAgent

	}

	if client.http == nil {

		client.http = &http.Client{Timeout: 2 * time.Minute}

	}

	return client, nil

}

func (c *Client) UserID() string { return c.Session.UserID }

func (c *Client) PreferredAssistantID() string { return c.Session.PreferredAssistantID }

func (c *Client) WsTicket(ctx context.Context) (string, error) {

	body, err := c.request(ctx, http.MethodGet, "/user/ws-ticket", nil)

	if err != nil {

		return "", err

	}

	return strings.TrimSpace(strings.Trim(string(body), `"`)), nil

}

func (c *Client) CreateChat(ctx context.Context) (Chat, error) {

	var created struct {

		Chat Chat `json:"chat"`

	}

	err := c.requestJSON(ctx, http.MethodPost, "/chat", map[string]any{"knowledgeIds": []string{}}, &created)

	return created.Chat, err

}

func (c *Client) GetChat(ctx context.Context, chatID string) (ChatDetail, error) {

	var detail ChatDetail

	err := c.requestJSON(ctx, http.MethodGet, "/chat/"+chatID, nil, &detail)

	return detail, err

}

func (c *Client) ListChats(ctx context.Context, limit, offset int) (ChatListResponse, error) {

	var list ChatListResponse

	err := c.requestJSON(ctx, http.MethodGet, fmt.Sprintf("/chat/list?limit=%d&offset=%d", limit, offset), nil, &list)

	return list, err

}

func (c *Client) DeleteChat(ctx context.Context, chatID string) error {

	_, err := c.request(ctx, http.MethodDelete, "/chat/"+chatID, nil)

	return err

}

// StopChat cancels an in-flight generation; Boodle answers POST with 405, so it is a DELETE.
func (c *Client) StopChat(ctx context.Context, chatID string) error {

	_, err := c.request(ctx, http.MethodDelete, "/chat/"+chatID+"/stop", nil)

	return err

}

func (c *Client) SendMessage(ctx context.Context, chatID, content string, options SendOptions) (Message, error) {

	assistantID := options.AssistantID

	if assistantID == "" {

		assistantID = c.Session.PreferredAssistantID

	}

	if assistantID == "" {

		return Message{}, errors.New("assistantId required (set preferred-chat-assistant cookie or pass AssistantID)")

	}

	payload := sendRequest{

		Mentions: []any{},

		Message: sendContent{Content: content, Type: "PlainText"},

		AssistantID: assistantID,

	}

	var message Message

	err := c.requestJSON(ctx, http.MethodPost, "/chat/"+chatID+"/message", payload, &message)

	return message, err

}

func (c *Client) ListAssistants(ctx context.Context) ([]AssistantSummary, error) {

	var raw any

	if err := c.requestJSON(ctx, http.MethodGet, "/assistant", nil, &raw); err != nil {

		return nil, err

	}

	return flattenAssistants(raw), nil

}

func (c *Client) ListCustomModels(ctx context.Context) ([]CustomModel, error) {

	var raw any

	if err := c.requestJSON(ctx, http.MethodGet, "/assistant/custom/models", nil, &raw); err != nil {

		return nil, err

	}

	rows, _ := raw.([]any)
	models := []CustomModel{}

	for _, item := range rows {

		obj, ok := item.(map[string]any)

		if !ok {

			continue

		}

		llm := asMeta(obj["llm"])

		if llm == nil {

			llm = asMeta(obj["model"])

		}

		id := firstString(obj["id"], llm["id"])
		name := firstString(obj["name"], llm["name"])

		if id == "" || name == "" {

			continue

		}

		models = append(models, CustomModel{

			ID: id,
			Name: name,

			TaskID: firstString(obj["taskId"], llm["defaultTaskId"]),

			API: firstString(llm["api"]),
			Model: firstString(llm["model"]),

			ContextLength: firstInt(llm["contextLength"]),
			MaxTokens: firstInt(llm["maxTokens"]),

		})

	}

	return models, nil

}

func (c *Client) CreateCustomBot(ctx context.Context, input CustomBotInput) (CustomBotGroup, error) {

	var instructions any

	if input.Instructions != "" {

		instructions = input.Instructions

	}

	payload := map[string]any{

		"allowRemix": false,
		"description": input.Description,
		"instructions": instructions,
		"modelId": input.ModelID,
		"name": input.Name,
		"welcome": nil,

	}

	var group CustomBotGroup

	err := c.requestJSON(ctx, http.MethodPost, "/assistant/custom/draft", payload, &group)

	return group, err

}

func (c *Client) ListCustomBotDrafts(ctx context.Context, limit, offset int) (CustomBotList, error) {

	var list CustomBotList

	err := c.requestJSON(ctx, http.MethodGet, fmt.Sprintf("/assistant/custom/drafts?limit=%d&offset=%d", limit, offset), nil, &list)

	return list, err

}

func (c *Client) PublishCustomBot(ctx context.Context, draftID string) (CustomBotGroup, error) {

	var group CustomBotGroup

	err := c.requestJSON(ctx, http.MethodPost, "/assistant/custom/draft/"+draftID+"/publish", nil, &group)

	return group, err

}

func (c *Client) DeleteCustomBot(ctx context.Context, draftID string) error {

	_, err := c.request(ctx, http.MethodDelete, "/assistant/custom/draft/"+draftID, nil)

	return err

}

// GetUser is Boodle's loose bootstrap: teams, flags, and the person nested as user.user.
func (c *Client) GetUser(ctx context.Context) (map[string]any, error) {

	var bootstrap map[string]any

	err := c.requestJSON(ctx, http.MethodGet, "/user", nil, &bootstrap)

	return bootstrap, err

}

func (c *Client) WsURL(ticket string) string {

	base := "ws" + strings.TrimPrefix(c.BaseURL, "http")

	return base + "/v2/parrot/connect/user/" + c.Session.UserID + "/ticket/" + ticket

}

func (c *Client) ConnectSocket(ctx context.Context) (*Socket, error) {

	ticket, err := c.WsTicket(ctx)

	if err != nil {

		return nil, err

	}

	return DialSocket(ctx, c.WsURL(ticket), c.Session.UserID)

}

func (c *Client) request(ctx context.Context, method, path string, body any) ([]byte, error) {

	var reader io.Reader

	if body != nil {

		encoded, err := json.Marshal(body)

		if err != nil {

			return nil, err

		}

		reader = bytes.NewReader(encoded)

	}

	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, reader)

	if err != nil {

		return nil, err

	}

	req.Header.Set("Cookie", c.Session.Cookie)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Origin", "https://box.boodle.ai")
	req.Header.Set("Referer", "https://box.boodle.ai/")
	req.Header.Set("User-Agent", c.userAgent)

	if body != nil {

		req.Header.Set("Content-Type", "application/json")

	}

	res, err := c.http.Do(req)

	if err != nil {

		return nil, err

	}

	defer res.Body.Close()

	data, err := io.ReadAll(res.Body)

	if res.StatusCode < 200 || res.StatusCode > 299 {

		text := string(data)

		if len(text) > 400 {

			text = text[:400]

		}

		return nil, &APIError{

			Method: method,
			Path: path,

			Status: res.StatusCode,
			StatusText: strings.TrimSpace(strings.TrimPrefix(res.Status, fmt.Sprint(res.StatusCode))),

			Body: text,

		}

	}

	return data, err

}

func (c *Client) requestJSON(ctx context.Context, method, path string, body, out any) error {

	data, err := c.request(ctx, method, path, body)

	if err != nil {

		return err

	}

	if err := json.Unmarshal(data, out); err != nil {

		return fmt.Errorf("%s %s: unexpected response: %w", method, path, err)

	}

	return nil

}

// flattenAssistants walks Boodle's nested catalog and keeps every object that looks like an assistant.
func flattenAssistants(raw any) []AssistantSummary {

	found := []AssistantSummary{}
	seen := map[string]bool{}

	var visit func(node any)

	visit = func(node any) {

		switch value := node.(type) {

		case []any:

			for _, item := range value {

				visit(item)

			}

		case map[string]any:

			id, idOK := value["id"].(string)
			name, nameOK := value["name"].(string)

			if idOK && nameOK && looksLikeAssistant(value) && !seen[id] {

				seen[id] = true

				llm := asMeta(value["llm"])

				if llm == nil {

					llm = asMeta(value["model"])

				}

				found = append(found, AssistantSummary{

					ID: id,
					Name: name,

					Alias: firstString(value["alias"]),
					Description: firstString(value["description"]),

					API: firstString(llm["api"]),
					Model: firstString(llm["model"]),

					ContextLength: firstInt(llm["contextLength"]),
					MaxTokens: firstInt(llm["maxTokens"]),

				})

			}

			keys := make([]string, 0, len(value))

			for key := range value {

				keys = append(keys, key)

			}

			sort.Strings(keys)

			for _, key := range keys {

				visit(value[key])

			}

		}

	}

	visit(raw)

	return found

}

func looksLikeAssistant(obj map[string]any) bool {

	for _, key := range []string{"alias", "displayCategory", "assistantType", "welcome"} {

		if _, ok := obj[key]; ok {

			return true

		}

	}

	return false

}

func asMeta(value any) map[string]any {

	meta, _ := value.(map[string]any)

	return meta

}

func firstString(values ...any) string {

	for _, value := range values {

		if text, ok := value.(string); ok {

			return text

		}

	}

	return ""

}

func firstInt(value any) int {

	number, _ := value.(float64)

	return int(number)

}
