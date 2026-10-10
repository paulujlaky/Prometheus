package browser

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/cdp/jsonv2"
	"github.com/chromedp/cdproto/emulation"
	"github.com/chromedp/cdproto/fetch"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/cdproto/target"
)

// Chromium's own table for placing the GREASE, Chromium and product brands
var brandOrders = [][3]int{{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}}

// identity is the headed browser this Chromium claims to be, on its script and on its requests.
type identity struct {

	ua string

	// metadata is nil when the probe could not read client hints; an empty list would strip Sec-CH-UA
	metadata *emulation.UserAgentMetadata

	// acceptLanguage is empty when the probe could not read navigator.languages; sending "" would clear Accept-Language
	acceptLanguage string

	// platform is navigator.platform, sent beside Sec-CH-UA-Platform so the two agree
	platform string

}

var (
	identityMu sync.Mutex
	identityKnown *identity
)

// HeadedBrands renames HeadlessChrome to Google Chrome, and adds Google Chrome in Chrome's order where a new build leaves it out.
func HeadedBrands(list []*emulation.UserAgentBrandVersion) []*emulation.UserAgentBrandVersion {

	named := make([]*emulation.UserAgentBrandVersion, len(list))

	var chromium, grease *emulation.UserAgentBrandVersion

	for i, item := range list {

		brand := item.Brand

		if brand == "HeadlessChrome" {

			brand = "Google Chrome"

		}

		named[i] = &emulation.UserAgentBrandVersion{Brand: brand, Version: item.Version}

		switch {

		case brand == "Chromium":

			chromium = named[i]

		case brand != "Google Chrome" && grease == nil:

			grease = named[i]

		}

	}

	if len(named) != 2 || chromium == nil || grease == nil {

		return named

	}

	major, _ := strconv.Atoi(strings.SplitN(chromium.Version, ".", 2)[0])
	order := brandOrders[major%len(brandOrders)]
	ordered := make([]*emulation.UserAgentBrandVersion, 3)

	ordered[order[0]] = grease
	ordered[order[1]] = chromium
	ordered[order[2]] = &emulation.UserAgentBrandVersion{Brand: "Google Chrome", Version: chromium.Version}

	return ordered

}

// LanguageHeader is the shape Chrome puts on Accept-Language: en-US,en;q=0.9.
func LanguageHeader(languages []string) string {

	parts := []string{}

	for _, language := range languages {

		if language == "" {

			continue

		}

		if len(parts) == 0 {

			parts = append(parts, language)

			continue

		}

		parts = append(parts, fmt.Sprintf("%s;q=%.1f", language, math.Max(0.1, 1-float64(len(parts))*0.1)))

	}

	return strings.Join(parts, ",")

}

const probeScript = `(async () => {
  const data = navigator.userAgentData;
  const high = data ? await data.getHighEntropyValues(["architecture", "bitness", "model", "platformVersion", "uaFullVersion", "fullVersionList", "wow64", "formFactors"]) : null;
  return { ua: navigator.userAgent, brands: data ? data.brands : [], mobile: data ? data.mobile : false, platform: data ? data.platform : "", navPlatform: navigator.platform, languages: [...navigator.languages], high };
})()`

type probeResult struct {

	UA string `json:"ua"`
	Brands []*emulation.UserAgentBrandVersion `json:"brands"`
	Mobile bool `json:"mobile"`
	Platform string `json:"platform"`
	NavPlatform string `json:"navPlatform"`
	Languages []string `json:"languages"`

	High *struct {

		Architecture string `json:"architecture"`
		Bitness string `json:"bitness"`
		Model string `json:"model"`
		PlatformVersion string `json:"platformVersion"`
		UAFullVersion string `json:"uaFullVersion"`
		FullVersionList []*emulation.UserAgentBrandVersion `json:"fullVersionList"`
		Wow64 *bool `json:"wow64"`
		FormFactors []string `json:"formFactors"`

	} `json:"high"`

}

// browserIdentity probes the real client hints once; a metadata-less override drops Sec-CH-UA and never reaches workers.
func browserIdentity() (*identity, error) {

	identityMu.Lock()
	defer identityMu.Unlock()

	if identityKnown != nil {

		return identityKnown, nil

	}

	binary, full, err := findChromium()

	if err != nil {

		return nil, err

	}

	if !full {

		return nil, errors.New("the headless shell has no client hints to borrow")

	}

	// a failed probe is not cached, or a later install of the full Chromium is never picked up
	found, err := probe(binary)

	if err != nil {

		return nil, err

	}

	identityKnown = found

	return found, nil

}

