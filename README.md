# Boombox

TypeScript SDK **and** desktop coding agent built on-top of the Boodlebox semi-public API (`https://box.boodle.ai/api`), which promises “unlimited tokens.”

## Setup

```bash
bun install
```

Be sure to set the full, required browser `Cookie` header. Otherwise, nothing will work. Obviously...

---

## Coding Agent (`swe/`)

An agent loop in an Electron window, built for models with **no native tool calling**. The model writes
tagged blocks in plain text; the app runs them on your machine and posts the results back. No JSON, so
nothing has to be escaped — the hardest thing a model has to get right is copying a line of code exactly.

### Run The Agent

```bash
bun run swe
```

That builds the renderer (Vite) and the process (Bun), then launches Electron.

### Using The Agent

1. Choose a **working folder** (last path is remembered).
2. Pick a **model** (grouped by provider) and an **approval mode**.
3. Describe a task. The system prompt ships a map of the repo — every file with its line count and
   top-level symbols — plus your `CLAUDE.md` / `AGENTS.md` inline, so discovery and house style
   both cost zero turns.
4. Each reply is a line of intent plus one or more action blocks, which run in order.
5. Results go back as `[verb ok]` / `[verb failed]`. The loop ends on `<done>` or the step limit.

### Protocol

```
<ls>       list a directory: files, line counts, symbols
<read>     whole files or a line range, always numbered
<grep>     literal text or /regex/, grouped by file
<edit>     @@ FIND / @@ REPLACE pairs against exact file text
<write>    create or replace a file
<delete>   remove files (asks first)
<run>      shell: build, test, git (asks first)
<say>      a line to the user
<done>     final summary, ends the run
```

Blocks are forgiving where it costs nothing: verb synonyms (`list`, `search`, `bash`, `finish`) resolve,
`<edit path="x">` and `<edit x>` are the same, an unclosed block still runs, and `<<<<<<< SEARCH` works
wherever `@@ FIND` does. Edits match exactly first, then ignoring trailing space, then ignoring
indentation — and a stale FIND comes back with the nearest real lines attached, so it is fixed in one
turn instead of three. `swe/protocol.test.ts` pins all of it.

---

## SDK Quick Start

```ts
import { BoodleClient, ChatSession } from "./sdk/index";

const client = new BoodleClient({ cookie: process.env.BOODLE_COOKIE! });
const session = await ChatSession.create(client);

session.subscribe((state) => {

  for (const turn of state.messages) {

    console.log(turn.role, turn.status, turn.text);

  }

});

session.on((event) => {

  if (event.type === "stream" && event.change.kind === "delta") {

    process.stdout.write(event.change.text);

  }

});

const assistantTurn = await session.send("Explain elucid503/GraniteOS-2 briefly.");
console.log(assistantTurn.text);

session.dispose();
```

### SDK Layers

| Layer | Responsibility |
|-------|----------------|
| `BoodleClient` | REST: chats, messages, assistants, WS ticket |
| `BoodleSocket` | Parrot WebSocket transport (envelopes only) |
| `ResponseStream` | Generalized parser for `ContentBlock` |
| `ChatSession` | One chat: history, reconnect, send, UI turns |
| `parseSession` | Cookie → `userId` / org / preferred assistant |

### SDK Turn Object

```ts
interface ChatTurn {

  id: string;

  role: "user" | "assistant";
  status: "pending" | "streaming" | "complete" | "error";

  text: string;
  blocks: ContentBlock[]; // text | progress | link | unknown

  submissionId?: string;
  assistantId?: string | null;

}
```

---

## Motivation/License

The license is the [Unlicense](https://unlicense.org/). As far as motivation, this is a simple proof-of-concept and educational project, nothing more. The Boodlebox API is semi-public and not officially supported, so you should use this at your own risk. All of this should be treated as an *example* of what can be done, not what *should* be done.
