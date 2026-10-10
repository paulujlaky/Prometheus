package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"boombox/store"
)

// httpError carries the status a failure answers with; any other error is a 400.
type httpError struct {

	status int
	message string

}

func (e *httpError) Error() string { return e.message }

func failWith(status int, message string) error {

	return &httpError{status: status, message: message}

}

func writeJSON(w http.ResponseWriter, status int, body any) {

	w.Header().Set("Content-Type", "application/json;charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)

}

func ok(w http.ResponseWriter) error {

	writeJSON(w, http.StatusOK, map[string]any{"ok": true})

	return nil

}

const sessionCookie = "pts_session"

func setSession(w http.ResponseWriter, value string, age int) {

	w.Header().Set("Set-Cookie", fmt.Sprintf("%s=%s; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=%d", sessionCookie, value, age))

}

// input is a decoded JSON body; its getters fail with the messages the PWA shows.
type input map[string]any

func readBody(r *http.Request) (input, error) {

	var body input

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body == nil {

		return nil, failWith(400, "Expected a JSON body")

	}

	return body, nil

}

func (in input) text(field string) (string, error) {

	value, ok := in[field].(string)

	if !ok {

		return "", failWith(400, field+" must be a string")

	}

	return value, nil

}

func (in input) optional(field string) (*string, error) {

	raw, present := in[field]

	if !present || raw == nil {

		return nil, nil

	}

	value, ok := raw.(string)

	if !ok {

		return nil, failWith(400, field+" must be a string")

	}

	return &value, nil

}

func (in input) filled(field string) (string, error) {

	value, err := in.text(field)

	if err != nil {

		return "", err

	}

	if value = strings.TrimSpace(value); value == "" {

		return "", failWith(400, field+" is empty")

	}

	return value, nil

}

// number reads a JSON number or numeric string, as JS's Number() would; ok is false for anything else.
func number(value any) (float64, bool) {

	switch v := value.(type) {

	case nil:

		return 0, true

	case float64:

		return v, true

	case string:

		if strings.TrimSpace(v) == "" {

			return 0, true

		}

		parsed, err := strconv.ParseFloat(strings.TrimSpace(v), 64)

		return parsed, err == nil

	case bool:

		if v {

			return 1, true

		}

		return 0, true

	}

	return 0, false

}

func integer(value any) (int64, bool) {

	n, ok := number(value)

	if !ok || n != math.Trunc(n) || math.IsInf(n, 0) {

		return 0, false

	}

	return int64(n), true

}

// page reads a page of history scrolling upward: limit items before before.
func page(r *http.Request) (int, int64) {

	limit := 200
	before := int64(store.Newest)

	if raw := r.URL.Query().Get("limit"); raw != "" {

		if parsed, err := strconv.Atoi(raw); err == nil {

			limit = parsed

		}

	}

	if raw := r.URL.Query().Get("before"); raw != "" {

		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil {

			before = parsed

		}

	}

	return min(500, limit), before

}

// errorStatus is what a failure answers with: its own status, else 400.
func errorStatus(err error) (int, string) {

	var known *httpError

	if errors.As(err, &known) {

		return known.status, known.message

	}

	return http.StatusBadRequest, err.Error()

}
