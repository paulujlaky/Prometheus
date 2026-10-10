package browser

import (
	"context"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/chromedp/cdproto/input"
)

type keyDefinition struct {

	key string
	code string
	keyCode int64

	text string
	shiftKey string

	location int64

}

// named keys from the US layout; letters, digits and punctuation are worked out in keyFor
var namedKeys = map[string]keyDefinition{

	"Enter": {key: "Enter", code: "Enter", keyCode: 13, text: "\r"},
	"Tab": {key: "Tab", code: "Tab", keyCode: 9},
	"Backspace": {key: "Backspace", code: "Backspace", keyCode: 8},
	"Escape": {key: "Escape", code: "Escape", keyCode: 27},
	"Delete": {key: "Delete", code: "Delete", keyCode: 46},
	"Insert": {key: "Insert", code: "Insert", keyCode: 45},
	"Space": {key: " ", code: "Space", keyCode: 32, text: " "},
	"ArrowUp": {key: "ArrowUp", code: "ArrowUp", keyCode: 38},
	"ArrowDown": {key: "ArrowDown", code: "ArrowDown", keyCode: 40},
	"ArrowLeft": {key: "ArrowLeft", code: "ArrowLeft", keyCode: 37},
	"ArrowRight": {key: "ArrowRight", code: "ArrowRight", keyCode: 39},
	"Home": {key: "Home", code: "Home", keyCode: 36},
	"End": {key: "End", code: "End", keyCode: 35},
	"PageUp": {key: "PageUp", code: "PageUp", keyCode: 33},
	"PageDown": {key: "PageDown", code: "PageDown", keyCode: 34},
	"Shift": {key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1},
	"Control": {key: "Control", code: "ControlLeft", keyCode: 17, location: 1},
	"Alt": {key: "Alt", code: "AltLeft", keyCode: 18, location: 1},
	"Meta": {key: "Meta", code: "MetaLeft", keyCode: 91, location: 1},
	"CapsLock": {key: "CapsLock", code: "CapsLock", keyCode: 20},

}

var punctuation = map[rune]keyDefinition{

	'`': {code: "Backquote", keyCode: 192, shiftKey: "~"},
	'-': {code: "Minus", keyCode: 189, shiftKey: "_"},
	'=': {code: "Equal", keyCode: 187, shiftKey: "+"},
	'[': {code: "BracketLeft", keyCode: 219, shiftKey: "{"},
	']': {code: "BracketRight", keyCode: 221, shiftKey: "}"},
	'\\': {code: "Backslash", keyCode: 220, shiftKey: "|"},
	';': {code: "Semicolon", keyCode: 186, shiftKey: ":"},
	'\'': {code: "Quote", keyCode: 222, shiftKey: "\""},
	',': {code: "Comma", keyCode: 188, shiftKey: "<"},
	'.': {code: "Period", keyCode: 190, shiftKey: ">"},
	'/': {code: "Slash", keyCode: 191, shiftKey: "?"},

}

var shiftedDigits = ")!@#$%^&*("

// aliases the model and the PWA reach for
var keyAliases = map[string]string{

	"return": "Enter",
	"esc": "Escape",
	"del": "Delete",
	"ctrl": "Control",
	"control": "Control",
	"cmd": "Meta",
	"command": "Meta",
	"meta": "Meta",
	"option": "Alt",
	"alt": "Alt",
	"shift": "Shift",
	"up": "ArrowUp",
	"down": "ArrowDown",
	"left": "ArrowLeft",
	"right": "ArrowRight",
	" ": "Space",

}

