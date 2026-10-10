package browser_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"boombox/agent/browser"

	"github.com/chromedp/cdproto/emulation"
)

func linuxOnly(t *testing.T) {

	t.Helper()

	if runtime.GOOS != "linux" {

		t.Skip("the browser runs on Linux")

	}

	if err := browser.Installed(); err != nil {

		t.Skip(err.Error())

	}

}

func site(t *testing.T, handler http.HandlerFunc) string {

	server := httptest.NewServer(handler)

	t.Cleanup(server.Close)
	t.Cleanup(browser.CloseAll)

	return server.URL

}

func servePage(w http.ResponseWriter, title, body string) {

	w.Header().Set("Content-Type", "text/html")
	fmt.Fprintf(w, "<!doctype html><title>%s</title><h1>%s</h1>%s", title, title, body)

}

var refLine = regexp.MustCompile(`\[ref=(e\d+)\]`)

func refFor(t *testing.T, text, role string) string {

	t.Helper()

	for _, line := range strings.Split(text, "\n") {

		if strings.Contains(line, "- "+role) {

			if match := refLine.FindStringSubmatch(line); match != nil {

				return match[1]

			}

		}

	}

	t.Fatalf("no %s in:\n%s", role, text)

	return ""

}

func until(t *testing.T, ready func() bool) {

	t.Helper()

	for i := 0; i < 100 && !ready(); i++ {

		time.Sleep(100 * time.Millisecond)

	}

	if !ready() {

		t.Fatal("condition never held")

	}

}

func TestProxyAddressIsCheckedAndPasswordHidden(t *testing.T) {

	if parsed, err := browser.ProxyURL(""); parsed != nil || err != nil {

		t.Fatal("an empty proxy is none")

	}

	parsed, err := browser.ProxyURL("user:p%40ss@proxy.example:8080")

	if password, _ := parsed.User.Password(); err != nil || password != "p@ss" {

		t.Fatalf("password %q %v", password, err)

	}

	labelled, _ := browser.ProxyURL("http://user:secret@proxy.example:8080")

	if label := browser.ProxyLabel(labelled); label != "http://user@proxy.example:8080" {

		t.Fatalf("label %q", label)

	}

	for _, bad := range []string{"socks5://proxy.example:1080", "http://proxy.example:8080/path"} {

		if _, err := browser.ProxyURL(bad); err == nil || !strings.Contains(err.Error(), "HTTP proxy") {

			t.Errorf("%s: %v", bad, err)

		}

	}

}

func TestKeysAndBrands(t *testing.T) {

	for _, key := range []string{"Enter", "a", "Z", "7", "ArrowDown", "F5", "/", "Space"} {

		if !browser.KnownKey(key) {

			t.Errorf("%s is not a key", key)

		}

	}

	brands := browser.HeadedBrands([]*emulation.UserAgentBrandVersion{{Brand: "Not)A;Brand", Version: "8"}, {Brand: "Chromium", Version: "138"}})
	names := []string{}

	for _, brand := range brands {

		names = append(names, brand.Brand)

	}

	if len(names) != 3 || !strings.Contains(strings.Join(names, ","), "Google Chrome") {

		t.Fatalf("brands %v", names)

	}

	if header := browser.LanguageHeader([]string{"en-US", "en", "fr"}); header != "en-US,en;q=0.9,fr;q=0.8" {

		t.Fatalf("header %q", header)

	}

}

