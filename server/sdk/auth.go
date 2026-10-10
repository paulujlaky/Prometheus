package sdk

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
)

// SessionInfo is what a Boodle browser cookie says about its owner.
type SessionInfo struct {

	UserID string
	OrgID string
	PreferredAssistantID string

	Cookie string

}

func parseCookieMap(cookie string) map[string]string {

	values := map[string]string{}

	for _, part := range strings.Split(cookie, ";") {

		trimmed := strings.TrimSpace(part)
		key, value, found := strings.Cut(trimmed, "=")

		if trimmed == "" || !found {

			continue

		}

		values[strings.TrimSpace(key)] = strings.TrimSpace(value)

	}

	return values

}

func decodeJwtPayload(token string) (map[string]any, error) {

	segments := strings.Split(token, ".")

	if len(segments) < 2 {

		return nil, errors.New("Cookie JWT is malformed (expected three segments)")

	}

	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(segments[1], "="))

	if err != nil {

		return nil, errors.New("Cookie JWT payload is not base64")

	}

	var payload map[string]any

	if err := json.Unmarshal(raw, &payload); err != nil {

		return nil, errors.New("Cookie JWT payload is not JSON")

	}

	return payload, nil

}

func unquote(value string) string {

	if decoded, err := url.PathUnescape(value); err == nil {

		value = decoded

	}

	if len(value) >= 2 && strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {

		return value[1 : len(value)-1]

	}

	return value

}

// ParseSession reads the user, team and preferred assistant out of a full browser Cookie header.
func ParseSession(cookie string) (SessionInfo, error) {

	cookie = strings.TrimSpace(cookie)
	cookies := parseCookieMap(cookie)
	token := cookies["d"]

	if token == "" {

		return SessionInfo{}, errors.New(`Cookie must include the "d" JWT (session token)`)

	}

	payload, err := decodeJwtPayload(token)

	if err != nil {

		return SessionInfo{}, err

	}

	userID, _ := payload["userId"].(string)

	if userID == "" {

		return SessionInfo{}, errors.New(`JWT payload missing "userId"`)

	}

	info := SessionInfo{

		UserID: userID,

		Cookie: cookie,

	}

	if team := cookies["teamID"]; team != "" {

		info.OrgID = unquote(team)

	}

	if preferred := cookies["preferred-chat-assistant"]; preferred != "" {

		decoded, err := url.PathUnescape(preferred)

		var parsed struct {

			AssistantID string `json:"assistantId"`

		}

		if err == nil && json.Unmarshal([]byte(decoded), &parsed) == nil {

			info.PreferredAssistantID = parsed.AssistantID

		}

	}

	return info, nil

}
