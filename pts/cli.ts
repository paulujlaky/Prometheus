// Run on the server: hands out sign-in keys, and drives agents from a terminal without the server. bun pts/cli.ts <command>

import { BoodleClient } from "../sdk/index";

import { closeAll, setProxy, setZone } from "./Agent/Tools/Browser";
import { runAgent, type RunEvent } from "./Agent/Runner";
import { createAgent, deleteUser, getAgent, getUser, HOME, issueKey, listAgents, listEvents, listUsers, readSetting, userDir, workspaceOf, type User } from "./Store";

const USAGE = `usage:
  bun pts/cli.ts key <user>       make the user, or give them a new key; the old one stops working
  bun pts/cli.ts remove <user>    delete the user and everything of theirs but their files
  bun pts/cli.ts list             users and their agents
  bun pts/cli.ts models <user>
  bun pts/cli.ts new <user> <name> <modelId> [persona...]
  bun pts/cli.ts send <user> <name> <task...>
  bun pts/cli.ts log <user> <name>`;

function userNamed(name: string | undefined): User {

  const user = name ? getUser(name) : null;

  if (!user) {

    throw new Error(`No user named ${name ?? "(none)"}. Try: bun pts/cli.ts list`);

  }

  return user;

}

function client(user: User): BoodleClient {

  if (!user.cookie) {

    throw new Error(`${user.name} has not connected Boodle yet; they paste their cookie in the app`);

  }

  return new BoodleClient({ cookie: user.cookie });

}

function agentNamed(user: User, name: string | undefined) {

  const agent = name ? getAgent(user.id, name) : null;

  if (!agent) {

    throw new Error(`${user.name} has no agent named ${name ?? "(none)"}. Try: bun pts/cli.ts list`);

  }

  return agent;

}

const [command, ...args] = process.argv.slice(2);

switch (command) {

  case "key": {

    if (!args[0]) {

      throw new Error(USAGE);

    }

    console.log(`${args[0]} signs in with this key. It is shown once; run this again for a new one.\n\n  ${issueKey(args[0])}\n`);

    break;

  }

  case "remove": {

    const user = userNamed(args[0]);

    deleteUser(user.id);
    console.log(`removed ${user.name}. Their workspaces are still in ${userDir(user.id)}, and their Prometheus bots in their Boodle account.`);

    break;

  }

  case "list": {

    console.log(`home: ${HOME}`);

    for (const user of listUsers()) {

      console.log(`\n${user.name}${user.cookie ? "" : "  (Boodle not connected)"}`);

      for (const agent of listAgents(user.id)) {

        console.log(`  ${agent.name}  model ${agent.modelId}${agent.botAssistantId ? `  bot ${agent.botAssistantId}` : ""}`);

      }

    }

    break;

  }

  case "models": {

    for (const model of await client(userNamed(args[0])).listCustomModels()) {

      console.log(`${model.id}  ${model.name}`);

    }

    break;

  }

  case "new": {

    const [name, modelId, ...persona] = args.slice(1);

    if (!name || !modelId) {

      throw new Error(USAGE);

    }

    const agent = createAgent(userNamed(args[0]).id, name, modelId, persona.join(" "));

    console.log(`created ${agent.name} → ${workspaceOf(agent)}`);

    break;

  }

  case "send": {

    const user = userNamed(args[0]);
    const agent = agentNamed(user, args[1]);
    const task = args.slice(2);

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

    await setProxy(process.env.PTS_PROXY?.trim() || null);
    await setZone(userDir(user.id), readSetting(user.id, "timezone"));
    await runAgent(client(user), agent, task.join(" "), { signal: controller.signal, takeNotes: () => [], listen, ask: async (question, kind) => (kind === "question" ? (prompt(`\n${question}\n>`) ?? false) : confirm(`\n${question}\nAllow?`)) });

    // the browser keeps the process alive until its contexts close
    await closeAll();

    break;

  }

  case "log": {

    const user = userNamed(args[0]);

    for (const event of listEvents(agentNamed(user, args[1]).id)) {

      console.log(`── ${event.kind}  ${new Date(event.at).toISOString()} ──\n${event.text}\n`);

    }

    break;

  }

  default:

    console.log(USAGE);

}
