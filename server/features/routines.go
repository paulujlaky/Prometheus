package features

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"boombox/agent/shell"
	"boombox/store"
)

type field struct {

	name string
	min int
	max int

}

var fields = []field{

	{name: "minute", min: 0, max: 59},
	{name: "hour", min: 0, max: 23},
	{name: "day", min: 1, max: 31},
	{name: "month", min: 1, max: 12},
	{name: "weekday", min: 0, max: 7},

}

const (
	maxOutput = 20_000
	maxDiffLines = 60
	checkTimeout = 120 * time.Second
)

// five years: the longest wait a cron can name is a February 29th
const searchSpan = 5 * 366 * 24 * time.Hour

type Cron struct {

	sets [5]map[int]bool

	// standard cron: when both day fields are restricted, either one matching is enough
	anyDay bool
	anyWeekday bool

}

func strictInt(text string) (int, bool) {

	value, err := strconv.Atoi(text)

	return value, err == nil

}

func ParseCron(spec string) (Cron, error) {

	parts := strings.Fields(spec)

	if len(parts) != 5 {

		return Cron{}, errors.New("A schedule is five fields — minute hour day month weekday — like 0 8 * * 1-5")

	}

	var cron Cron

	for i, part := range parts {

		limits := fields[i]
		set := map[int]bool{}

		for _, item := range strings.Split(part, ",") {

			span, stepText, stepped := strings.Cut(item, "/")
			step := 1
			valid := true

			if stepped {

				step, valid = strictInt(stepText)

			}

			lo, hi := limits.min, limits.max

			switch {

			case span == "*":

			case strings.Contains(span, "-"):

				from, to, _ := strings.Cut(span, "-")
				low, okLow := strictInt(from)
				high, okHigh := strictInt(to)
				lo, hi = low, high
				valid = valid && okLow && okHigh

			default:

				value, ok := strictInt(span)
				lo, hi = value, value
				valid = valid && ok

				if stepped {

					hi = limits.max

				}

			}

			if !valid || lo < limits.min || hi > limits.max || lo > hi || step < 1 {

				return Cron{}, fmt.Errorf("%q is not a valid %s in %q", item, limits.name, spec)

			}

			for value := lo; value <= hi; value += step {

				set[value] = true

			}

		}

		cron.sets[i] = set

	}

	// 7 is Sunday too
	if cron.sets[4][7] {

		cron.sets[4][0] = true

	}

	cron.anyDay = parts[2] == "*"
	cron.anyWeekday = parts[4] == "*"

	return cron, nil

}

// LoadZone is the IANA zone by name; "Local" is refused, since it names no zone a user could have picked.
func LoadZone(zone string) (*time.Location, error) {

	if zone == "" || zone == "Local" {

		return nil, errors.New("unknown time zone")

	}

	return time.LoadLocation(zone)

}

func IsTimeZone(zone string) bool {

	_, err := LoadZone(zone)

	return err == nil

}

func zoneOrUTC(zone string) *time.Location {

	if location, err := LoadZone(zone); err == nil {

		return location

	}

	return time.UTC

}

// NextRun is the first whole minute after after that cron names on zone's wall clock; ok is false for a date that never comes, like February 30th.
func NextRun(cron Cron, zone string, after time.Time) (time.Time, bool) {

	location := zoneOrUTC(zone)
	minutes, hours, days, months, weekdays := cron.sets[0], cron.sets[1], cron.sets[2], cron.sets[3], cron.sets[4]
	limit := after.Add(searchSpan)

	for at := after.Truncate(time.Minute).Add(time.Minute); at.Before(limit); {

		clock := at.In(location)
		day := days[clock.Day()]
		weekday := weekdays[int(clock.Weekday())]
		dayMatches := day || weekday

		if cron.anyDay || cron.anyWeekday {

			dayMatches = day && weekday

		}

		if months[int(clock.Month())] && dayMatches && hours[clock.Hour()] {

			if minutes[clock.Minute()] {

				return at, true

			}

			at = at.Add(time.Minute)

			continue

		}

		// on to the top of the next hour; clocks change on the hour, so a skipped stretch never hides a matching minute
		at = at.Add(time.Duration(60-clock.Minute()) * time.Minute)

	}

	return time.Time{}, false

}

// LocalTime is how the agent and its notes read a time: on the user's clock, with the zone's short name.
func LocalTime(at time.Time, zone string) string {

	return at.In(zoneOrUTC(zone)).Format("Mon, Jan 2, 3:04 PM MST")

}

