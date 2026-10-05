// Drives agents from a terminal, no server needed: bun pts/cli.ts <command>

import { BoodleClient } from "../sdk/index";

import { closeAll } from "./Agent/Tools/Browser";
import { runAgent, type RunEvent } from "./Agent/Runner";
import { createAgent, getAgent, HOME, listAgents, listEvents, workspaceOf } from "./Store";

const USAGE = `usage:
  bun pts/cli.ts models
  bun pts/cli.ts new <name> <modelId> [persona...]
  bun pts/cli.ts list
  bun pts/cli.ts send <name> <task...>
  bun pts/cli.ts log <name>`;

function client(): BoodleClient {

  const cookie = process.env.BOODLE_COOKIE?.trim();

  if (!cookie) {

    throw new Error("BOODLE_COOKIE is not set (put it in .env at the repo root)");

  }

  return new BoodleClient({ cookie });

}

function agentNamed(name: string | undefined) {

  const agent = name ? getAgent(name) : null;

  if (!agent) {

    throw new Error(`No agent named ${name ?? "(none)"}. Try: bun pts/cli.ts list`);

  }

  return agent;

}

const [command, ...args] = process.argv.slice(2);

switch (command) {

  case "models": {

    for (const model of await client().listCustomModels()) {

      console.log(`${model.id}  ${model.name}`);

    }

    break;

  }

  case "new": {

    const [name, modelId, ...persona] = args;

    if (!name || !modelId) {

      throw new Error(USAGE);

    }

    const agent = createAgent(name, modelId, persona.join(" "));

    console.log(`created ${agent.name} → ${workspaceOf(agent)}`);

    break;

  }

  case "list": {

    console.log(`home: ${HOME}`);

    for (const agent of listAgents()) {

      console.log(`${agent.name}  model ${agent.modelId}${agent.botAssistantId ? `  bot ${agent.botAssistantId}` : ""}`);

    }

    break;

  }

  case "send": {

    const [name, ...task] = args;
    const agent = agentNamed(name);

    if (!task.length) {

      throw new Error(USAGE);

    }

    const controller = new AbortController();

    process.on("SIGINT", () => controller.abort());

    const listen = (event: RunEvent) => {

      if (event.kind === "delta") {

        process.stdout.write(event.text);
        return;

      }

      if (event.kind === "assistant") {

        process.stdout.write("\n");
        return;

      }

      console.log(`\n── ${event.kind} ──\n${event.text}\n`);

    };

    await runAgent(client(), agent, task.join(" "), { signal: controller.signal, takeNotes: () => [], listen, ask: async (question, kind) => (kind === "question" ? (prompt(`\n${question}\n>`) ?? false) : confirm(`\n${question}\nAllow?`)) });

    // the browser keeps the process alive until its contexts close
    await closeAll();

    break;

  }

  case "log": {

    for (const event of listEvents(agentNamed(args[0]).id)) {

      console.log(`── ${event.kind}  ${new Date(event.at).toISOString()} ──\n${event.text}\n`);

    }

    break;

  }

  default:

    console.log(USAGE);

}
