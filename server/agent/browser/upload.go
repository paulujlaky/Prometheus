package browser

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/chromedp/cdproto/cdp"
	"github.com/chromedp/cdproto/dom"
	"github.com/chromedp/cdproto/input"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
)

// fileField is the file input behind an element: itself, the field its label is for, or one inside it, as drop zones hide theirs.
const fileField = `function () {
  let element = this.nodeType === 1 ? this : this.parentElement;
  if (element instanceof HTMLLabelElement && element.control) element = element.control;
  if (element instanceof HTMLInputElement && element.type === "file") return element;
  return element ? element.querySelector("input[type=file]") : null;
}`

// uploadRef sets the files on the element's file field, else on the chooser a click on it opens, else drops them on it; it says which.
func (p *tabPage) uploadRef(ctx context.Context, ref string, paths []string, limit time.Duration) (string, error) {

	object, ok := p.element(ctx, ref)

	if !ok {

		return "", errGone

	}

	found, err := call(ctx, p.s, runtime.CallFunctionOn, runtime.CallFunctionOnParams{FunctionDeclaration: fileField, ObjectID: object})

	if err != nil {

		return "", err

	}

	if found.Result != nil && found.Result.ObjectID != "" {

		_, err := call(ctx, p.s, dom.SetFileInputFiles, dom.SetFileInputFilesParams{Files: paths, ObjectID: found.Result.ObjectID})

		return "put", err

	}

	field, err := p.chosen(ctx, ref, limit)

	if err != nil {

		return "", err

	}

	if field != 0 {

		_, err := call(ctx, p.s, dom.SetFileInputFiles, dom.SetFileInputFilesParams{Files: paths, BackendNodeID: field})

		return "put", err

	}

	return "dropped", p.drop(ctx, ref, paths)

}

// chosen clicks the element with file choosers intercepted, and is the field whose chooser opened, or 0 when none did.
func (p *tabPage) chosen(ctx context.Context, ref string, limit time.Duration) (cdp.BackendNodeID, error) {

	opened := make(chan cdp.BackendNodeID, 1)

	stop := onEvent(p.s, page.FileChooserOpened, func(event page.EventFileChooserOpened) {

		select {

		case opened <- event.BackendNodeID:

		default:

		}

	})

	defer stop()

	if _, err := call(ctx, p.s, page.SetInterceptFileChooserDialog, page.SetInterceptFileChooserDialogParams{Enabled: true}); err != nil {

		return 0, err

	}

	defer call(context.WithoutCancel(ctx), p.s, page.SetInterceptFileChooserDialog, page.SetInterceptFileChooserDialogParams{Enabled: false})

	// an element that cannot be clicked may still take a drop
	if err := p.clickRef(ctx, ref, limit); err != nil {

		if errors.Is(err, errGone) || ctx.Err() != nil {

			return 0, err

		}

		return 0, nil

	}

	select {

	case field := <-opened:

		return field, nil

	case <-time.After(chooserWait):

		return 0, nil

	case <-ctx.Done():

		return 0, ctx.Err()

	}

}

// drop drags the files onto the element's middle, the only way into a drop zone with no file field.
func (p *tabPage) drop(ctx context.Context, ref string, paths []string) error {

	object, ok := p.element(ctx, ref)

	if !ok {

		return errGone

	}

	if state, err := callOn[string](ctx, p, object, clickCheck); err != nil || state == "gone" {

		return errGone

	}

	x, y, found := p.middle(ctx, object)

	if !found {

		return fmt.Errorf("%s is not visible, so nothing could be dropped on it", ref)

	}

	data := &input.DragData{Items: []*input.DragDataItem{}, Files: paths, DragOperationsMask: 1}

	for _, kind := range []input.DispatchDragEventType{input.DispatchDragEventTypeDragEnter, input.DispatchDragEventTypeDragOver, input.DispatchDragEventTypeDrop} {

		if _, err := call(ctx, p.s, input.DispatchDragEvent, input.DispatchDragEventParams{Type: kind, X: x, Y: y, Data: data}); err != nil {

			return err

		}

	}

	return nil

}