// NextAt is when a routine next fires in Unix milliseconds; nil for watches and paused ones.
func NextAt(routine store.Routine, zone string, now time.Time) *int64 {

	if routine.Kind != "schedule" || !routine.Enabled {

		return nil

	}

	cron, err := ParseCron(routine.Spec)

	if err != nil {

		return nil

	}

	next, ok := NextRun(cron, zone, now)

	if !ok {

		return nil

	}

	millis := next.UnixMilli()

	return &millis

}

// ParseInterval is the minutes between checks; anything below one would hammer the target for nothing.
func ParseInterval(spec string) (int, error) {

	minutes, err := strconv.Atoi(strings.TrimSpace(spec))

	if err != nil || minutes < 1 {

		return 0, errors.New("A watch interval is a whole number of minutes, 1 or more")

	}

	return minutes, nil

}

func ValidateRoutine(kind, spec, target string) error {

	if kind == "schedule" {

		_, err := ParseCron(spec)

		return err

	}

	if kind != "watch" {

		return errors.New("kind must be schedule or watch")

	}

	if _, err := ParseInterval(spec); err != nil {

		return err

	}

	if strings.TrimSpace(target) == "" {

		return errors.New("A watch needs a target: a URL, or a command whose output to compare")

	}

	return nil

}

var (
	hiddenTags = []*regexp.Regexp{

		regexp.MustCompile(`(?is)<script\b.*?</script>`),
		regexp.MustCompile(`(?is)<style\b.*?</style>`),
		regexp.MustCompile(`(?is)<noscript\b.*?</noscript>`),
		regexp.MustCompile(`(?is)<svg\b.*?</svg>`),
		regexp.MustCompile(`(?is)<template\b.*?</template>`),

	}

	breakTags = regexp.MustCompile(`(?i)<(br|p|div|li|tr|h\d|section|article|header|footer)\b[^>]*>`)
	anyTag = regexp.MustCompile(`<[^>]+>`)
	spaces = regexp.MustCompile(`\s+`)
	webURL = regexp.MustCompile(`(?i)^https?://`)
)

// VisibleText is roughly what a reader sees; markup churn (tokens, script hashes) would otherwise look like a change every check.
func VisibleText(page string) string {

	for _, tag := range hiddenTags {

		page = tag.ReplaceAllString(page, " ")

	}

	page = breakTags.ReplaceAllString(page, "\n")
	page = anyTag.ReplaceAllString(page, " ")

	replacer := strings.NewReplacer("&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", "\"", "&#39;", "'")
	page = replacer.Replace(page)

	lines := []string{}

	for _, line := range strings.Split(page, "\n") {

		if line = strings.TrimSpace(spaces.ReplaceAllString(line, " ")); line != "" {

			lines = append(lines, line)

		}

	}

	return strings.Join(lines, "\n")

}

func clipBytes(text string, limit int) string {

	if len(text) <= limit {

		return text

	}

	return strings.ToValidUTF8(text[:limit], "")

}

// Observe fetches a URL from the server, since the user wrote it, and runs a command in the agent's sandbox.
func Observe(st *store.Store, routine store.Routine, agent store.Agent) (string, error) {

	target := strings.TrimSpace(routine.Target)

	if webURL.MatchString(target) {

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)

		if err != nil {

			return "", err

		}

		res, err := http.DefaultClient.Do(req)

		if err != nil {

			return "", err

		}

		defer res.Body.Close()

		body, err := io.ReadAll(io.LimitReader(res.Body, 20<<20))

		if err != nil {

			return "", err

		}

		text := string(body)

		if strings.Contains(res.Header.Get("Content-Type"), "html") {

			text = VisibleText(text)

		}

		return clipBytes(fmt.Sprintf("status %d\n%s", res.StatusCode, text), maxOutput), nil

	}

	result := shell.Run(context.Background(), routine.Target, st.Workspace(&agent), checkTimeout, st.UserZone(agent.UserID))

	return clipBytes(fmt.Sprintf("exit %d\n%s", result.ExitCode, result.Output), maxOutput), nil

}

func uniqueLines(text string) ([]string, map[string]bool) {

	order := []string{}
	seen := map[string]bool{}

	for _, line := range strings.Split(text, "\n") {

		if !seen[line] {

			seen[line] = true
			order = append(order, line)

		}

	}

	return order, seen

}

