package browser

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

const maxProxyHead = 64 * 1024

var scheme = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)

// ProxyURL reads http://user:pass@host:port, with the scheme optional; an empty one is no proxy.
func ProxyURL(raw string) (*url.URL, error) {

	text := strings.TrimSpace(raw)

	if text == "" {

		return nil, nil

	}

	if !scheme.MatchString(text) {

		text = "http://" + text

	}

	parsed, err := url.Parse(text)

	if err != nil {

		return nil, errors.New("That is not a proxy address. Use http://user:pass@host:port")

	}

	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" || (parsed.Path != "/" && parsed.Path != "") {

		return nil, errors.New("Use an HTTP proxy, like http://user:pass@host:port")

	}

	return parsed, nil

}

// ProxyLabel is what logs show of the proxy: never the password.
func ProxyLabel(proxy *url.URL) string {

	if proxy == nil {

		return ""

	}

	user := ""

	if proxy.User != nil && proxy.User.Username() != "" {

		user = proxy.User.Username() + "@"

	}

	return proxy.Scheme + "://" + user + proxy.Host

}

// proxySetting is what Chromium is pointed at: the shared proxy, or the local relay that signs in to it.
type proxySetting struct {

	server string
	host string

}

var (
	proxyMu sync.Mutex
	proxy *proxySetting
	relay net.Listener
)

func currentProxy() *proxySetting {

	proxyMu.Lock()
	defer proxyMu.Unlock()

	return proxy

}

// openRelay signs in to the proxy for Chromium, which takes no credentials on the command line.
func openRelay(upstream *url.URL) (net.Listener, error) {

	password, _ := upstream.User.Password()
	auth := "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(upstream.User.Username()+":"+password))
	host := upstream.Hostname()
	port := upstream.Port()

	if port == "" {

		port = "80"

		if upstream.Scheme == "https" {

			port = "443"

		}

	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")

	if err != nil {

		return nil, err

	}

	go func() {

		for {

			client, err := listener.Accept()

			if err != nil {

				return

			}

			go relayOne(client, upstream.Scheme == "https", host, port, auth)

		}

	}()

	return listener, nil

}

func relayOne(client net.Conn, secure bool, host, port, auth string) {

	var head []byte

	buffer := make([]byte, 16*1024)
	end := -1

	for end == -1 {

		n, err := client.Read(buffer)

		if err != nil {

			client.Close()

			return

		}

		head = append(head, buffer[:n]...)
		end = bytes.Index(head, []byte("\r\n\r\n"))

		if end == -1 && len(head) > maxProxyHead {

			client.Close()

			return

		}

	}

	lines := strings.Split(string(head[:end]), "\r\n")
	tunnel := strings.HasPrefix(strings.ToUpper(lines[0]), "CONNECT ")
	out := []string{lines[0], auth}

	// only a connection's first request is signed, so plain-http requests each get their own; https tunnels are unaffected
	for _, line := range lines[1:] {

		lower := strings.ToLower(line)

		if strings.HasPrefix(lower, "proxy-authorization:") {

			continue

		}

		if !tunnel && (strings.HasPrefix(lower, "connection:") || strings.HasPrefix(lower, "proxy-connection:")) {

			continue

		}

		out = append(out, line)

	}

	if !tunnel {

		out = append(out, "Connection: close")

	}

	address := net.JoinHostPort(host, port)

	var far net.Conn
	var err error

	if secure {

		far, err = tls.Dial("tcp", address, &tls.Config{ServerName: host})

	} else {

		far, err = net.Dial("tcp", address)

	}

	if err != nil {

		client.Close()

		return

	}

	if _, err := io.WriteString(far, strings.Join(append(out, "", ""), "\r\n")); err != nil {

		client.Close()
		far.Close()

		return

	}

	far.Write(head[end+4:])
	splice(client, far)

}

type halfCloser interface {

	CloseWrite() error

}

// splice pipes both ways; a clean end is passed on so nothing unsent is lost, and a failure takes both sides.
func splice(a, b net.Conn) {

	var wg sync.WaitGroup

	pipe := func(from, to net.Conn) {

		defer wg.Done()

		if _, err := io.Copy(to, from); err != nil {

			a.Close()
			b.Close()

			return

		}

		if closer, ok := to.(halfCloser); ok {

			closer.CloseWrite()

		} else {

			to.Close()

		}

	}

	wg.Add(2)

	go pipe(a, b)
	go pipe(b, a)

	wg.Wait()
	a.Close()
	b.Close()

}

// SetProxy points every Chromium at raw, or straight out for an empty one; running ones restart onto it and their tabs come back.
func SetProxy(raw string) error {

	parsed, err := ProxyURL(raw)

	if err != nil {

		return err

	}

	var next *proxySetting
	var opened net.Listener

	if parsed != nil {

		next = &proxySetting{server: parsed.Scheme + "://" + parsed.Host, host: parsed.Hostname()}

		if parsed.User != nil && parsed.User.Username() != "" {

			if opened, err = openRelay(parsed); err != nil {

				return err

			}

			next = &proxySetting{server: "http://127.0.0.1:" + strconv.Itoa(opened.Addr().(*net.TCPAddr).Port), host: "127.0.0.1"}

		}

	}

	proxyMu.Lock()
	old := relay
	relay = opened
	proxy = next
	proxyMu.Unlock()

	relaunch("")

	if old != nil {

		old.Close()

	}

	return nil

}
