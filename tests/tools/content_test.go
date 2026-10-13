package tools_test

import (
	"strings"
	"testing"

	"boombox/agent/protocol"
)

func TestContentBlocksValidateBeforeUse(t *testing.T) {

	body := `{"title":"Trip","blocks":[{"type":"text","text":"Options"},{"type":"list","items":["A","B"]},{"type":"table","columns":["Place","Cost"],"rows":[["A","$10"]]},{"type":"metric","label":"Total","value":"$10"},{"type":"section","title":"Details","blocks":[{"type":"image","url":"https://example.com/photo.png","alt":"Photo"},{"type":"link","url":"https://example.com","label":"Source"}]}],"actions":[{"label":"Choose A","reply":"Choose A for the trip"}],"fields":[{"name":"date","label":"Date","required":true}]} `

	if card, err := protocol.ParseCard(body); err != nil || len(card.Blocks) != 5 {

		t.Fatalf("valid card: %+v, %v", card, err)

	}

	for _, body := range []string{

		`{"blocks":[{"type":"html","text":"<script>"}]}`,
		`{"blocks":[{"type":"link","url":"javascript:alert(1)","label":"Click"}]}`,
		`{"blocks":[{"type":"image","url":"https://user:password@example.com/a","alt":"Image"}]}`,
		`{"blocks":[{"type":"text","text":"Hi","style":"color:red"}]}`,
		`{"blocks":[{"type":"table","columns":["A","B"],"rows":[["one"]]}]}`,
		`{"blocks":[{"type":"text","text":"Hi"}],"fields":[{"name":"a","label":"A"},{"name":"a","label":"B"}]}`,
		`{"blocks":[]}`,
		`{"Blocks":[{"type":"text","text":"Hi"}]}`,
		`{"blocks":[{"type":"text","text":"Hi","blocks":[]}]}`,
		`{"blocks":[{"type":"text","text":"Hi"}]} {}`,
		strings.Repeat(" ", 65537),

	} {

		if _, err := protocol.ParseCard(body); err == nil {

			t.Errorf("accepted invalid card: %s", body[:min(len(body), 200)])

		}

	}

	spec, err := protocol.ParseAgentSpec(`{"name":" Analyst ","instructions":" Check sources. ","glyph":"orbit:sky","task":"Investigate"}`)

	if err != nil || spec.Name != "Analyst" || spec.Instructions != "Check sources." || spec.Task != "Investigate" {

		t.Fatalf("spec %+v: %v", spec, err)

	}

	for _, body := range []string{`{}`, `{"name":"Analyst"}`, `{"name":"A","instructions":"B","inherit":true}`} {

		if _, err := protocol.ParseAgentSpec(body); err == nil {

			t.Errorf("accepted invalid spec: %s", body)

		}

	}

	actions := protocol.ParseActions("<create_agent>\n{\"name\":\"A\",\"instructions\":\"B\"}\n</create_agent>\n<card>\n" + body + "\n</card>\n<done>Ready.</done>")

	if len(actions) != 3 || actions[0].Verb != "create_agent" || actions[1].Verb != "card" || actions[2].Verb != "done" {

		t.Fatalf("actions %+v", actions)

	}

}

func TestCardIcons(t *testing.T) {

	card, err := protocol.ParseCard(`{"title":"Trip","icon":"calendar-days","blocks":[{"type":"text","text":"Ready","icon":"unknown-icon-name"}],"actions":[{"label":"Go","reply":"Go","icon":"arrow-right"}]}`)

	if err != nil || card.Icon != "calendar-days" || card.Blocks[0].Icon != "unknown-icon-name" || card.Actions[0].Icon != "arrow-right" {

		t.Fatalf("card %+v: %v", card, err)

	}

	for _, icon := range []string{"CalendarDays", "../calendar", "<svg>", "calendar--days", strings.Repeat("x", 65)} {

		for _, body := range []string{

			`{"icon":"` + icon + `","blocks":[{"type":"text","text":"Hi"}]}`,
			`{"blocks":[{"type":"text","text":"Hi","icon":"` + icon + `"}]}`,
			`{"blocks":[{"type":"text","text":"Hi"}],"actions":[{"label":"Go","reply":"Go","icon":"` + icon + `"}]}`,

		} {

			if _, err := protocol.ParseCard(body); err == nil {

				t.Errorf("accepted invalid icon: %s", icon)

			}

		}

	}

}