// LineChanges is the lines that appeared and disappeared: what the agent needs to judge the change, without both full copies.
func LineChanges(before, after string) string {

	oldOrder, old := uniqueLines(before)
	nowOrder, now := uniqueLines(after)

	section := func(title string, lines []string) string {

		if len(lines) == 0 {

			return ""

		}

		shown := lines[:min(len(lines), maxDiffLines)]
		indented := make([]string, len(shown))

		for i, line := range shown {

			indented[i] = "  " + line

		}

		text := title + ":\n" + strings.Join(indented, "\n")

		if len(lines) > maxDiffLines {

			text += fmt.Sprintf("\n  ... %d more", len(lines)-maxDiffLines)

		}

		return text

	}

	added := []string{}
	removed := []string{}

	for _, line := range nowOrder {

		if !old[line] {

			added = append(added, line)

		}

	}

	for _, line := range oldOrder {

		if !now[line] {

			removed = append(removed, line)

		}

	}

	parts := []string{}

	for _, part := range []string{section("Added", added), section("Removed", removed)} {

		if part != "" {

			parts = append(parts, part)

		}

	}

	if len(parts) == 0 {

		return "Only the order of lines changed."

	}

	return strings.Join(parts, "\n\n")

}

// RoutineTitle is the title, or for a routine the agent left untitled, the task's first line.
func RoutineTitle(routine store.Routine) string {

	if routine.Title != "" {

		return routine.Title

	}

	first, _, _ := strings.Cut(routine.Task, "\n")

	return first

}

func RoutineTask(routine store.Routine, zone, changes string) string {

	// the chat reads the quoted title back out of this header
	named := ""

	if routine.Title != "" {

		named = " \"" + routine.Title + "\""

	}

	quiet := "The user is not watching: say only what matters, in a sentence, and <notify> only if it is worth an interruption."

	if routine.Kind == "schedule" {

		return "[Scheduled routine" + named + ": " + routine.Spec + ", " + LocalTime(time.Now(), zone) + ". " + quiet + "]\n\n" + routine.Task

	}

	return "[Watch" + named + ": " + routine.Target + " changed. " + quiet + "]\n\n" + routine.Task + "\n\n" + changes

}

var blockKey = regexp.MustCompile(`(?i)^\s*(schedule|watch|every|title|task|remove)\s*:\s*(.*)$`)

// an agent that schedules itself in a loop would quietly multiply its own runs
const maxPerAgent = 20

func describe(routine store.Routine, zone string) string {

	when := "watch " + routine.Target + " every " + routine.Spec + " min"

	if routine.Kind == "schedule" {

		when = "schedule " + routine.Spec

		if next := NextAt(routine, zone, time.Now()); next != nil {

			when += ", next " + LocalTime(time.UnixMilli(*next), zone)

		}

	}

	paused := ""

	if !routine.Enabled {

		paused = "  (paused)"

	}

	return fmt.Sprintf("%d  %s%s  — %s", routine.ID, when, paused, RoutineTitle(routine))

}

// RoutineBlock runs the agent's own <routine>: bare it lists, remove: deletes, schedule: or watch: with every: creates; everything after task: is the task.
func RoutineBlock(st *store.Store, agent store.Agent, body string) (bool, string) {

	values := map[string]string{}

	var task []string

	inTask := false

	for _, line := range strings.Split(body, "\n") {

		if inTask {

			task = append(task, line)

			continue

		}

		match := blockKey.FindStringSubmatch(line)

		if match == nil {

			continue

		}

		key := strings.ToLower(match[1])

		if key == "task" {

			inTask = true
			task = []string{match[2]}

			continue

		}

		values[key] = strings.TrimSpace(match[2])

	}

	zone := st.UserZone(agent.UserID)
	mine, err := st.ListRoutines(agent.ID)

	if err != nil {

		return false, err.Error()

	}

	described := make([]string, len(mine))

	for i, routine := range mine {

		described[i] = describe(routine, zone)

	}

	list := strings.Join(described, "\n")

	if remove, ok := values["remove"]; ok {

		for _, routine := range mine {

			if strconv.FormatInt(routine.ID, 10) == strings.TrimSpace(remove) {

				if err := st.DeleteRoutine(routine.ID); err != nil {

					return false, err.Error()

				}

				return true, fmt.Sprintf("removed routine %d", routine.ID)

			}

		}

		if list == "" {

			list = "none"

		}

		return false, "You have no routine " + remove + ". Yours:\n" + list

	}

	_, schedule := values["schedule"]
	_, watch := values["watch"]

	if !schedule && !watch {

		if list == "" {

			return true, "You have no routines."

		}

		return true, list

	}

	if len(mine) >= maxPerAgent {

		return false, fmt.Sprintf("You already have %d routines. Remove one first.", maxPerAgent)

	}

	text := strings.TrimSpace(strings.Join(task, "\n"))
	kind := "watch"
	spec := values["every"]
	target := values["watch"]

	if schedule {

		kind = "schedule"
		spec = values["schedule"]
		target = ""

	}

	// optional, so a model that forgets it still gets its routine; the app falls back to the task
	title := strings.ReplaceAll(values["title"], "\"", "")

	if text == "" {

		return false, "A routine needs a task: line saying what to do when it fires"

	}

	if err := ValidateRoutine(kind, spec, target); err != nil {

		return false, err.Error()

	}

	created, err := st.CreateRoutine(agent.ID, store.RoutineInput{Kind: kind, Spec: spec, Target: target, Title: title, Task: text})

	if err != nil {

		return false, err.Error()

	}

	return true, "created routine " + describe(*created, zone)

}