func probe(binary string) (*identity, error) {

	profile, err := os.MkdirTemp("", "pts-probe-")

	if err != nil {

		return nil, err

	}

	defer os.RemoveAll(profile)

	running, err := startChromium(binary, append(append([]string{}, baseArgs...), "--user-data-dir="+profile, "about:blank"), os.Environ())

	if err != nil {

		return nil, err

	}

	defer running.stop(2 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	tab, err := firstPage(ctx, running.root)

	if err != nil {

		return nil, err

	}

	// userAgentData exists only in a secure context, and about:blank is not one; nothing is fetched
	onEvent(tab, fetch.RequestPaused, func(event fetch.EventRequestPaused) {

		go call(ctx, tab, fetch.FulfillRequest, fetch.FulfillRequestParams{

			RequestID: event.RequestID,
			ResponseCode: 200,
			ResponseHeaders: []*fetch.HeaderEntry{{Name: "Content-Type", Value: "text/html"}},
			Body: []byte("<!doctype html>"),

		})

	})

	loaded := make(chan struct{}, 1)

	onEvent(tab, page.LoadEventFired, func(page.EventLoadEventFired) {

		select {

		case loaded <- struct{}{}:

		default:

		}

	})

	if _, err := call(ctx, tab, page.Enable, page.EnableParams{}); err != nil {

		return nil, err

	}

	if _, err := call(ctx, tab, fetch.Enable, fetch.EnableParams{Patterns: []*fetch.RequestPattern{{URLPattern: "*"}}}); err != nil {

		return nil, err

	}

	if _, err := call(ctx, tab, page.Navigate, page.NavigateParams{URL: "https://example.com"}); err != nil {

		return nil, err

	}

	select {

	case <-loaded:

	case <-time.After(10 * time.Second):

	}

	var read probeResult

	evaluated, err := call(ctx, tab, runtime.Evaluate, runtime.EvaluateParams{Expression: probeScript, AwaitPromise: yes(), ReturnByValue: yes()})

	if err == nil && evaluated.Result != nil && evaluated.ExceptionDetails == nil {

		jsonv2.Unmarshal(evaluated.Result.Value, &read)

	}

	if read.UA == "" {

		ua, _ := evaluate[string](ctx, tab, "navigator.userAgent")
		read.UA = ua

	}

	found := &identity{ua: strings.ReplaceAll(read.UA, "HeadlessChrome", "Chrome"), acceptLanguage: LanguageHeader(read.Languages), platform: read.NavPlatform}

	if read.High == nil || len(read.High.FullVersionList) == 0 || len(read.Brands) == 0 {

		return found, nil

	}

	metadata := &emulation.UserAgentMetadata{

		Brands: HeadedBrands(read.Brands),
		FullVersionList: HeadedBrands(read.High.FullVersionList),

		Platform: read.Platform,
		PlatformVersion: read.High.PlatformVersion,
		Architecture: read.High.Architecture,
		Model: read.High.Model,
		Mobile: read.Mobile,
		Bitness: read.High.Bitness,

		FormFactors: read.High.FormFactors,

	}

	if read.High.Wow64 != nil {

		metadata.Wow64 = *read.High.Wow64

	}

	// a headless probe often omits the form factor a site asks for with Accept-CH; desktop Chrome answers "Desktop"
	if len(metadata.FormFactors) == 0 && !read.Mobile {

		metadata.FormFactors = []string{"Desktop"}

	}

	found.metadata = metadata

	return found, nil

}

// firstPage attaches to the page Chromium opened at launch.
func firstPage(ctx context.Context, root *session) (*session, error) {

	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {

		targets, err := call(ctx, root, target.GetTargets, target.GetTargetsParams{})

		if err != nil {

			return nil, err

		}

		for _, info := range targets.TargetInfos {

			if info.Type != "page" {

				continue

			}

			flatten := true
			attached, err := call(ctx, root, target.AttachToTarget, target.AttachToTargetParams{TargetID: info.TargetID, Flatten: &flatten})

			if err != nil {

				return nil, err

			}

			return &session{c: root.c, id: attached.SessionID}, nil

		}

	}

	return nil, errors.New("Chromium opened no page")

}

// languageTags drops the q-values from an Accept-Language header; Chromium adds its own, and given them twice sends "q=0.9;q=0.9".
func languageTags(header string) string {

	tags := []string{}

	for _, part := range strings.Split(header, ",") {

		if tag := strings.TrimSpace(strings.Split(part, ";")[0]); tag != "" {

			tags = append(tags, tag)

		}

	}

	return strings.Join(tags, ",")

}

// identityCommands puts the identity on a target in one batch; a worker only takes the network override once its network domain is on.
func identityCommands(id *identity, deep bool) []command {

	if id == nil || id.metadata == nil || id.ua == "" {

		return nil

	}

	params := emulation.SetUserAgentOverrideParams{UserAgent: id.ua, AcceptLanguage: languageTags(id.acceptLanguage), Platform: id.platform, UserAgentMetadata: id.metadata}
	commands := []command{{method: "Emulation.setUserAgentOverride", params: params}}

	if deep {

		commands = append(commands, command{method: "Network.enable", params: network.EnableParams{}})

	}

	// the protocol files dropped Network.setUserAgentOverride, but Chromium still answers it and it is what requests carry
	return append(commands, command{method: "Network.setUserAgentOverride", params: params})

}

func yes() *bool {

	value := true

	return &value

}

// evaluate runs an expression in the page and decodes its value.
func evaluate[T any](ctx context.Context, s *session, expression string) (T, error) {

	var value T

	result, err := call(ctx, s, runtime.Evaluate, runtime.EvaluateParams{Expression: expression, ReturnByValue: yes(), AwaitPromise: yes()})

	if err != nil {

		return value, err

	}

	if result.ExceptionDetails != nil {

		return value, errors.New(exceptionText(result.ExceptionDetails))

	}

	if result.Result != nil && len(result.Result.Value) > 0 {

		err = jsonv2.Unmarshal(result.Result.Value, &value)

	}

	return value, err

}

func exceptionText(details *runtime.ExceptionDetails) string {

	if details.Exception != nil && details.Exception.Description != "" {

		first, _, _ := strings.Cut(details.Exception.Description, "\n")

		return first

	}

	return details.Text

}
