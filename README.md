# Boombox

TypeScript SDK **and** multi-user agents server built on-top of the Boodlebox semi-public API (`https://box.boodle.ai/api`), which promises “unlimited tokens.”

## Setup

```bash
bun install
```

Be sure to set the full, required browser `Cookie` header. Otherwise, nothing will work. Obviously...

---

## Agents Server (`pts/`)

Prometheus runs persistent agents for several people on one Linux server. Each person signs in with a key and
connects their own Boodle account; agents' commands run in a sandbox with no access to the host or each other.

On a fresh Debian or Ubuntu VPS, as the user it should run as:

```bash
git clone <this repo> && cd Boombox
bash pts/setup.sh           # installs everything, writes .env and stops
nano .env                   # fill it in, see .env.example
bash pts/setup.sh           # finishes the install
bun run pts:serve           # starts pts on 127.0.0.1:7420
bun pts/cli.ts key alice    # prints alice's sign-in key
```

Keeping pts running and putting HTTPS in front of it are up to you. To update, `git pull` and run `bash pts/setup.sh` again.

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
