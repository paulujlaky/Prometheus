# Boombox

TypeScript SDK for the Boodlebox semi-public API (`https://box.boodle.ai/api`). Bun-friendly; plain `fetch` + `WebSocket`.

## Install

```bash
bun install
```

## Quick start (ChatSession)

```ts
import { BoodleClient, ChatSession } from "./src/index";

// set up the client

const client = new BoodleClient({ cookie: process.env.BOODLE_COOKIE! });
const session = await ChatSession.create(client);

// attach some listeners

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

// send a message

const assistantTurn = await session.send("Explain elucid503/GraniteOS-2 briefly.");
console.log(assistantTurn.text);

session.dispose();
```

## Layers

| Layer | Responsibility |
|-------|----------------|
| `BoodleClient` | REST: chats, messages, assistants, WS ticket |
| `BoodleSocket` | Parrot WebSocket transport (envelopes only) |
| `ResponseStream` | Generalized parser for `ContentBlock` |
| `ChatSession` | One chat: history, reconnect, send, UI turns |
| `parseSession` | Cookie → `userId` / org / preferred assistant |

### Turn Object

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

## Auth

Pass the full browser `Cookie` header. `userId` is read from the `d` JWT; `teamID` and `preferred-chat-assistant` are optional helpers.

## Test

```bash
bun test
bun run typecheck
```