// how often the scheduler looks; schedules fire on the first check at or after their minute
const checkEvery = 15 * time.Second

type plan struct {

	key string
	at time.Time
	ok bool

}

// StartScheduler fires schedules on each user's clock and runs watches; wake hands the agent a task, and queueing it is wake's business.
func StartScheduler(ctx context.Context, st *store.Store, wake func(agent store.Agent, task string)) {

	var checkingMu sync.Mutex

	checking := map[int64]bool{}

	// the spec and zone each plan was worked out for; a change to either works it out again
	plans := map[int64]*plan{}

	watch := func(routine store.Routine, agent store.Agent, now time.Time) {

		defer func() {

			checkingMu.Lock()
			delete(checking, routine.ID)
			checkingMu.Unlock()

		}()

		output, err := Observe(st, routine, agent)

		// a flaky target retries on the next interval; recording the failure as output would wake the agent for nothing
		if err != nil {

			st.MarkRoutine(routine.ID, nil, now.UnixMilli())

			return

		}

		st.MarkRoutine(routine.ID, &output, now.UnixMilli())

		if routine.LastOutput != nil && output != *routine.LastOutput {

			wake(agent, RoutineTask(routine, st.UserZone(agent.UserID), LineChanges(*routine.LastOutput, output)))

		}

	}

	tick := func() {

		now := time.Now()
		routines, err := st.ListRoutines(0)

		if err != nil {

			log.Printf("routines: %v", err)

			return

		}

		for _, routine := range routines {

			var agent *store.Agent

			if routine.Enabled {

				agent, _ = st.AgentByID(routine.AgentID)

			}

			// a resumed routine plans from then, instead of firing for a time that passed while it was paused
			if agent == nil {

				delete(plans, routine.ID)

				continue

			}

			if err := tickRoutine(st, routine, *agent, now, plans, wake); err != nil {

				log.Printf("routine %d failed: %v", routine.ID, err)

				continue

			}

			if routine.Kind != "watch" {

				continue

			}

			minutes, err := ParseInterval(routine.Spec)

			if err != nil {

				log.Printf("routine %d failed: %v", routine.ID, err)

				continue

			}

			due := routine.LastAt == nil || now.UnixMilli()-*routine.LastAt >= int64(minutes)*60_000-1000

			checkingMu.Lock()
			start := due && !checking[routine.ID]

			if start {

				checking[routine.ID] = true

			}

			checkingMu.Unlock()

			if start {

				go watch(routine, *agent, now)

			}

		}

	}

	go func() {

		ticker := time.NewTicker(checkEvery)
		defer ticker.Stop()

		tick()

		for {

			select {

			case <-ctx.Done():

				return

			case <-ticker.C:

				tick()

			}

		}

	}()

}

// tickRoutine fires a due schedule once; each keeps the instant it fires next, so a late check still fires it and drift loses no minute.
func tickRoutine(st *store.Store, routine store.Routine, agent store.Agent, now time.Time, plans map[int64]*plan, wake func(store.Agent, string)) error {

	if routine.Kind != "schedule" {

		return nil

	}

	zone := st.UserZone(agent.UserID)
	cron, err := ParseCron(routine.Spec)

	if err != nil {

		return err

	}

	key := routine.Spec + " " + zone
	current := plans[routine.ID]

	if current == nil || current.key != key {

		// looking back one check catches a minute that passed just before a restart; lastAt keeps it from firing twice
		from := now.Add(-checkEvery)

		if routine.LastAt != nil && time.UnixMilli(*routine.LastAt).After(from) {

			from = time.UnixMilli(*routine.LastAt)

		}

		at, ok := NextRun(cron, zone, from)
		current = &plan{key: key, at: at, ok: ok}
		plans[routine.ID] = current

	}

	if current.ok && !now.Before(current.at) {

		log.Printf("routine %d fired for %s", routine.ID, agent.Name)
		st.MarkRoutine(routine.ID, nil, now.UnixMilli())
		wake(agent, RoutineTask(routine, zone, ""))
		current.at, current.ok = NextRun(cron, zone, now)

	}

	return nil

}