func keyFor(name string) (keyDefinition, error) {

	if alias, ok := keyAliases[strings.ToLower(name)]; ok {

		name = alias

	}

	for named, definition := range namedKeys {

		if strings.EqualFold(named, name) {

			return definition, nil

		}

	}

	if len(name) >= 2 && (name[0] == 'F' || name[0] == 'f') {

		var n int

		if _, err := fmt.Sscanf(name[1:], "%d", &n); err == nil && n >= 1 && n <= 12 {

			return keyDefinition{key: fmt.Sprintf("F%d", n), code: fmt.Sprintf("F%d", n), keyCode: int64(111 + n)}, nil

		}

	}

	if utf8.RuneCountInString(name) != 1 {

		return keyDefinition{}, fmt.Errorf("Unknown key: %q", name)

	}

	char, _ := utf8.DecodeRuneInString(name)

	switch {

	case char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z':

		upper := unicode.ToUpper(char)

		return keyDefinition{key: string(char), code: "Key" + string(upper), keyCode: int64(upper), text: string(char), shiftKey: string(upper)}, nil

	case char >= '0' && char <= '9':

		return keyDefinition{key: string(char), code: "Digit" + string(char), keyCode: int64(char), text: string(char), shiftKey: string(shiftedDigits[char-'0'])}, nil

	}

	if definition, ok := punctuation[char]; ok {

		definition.key = string(char)
		definition.text = string(char)

		return definition, nil

	}

	return keyDefinition{key: string(char), text: string(char)}, nil

}

const (
	modAlt = 1
	modControl = 2
	modMeta = 4
	modShift = 8
)

func modifierBit(key string) int64 {

	switch key {

	case "Alt":

		return modAlt

	case "Control":

		return modControl

	case "Meta":

		return modMeta

	case "Shift":

		return modShift

	}

	return 0

}

// pressKey presses a key like Enter, or a chord like Control+A, the way Playwright's keyboard.press does.
func pressKey(ctx context.Context, s *session, chord string) error {

	parts := strings.Split(chord, "+")

	// "Control++" means Control and the plus key
	if strings.HasSuffix(chord, "++") {

		parts = append(strings.Split(strings.TrimSuffix(chord, "++"), "+"), "+")

	}

	keys := make([]keyDefinition, 0, len(parts))

	for _, part := range parts {

		definition, err := keyFor(strings.TrimSpace(part))

		if err != nil {

			return err

		}

		keys = append(keys, definition)

	}

	var modifiers int64

	for _, held := range keys[:len(keys)-1] {

		modifiers |= modifierBit(held.key)

		if err := dispatchKey(ctx, s, input.DispatchKeyEventTypeKeyDown, held, modifiers); err != nil {

			return err

		}

	}

	last := keys[len(keys)-1]

	if modifiers&modShift != 0 && last.shiftKey != "" {

		last.key = last.shiftKey
		last.text = last.shiftKey

	}

	if err := dispatchKey(ctx, s, input.DispatchKeyEventTypeKeyDown, last, modifiers|modifierBit(last.key)); err != nil {

		return err

	}

	if err := dispatchKey(ctx, s, input.DispatchKeyEventTypeKeyUp, last, modifiers); err != nil {

		return err

	}

	for i := len(keys) - 2; i >= 0; i-- {

		modifiers &^= modifierBit(keys[i].key)

		if err := dispatchKey(ctx, s, input.DispatchKeyEventTypeKeyUp, keys[i], modifiers); err != nil {

			return err

		}

	}

	return nil

}

func dispatchKey(ctx context.Context, s *session, kind input.DispatchKeyEventType, definition keyDefinition, modifiers int64) error {

	text := definition.text

	// a chord with Control or Meta types nothing, as in Chrome
	if modifiers&(modControl|modMeta) != 0 {

		text = ""

	}

	if kind == input.DispatchKeyEventTypeKeyDown && text == "" {

		kind = input.DispatchKeyEventTypeRawKeyDown

	}

	params := input.DispatchKeyEventParams{

		Type: kind,
		Modifiers: modifiers,

		Key: definition.key,
		Code: definition.code,
		WindowsVirtualKeyCode: definition.keyCode,
		Location: definition.location,

	}

	if kind != input.DispatchKeyEventTypeKeyUp {

		params.Text = text
		params.UnmodifiedText = text

	}

	_, err := call(ctx, s, input.DispatchKeyEvent, params)

	return err

}
