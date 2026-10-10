package browser

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/chromedp/cdproto/accessibility"
	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/cdp/jsonv2"
	"github.com/chromedp/cdproto/dom"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
)

// refs names elements e1, e2, ... and keeps a name for as long as its element lives, so refs only change where the page did.
type refs struct {

	byNode map[cdp.BackendNodeID]string
	byRef map[string]cdp.BackendNodeID
	next int

}

func (r *refs) reset() {

	r.byNode = nil
	r.byRef = nil
	r.next = 0

}

func (r *refs) of(node cdp.BackendNodeID) string {

	if r.byNode == nil {

		r.byNode = map[cdp.BackendNodeID]string{}
		r.byRef = map[string]cdp.BackendNodeID{}

	}

	if ref, ok := r.byNode[node]; ok {

		return ref

	}

	r.next++
	ref := "e" + strconv.Itoa(r.next)
	r.byNode[node] = ref
	r.byRef[ref] = node

	return ref

}

// item is one line of the outline and the lines under it.
type item struct {

	text string
	isText bool

	role string
	name string
	props []string
	ref string
	value string
	url string

	children []item

}

// containers that only add noise unless they are named; their children take their place
var transparent = map[string]bool{"generic": true, "none": true, "presentation": true, "genericcontainer": true, "labeltext": true, "section": true, "div": true}

// pieces of text Chrome keeps that a reader never sees as their own line
var skipped = map[string]bool{"inlinetextbox": true, "linebreak": true, "listmarker": true}

// roles whose value is what the user typed or picked
var valued = map[string]bool{"textbox": true, "searchbox": true, "combobox": true, "spinbutton": true, "slider": true}

func axString(value *accessibility.Value) string {

	if value == nil || len(value.Value) == 0 {

		return ""

	}

	var decoded any

	if jsonv2.Unmarshal(value.Value, &decoded) != nil {

		return ""

	}

	switch v := decoded.(type) {

	case string:

		return v

	case float64:

		return strconv.FormatFloat(v, 'f', -1, 64)

	case bool:

		return strconv.FormatBool(v)

	}

	return ""

}

func collapse(text string) string {

	return strings.Join(strings.Fields(text), " ")

}

func clipText(text string, limit int) string {

	if utf8.RuneCountInString(text) <= limit {

		return text

	}

	return string([]rune(text)[:limit]) + "…"

}

func roleOf(node *accessibility.Node) string {

	role := strings.ToLower(axString(node.Role))

	switch role {

	case "image":

		return "img"

	case "rootwebarea", "webarea":

		return "document"

	}

	return role

}

type tree struct {

	nodes map[accessibility.NodeID]*accessibility.Node
	root *accessibility.Node

}

func newTree(nodes []*accessibility.Node) *tree {

	t := &tree{nodes: map[accessibility.NodeID]*accessibility.Node{}}

	for _, node := range nodes {

		t.nodes[node.NodeID] = node

		if t.root == nil && node.ParentID == "" {

			t.root = node

		}

	}

	return t

}

type renderer struct {

	refs *refs

	// frames maps an iframe element to the outline of the document inside it
	frames map[cdp.BackendNodeID]*tree

}

