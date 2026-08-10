# Boombox

TypeScript SDK **and** desktop coding agent built on-top of the Boodlebox semi-public API (`https://box.boodle.ai/api`), which promises “unlimited tokens.”

## Setup

```bash
bun install
```

Be sure to set the full, required browser `Cookie` header. Otherwise, nothing will work. Obviously...

---

## Coding Agent (`swe/`)

A [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)–style loop in an Electron window. The model replies with **exactly one** `bash` block, the app runs it on your machine, and combined stdout/stderr plus the exit code go back as the next message. Bash is the entire tool surface, so it works with Boodlebox.

### Run The Agent

```bash
bun run swe
```

That builds the renderer (Vite) and the process (Bun), then launches Electron.

### Using The Agent

1. Choose a **working folder** (last path is remembered).
2. Pick a **model** (grouped by provider) and an **approval mode**.
3. Describe a task. The agent streams a short prose line plus one bash block.
4. The block is written to a temp script and executed with `bash` (or `SWE_SHELL`).
5. Output is fed back; the loop continues until `MINI_SWE_FINISHED` appears in the output, or the step limit is hit.

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

The license is the Unilicense. As far as motivation, this is a simple proof-of-concept and educational project, nothing more. The Boodlebox API is semi-public and not officially supported, so you should use this at your own risk. All of this should be treated as an *example* of what can be done, not what *should* be done.
