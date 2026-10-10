package server

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"boombox/config"
	"boombox/store"

	"github.com/SherClockHolmes/webpush-go"
)

type vapidKeys struct {

	PublicKey string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`

}

// Notice is the payload the PWA's service worker shows.
type Notice struct {

	Title string `json:"title"`
	Body string `json:"body"`

	AgentID int64 `json:"agentId,omitempty"`

}

type Push struct {

	st *store.Store
	keys vapidKeys
	subject string

}

// NewPush reads the existing keys, or makes them once: rotating them would orphan every subscription the PWA holds.
func NewPush(st *store.Store) (*Push, error) {

	path := filepath.Join(st.Home, "vapid.json")

	var keys vapidKeys

	if data, err := os.ReadFile(path); err == nil {

		if err := json.Unmarshal(data, &keys); err != nil {

			return nil, err

		}

	} else {

		private, public, err := webpush.GenerateVAPIDKeys()

		if err != nil {

			return nil, err

		}

		keys = vapidKeys{PublicKey: public, PrivateKey: private}
		encoded, _ := json.Marshal(keys)

		if err := os.WriteFile(path, encoded, 0o600); err != nil {

			return nil, err

		}

	}

	// Apple rejects a localhost subject, so production needs a real mailto or https URL here; the library adds mailto: itself
	subject := strings.TrimPrefix(config.String("PTS_VAPID_SUBJECT", "mailto:pts@localhost"), "mailto:")

	return &Push{st: st, keys: keys, subject: subject}, nil

}

func (p *Push) PublicKey() string { return p.keys.PublicKey }

func (p *Push) Notify(userID int64, notice Notice) {

	subs, err := p.st.ListPushSubs(userID)

	if err != nil {

		return

	}

	payload, _ := json.Marshal(notice)

	var wg sync.WaitGroup

	for _, raw := range subs {

		var sub webpush.Subscription

		if json.Unmarshal([]byte(raw), &sub) != nil {

			continue

		}

		wg.Add(1)

		go func() {

			defer wg.Done()

			res, err := webpush.SendNotification(payload, &sub, &webpush.Options{

				Subscriber: p.subject,
				VAPIDPublicKey: p.keys.PublicKey,
				VAPIDPrivateKey: p.keys.PrivateKey,

				TTL: 3600,

			})

			if err != nil {

				log.Printf("push: %v", err)

				return

			}

			res.Body.Close()

			// the browser threw this subscription away; it will never deliver again
			if res.StatusCode == 404 || res.StatusCode == 410 {

				p.st.DeletePushSub(sub.Endpoint)

			}

		}()

	}

	wg.Wait()

}