func (r *renderer) build(t *tree, node *accessibility.Node, depth int) []item {

	if node == nil || depth > 200 {

		return nil

	}

	kids := []item{}

	for _, id := range node.ChildIDs {

		kids = append(kids, r.build(t, t.nodes[id], depth+1)...)

	}

	if inner := r.frames[node.BackendDOMNodeID]; inner != nil && node.BackendDOMNodeID != 0 {

		kids = append(kids, r.build(inner, inner.root, depth+1)...)

	}

	kids = mergeText(kids)

	if node.Ignored {

		return kids

	}

	role := roleOf(node)
	name := collapse(axString(node.Name))

	switch {

	case role == "statictext":

		if name == "" {

			return nil

		}

		return []item{{isText: true, text: name}}

	case skipped[role]:

		return nil

	case role == "document":

		return kids

	case transparent[role] && name == "":

		return kids

	}

	built := item{role: role, name: clipText(name, 300), children: kids}

	if node.BackendDOMNodeID != 0 {

		built.ref = r.refs.of(node.BackendDOMNodeID)

	}

	for _, property := range node.Properties {

		value := axString(property.Value)

		switch property.Name {

		case accessibility.PropertyNameLevel:

			built.props = append(built.props, "level="+value)

		case accessibility.PropertyNameChecked:

			if value == "true" {

				built.props = append(built.props, "checked")

			} else if value == "mixed" {

				built.props = append(built.props, "checked=mixed")

			}

		case accessibility.PropertyNamePressed:

			if value == "true" || value == "mixed" {

				built.props = append(built.props, "pressed")

			}

		case accessibility.PropertyNameDisabled, accessibility.PropertyNameExpanded, accessibility.PropertyNameSelected:

			if value == "true" {

				built.props = append(built.props, string(property.Name))

			}

		case accessibility.PropertyNameFocused:

			if value == "true" {

				built.props = append(built.props, "active")

			}

		case accessibility.PropertyNameURL:

			if role == "link" {

				built.url = value

			}

		}

	}

	if valued[role] {

		built.value = clipText(collapse(axString(node.Value)), 300)

	}

	// a heading's or a button's text is already its name
	if text := joinedText(kids); text != "" && text == name {

		built.children = nil

	}

	return []item{built}

}

func mergeText(items []item) []item {

	merged := []item{}

	for _, next := range items {

		if last := len(merged) - 1; last >= 0 && next.isText && merged[last].isText {

			merged[last].text += " " + next.text

			continue

		}

		merged = append(merged, next)

	}

	return merged

}

func joinedText(items []item) string {

	parts := []string{}

	for _, child := range items {

		if !child.isText {

			return ""

		}

		parts = append(parts, child.text)

	}

	return strings.Join(parts, " ")

}

func write(out *strings.Builder, items []item, indent int) {

	pad := strings.Repeat("  ", indent)

	for _, one := range items {

		if one.isText {

			fmt.Fprintf(out, "%s- text: %s\n", pad, clipText(one.text, 1000))

			continue

		}

		head := pad + "- " + one.role

		if one.name != "" {

			head += " " + strconv.Quote(one.name)

		}

		for _, prop := range one.props {

			head += " [" + prop + "]"

		}

		if one.ref != "" {

			head += " [ref=" + one.ref + "]"

		}

		children := one.children

		switch {

		case one.url == "" && len(children) == 0 && one.value != "":

			out.WriteString(head + ": " + one.value + "\n")

		case one.url == "" && len(children) == 1 && children[0].isText:

			out.WriteString(head + ": " + clipText(children[0].text, 1000) + "\n")

		case one.url == "" && len(children) == 0:

			out.WriteString(head + "\n")

		default:

			out.WriteString(head + ":\n")

			if one.url != "" {

				out.WriteString(pad + "  - /url: " + one.url + "\n")

			}

			write(out, children, indent+1)

		}

	}

}

// childFrames walks the frame tree below the main frame.
func childFrames(tree *page.FrameTree, out *[]cdp.FrameID) {

	if tree == nil {

		return

	}

	for _, child := range tree.ChildFrames {

		if child.Frame != nil {

			*out = append(*out, child.Frame.ID)

		}

		childFrames(child, out)

	}

}

// outline is the page as an outline of its elements, from Chrome's own accessibility tree, each element with a ref.
func (p *tabPage) outline(ctx context.Context) (string, error) {

	full, err := call(ctx, p.s, accessibility.GetFullAXTree, accessibility.GetFullAXTreeParams{})

	if err != nil {

		return "", err

	}

	frames := map[cdp.BackendNodeID]*tree{}

	if frameTree, err := call(ctx, p.s, page.GetFrameTree, cdp.Empty{}); err == nil {

		var ids []cdp.FrameID

		childFrames(frameTree.FrameTree, &ids)

		// a cross-site frame runs in its own process, which this session cannot read; it shows as an empty iframe
		for _, id := range ids {

			inner, err := call(ctx, p.s, accessibility.GetFullAXTree, accessibility.GetFullAXTreeParams{FrameID: id})

			if err != nil {

				continue

			}

			owner, err := call(ctx, p.s, dom.GetFrameOwner, dom.GetFrameOwnerParams{FrameID: id})

			if err != nil || owner.BackendNodeID == 0 {

				continue

			}

			frames[owner.BackendNodeID] = newTree(inner.Nodes)

		}

	}

	p.mu.Lock()
	defer p.mu.Unlock()

	main := newTree(full.Nodes)
	r := &renderer{refs: &p.snapshot, frames: frames}

	var out strings.Builder

	write(&out, r.build(main, main.root, 0), 0)

	return strings.TrimRight(out.String(), "\n"), nil

}

func (p *tabPage) nodeOf(ref string) (cdp.BackendNodeID, bool) {

	p.mu.Lock()
	defer p.mu.Unlock()

	node, ok := p.snapshot.byRef[ref]

	return node, ok

}

// callOn runs a function with the element as this, and decodes what it returns.
func callOn[T any](ctx context.Context, p *tabPage, object runtime.RemoteObjectID, function string, args ...any) (T, error) {

	var value T

	arguments := make([]*runtime.CallArgument, len(args))

	for i, arg := range args {

		encoded, err := jsonv2.Marshal(arg)

		if err != nil {

			return value, err

		}

		arguments[i] = &runtime.CallArgument{Value: encoded}

	}

	result, err := call(ctx, p.s, runtime.CallFunctionOn, runtime.CallFunctionOnParams{FunctionDeclaration: function, ObjectID: object, Arguments: arguments, ReturnByValue: yes(), AwaitPromise: yes()})

	if err != nil {

		return value, err

	}

	if result.ExceptionDetails != nil {

		return value, fmt.Errorf("%s", exceptionText(result.ExceptionDetails))

	}

	if result.Result != nil && len(result.Result.Value) > 0 {

		err = jsonv2.Unmarshal(result.Result.Value, &value)

	}

	return value, err

}

// element is the live object for a ref, or ok false when the page dropped it.
func (p *tabPage) element(ctx context.Context, ref string) (runtime.RemoteObjectID, bool) {

	node, known := p.nodeOf(ref)

	if !known {

		return "", false

	}

	resolved, err := call(ctx, p.s, dom.ResolveNode, dom.ResolveNodeParams{BackendNodeID: node, ObjectGroup: "pts"})

	if err != nil || resolved.Object == nil {

		return "", false

	}

	connected, err := callOn[bool](ctx, p, resolved.Object.ObjectID, "function () { return this.isConnected; }")

	return resolved.Object.ObjectID, err == nil && connected

}

func (p *tabPage) present(ctx context.Context, ref string) bool {

	_, ok := p.element(ctx, ref)

	return ok

}

const clickCheck = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement;
  if (!element || !element.isConnected) return "gone";
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return "hidden";
  if (element.disabled === true || element.getAttribute("aria-disabled") === "true") return "disabled";
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  return "ok";
}`

const hitCheck = `function (x, y) {
  try {
    if (window.top !== window) return true;
  } catch (e) {
    return true;
  }
  let hit = document.elementFromPoint(x, y);
  while (hit) {
    if (hit === this || this.contains(hit)) return true;
    hit = hit.parentNode || hit.host;
  }
  return false;
}`

// clickRef waits, as Playwright did, for the element to be visible, enabled and the one under the point, then clicks its middle.
func (p *tabPage) clickRef(ctx context.Context, ref string, limit time.Duration) error {

	deadline := time.Now().Add(limit)
	why := "is not visible"

	for {

		object, ok := p.element(ctx, ref)

		if !ok {

			return errGone

		}

		state, err := callOn[string](ctx, p, object, clickCheck)

		if err != nil {

			return err

		}

		switch state {

		case "gone":

			return errGone

		case "hidden":

			why = "is not visible"

		case "disabled":

			why = "is not enabled"

		default:

			x, y, found := p.middle(ctx, object)

			if !found {

				why = "is not visible"

				break

			}

			hit, err := callOn[bool](ctx, p, object, hitCheck, x, y)

			if err == nil && !hit {

				why = "is covered by another element"

				break

			}

			return p.click(ctx, x, y)

		}

		if time.Now().After(deadline) {

			return &timeoutError{message: fmt.Sprintf("Timeout %dms exceeded: %s %s", limit.Milliseconds(), ref, why)}

		}

		select {

		case <-time.After(100 * time.Millisecond):

		case <-ctx.Done():

			return ctx.Err()

		}

	}

}

// middle is the centre of the element's largest box, in the page's viewport.
func (p *tabPage) middle(ctx context.Context, object runtime.RemoteObjectID) (float64, float64, bool) {

	quads, err := call(ctx, p.s, dom.GetContentQuads, dom.GetContentQuadsParams{ObjectID: object})

	if err != nil {

		return 0, 0, false

	}

	best := 0.0
	x, y := 0.0, 0.0

	for _, quad := range quads.Quads {

		if len(quad) != 8 {

			continue

		}

		area := 0.0

		for i := 0; i < 8; i += 2 {

			j := (i + 2) % 8
			area += quad[i]*quad[j+1] - quad[j]*quad[i+1]

		}

		if area = area / 2; area < 0 {

			area = -area

		}

		if area > best {

			best = area
			x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
			y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4

		}

	}

	return x, y, best > 1

}

const fillPrepare = `function (value) {
  let element = this.nodeType === 1 ? this : this.parentElement;
  if (element instanceof HTMLLabelElement && element.control) element = element.control;
  if (!element || !element.isConnected) return "gone";
  if (element instanceof HTMLInputElement) {
    const type = (element.type || "text").toLowerCase();
    if (["checkbox", "radio", "file", "button", "submit", "reset", "image", "hidden", "range", "color"].includes(type)) return "error:Input of type \"" + type + "\" cannot be filled";
    if (element.disabled || element.readOnly) return "error:Element is not editable";
    if (["date", "time", "datetime-local", "month", "week"].includes(type)) {
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return "done";
    }
    element.focus();
    element.select();
    return "type";
  }
  if (element instanceof HTMLTextAreaElement) {
    if (element.disabled || element.readOnly) return "error:Element is not editable";
    element.focus();
    element.select();
    return "type";
  }
  if (element.isContentEditable) {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return "type";
  }
  return "error:Element is not an <input>, <textarea> or [contenteditable] element";
}`

// fillRef replaces a field's text the way Playwright's fill did: select it all, then insert, or delete for empty text.
func (p *tabPage) fillRef(ctx context.Context, ref, text string, limit time.Duration) error {

	deadline := time.Now().Add(limit)

	for {

		object, ok := p.element(ctx, ref)

		if !ok {

			return errGone

		}

		state, err := callOn[string](ctx, p, object, fillPrepare, text)

		if err != nil {

			return err

		}

		switch {

		case state == "gone":

			return errGone

		case state == "done":

			return nil

		case strings.HasPrefix(state, "error:"):

			message := strings.TrimPrefix(state, "error:")

			if time.Now().After(deadline) || !strings.Contains(message, "editable") {

				return fmt.Errorf("%s", message)

			}

		case text == "":

			return pressKey(ctx, p.s, "Delete")

		default:

			return p.insertText(ctx, text)

		}

		select {

		case <-time.After(100 * time.Millisecond):

		case <-ctx.Done():

			return ctx.Err()

		}

	}

}
