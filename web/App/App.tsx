import { motion, MotionConfig } from "motion/react";
import { Component } from "react";

import { Torch } from "../Components/Layout";
import { Install, mustInstall } from "../Screens/Account/Install";
import { Gate } from "../Screens/Account/Login";
import { Settings } from "../Screens/Account/Settings";
import { Browser } from "../Screens/Agent/Browser";
import { Chat } from "../Screens/Agent/Chat";
import { Details } from "../Screens/Agent/Details";
import { Group } from "../Screens/Group/Group";
import { Home } from "../Screens/Home/Home";
import { NewAgent } from "../Screens/Home/NewAgent";
import { NewGroup } from "../Screens/Home/NewGroup";

import { isWaiting } from "../Lib/protocol";
import { AgentsContext } from "./context";
import { api, Unauthorized, type Account, type Agent, type AgentEvent, type GroupChat, type GroupMessage, type LiveChannel, type LiveCommand, type LiveEvent, type Model, type SocketMessage } from "../Lib/api";

type Route =

  | { name: "home" }
  | { name: "agent" | "details" | "browser" | "group"; id: number }
  | { name: "settings" | "new" | "newGroup" };

/** A chat whose messages can be unread; group 0 is Everyone. */
type ReadTarget = { agent: number } | { group: number };

interface AppState {

  /** null while the first request decides whether the session cookie still works. */
  authed: boolean | null;

  route: Route;
  wide: boolean;

  agents: Agent[];
  events: Record<number, AgentEvent[]>;

  groups: GroupChat[];
  threads: Record<number, GroupMessage[]>;

  account: Account;
  models: Model[] | null;

}

const WIDE = "(min-width: 960px)";

function parseRoute(): Route {

  const [name, id, sub] = location.hash.replace(/^#\/?/, "").split("/");

  if (name === "agent" && Number(id)) {

    return { name: sub === "details" || sub === "browser" ? sub : "agent", id: Number(id) };

  }

  if (name === "group") {

    return { name, id: Number(id) || 0 };

  }

  return name === "new" && id === "group" ? { name: "newGroup" } : name === "settings" || name === "new" ? { name } : { name: "home" };

}

const routeKey = (route: Route) => "id" in route ? `${route.name === "group" ? "group" : "agent"}/${route.id}` : route.name;

export class App extends Component<{}, AppState> {

  state: AppState = { authed: null, route: parseRoute(), wide: matchMedia(WIDE).matches, agents: [], events: {}, groups: [], threads: {}, account: { set: true, name: null, email: null }, models: null };

  private socket: WebSocket | null = null;
  private retries = 0;
  private closed = false;

  // frames skip React state: at ten a second they would re-render every screen
  private liveListeners = new Set<(event: LiveEvent) => void>();

  // what a reconnect has to ask for again: the browser being watched, and the take-over this device had, phone size and all
  private watched: number | null = null;
  private holding = false;
  private taken: LiveCommand = { live: "take" };

  live: LiveChannel = {

    send: (command: LiveCommand) => {

      if (command.live === "watch" || command.live === "unwatch") {

        this.watched = command.live === "watch" ? command.agentId : null;

      }

      if (command.live === "take") {

        this.taken = command;

      }

      this.sendSocket(command);

    },

    subscribe: (listener) => {

      this.liveListeners.add(listener);

      return () => this.liveListeners.delete(listener);

    },

  };

  sendSocket = (message: unknown) => {

    if (this.socket?.readyState === WebSocket.OPEN) {

      this.socket.send(JSON.stringify(message));

    }

  };

  componentDidMount() {

    addEventListener("hashchange", this.onRoute);
    document.addEventListener("visibilitychange", this.reportVisibility);
    matchMedia(WIDE).addEventListener("change", this.onResize);

    this.start();

  }

  componentWillUnmount() {

    this.closed = true;
    this.socket?.close();

    removeEventListener("hashchange", this.onRoute);
    document.removeEventListener("visibilitychange", this.reportVisibility);
    matchMedia(WIDE).removeEventListener("change", this.onResize);

  }

  onRoute = () => {

    const route = parseRoute();

    this.setState({ route });
    this.loadFor(route);

  };

  onResize = (event: MediaQueryListEvent) => this.setState({ wide: event.matches }, () => {

    const { route, wide } = this.state;

    if (wide && route.name === "browser") {

      this.markRead({ agent: route.id });

    }

  });

  /** Any request can find the session gone; every caller routes that here. */
  guard = (err: unknown) => {

    if (!(err instanceof Unauthorized)) {

      return console.error(err);

    }

    this.socket?.close();
    this.setState({ authed: false });

  };

  start = async () => {

    try {

      await this.refresh();
      this.setState({ authed: true });
      this.connect();

      // schedules run on the user's clock; until Settings names one, it is this device's rather than the server's
      const { timezone } = await api<{ timezone: string | null }>("/settings");

      if (!timezone) {

        await api("/settings", "PUT", { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

      }

    } catch (err) {

      this.guard(err);

    }

  };

  /** Everything the screens show at a glance; also re-run after a reconnect, since events sent while offline are gone. */
  refresh = async () => {

    const [agents, groups, account] = await Promise.all([api<Agent[]>("/agents"), api<GroupChat[]>("/groups"), api<Account>("/cookie")]);

    this.setState({ agents, groups, account });
    this.loadFor(this.state.route);

  };

  loadFor = (route: Route) => {

    if (route.name === "agent" || route.name === "browser") {

      api<AgentEvent[]>(`/agents/${route.id}/events`).then((events) => this.setState((state) => ({ events: { ...state.events, [route.id]: events } }))).catch(this.guard);

      if (route.name === "agent" || this.state.wide) {

        this.markRead({ agent: route.id });

      }

    }

    if (route.name === "group") {

      api<GroupMessage[]>(`/group?group=${route.id}`).then((messages) => this.setState((state) => ({ threads: { ...state.threads, [route.id]: messages } }))).catch(this.guard);
      this.markRead({ group: route.id });

    }

    if (route.name === "details" && !this.state.models) {

      api<Model[]>("/models").then((models) => this.setState({ models })).catch(this.guard);

    }

  };

  setUnread = (target: ReadTarget, count: (unread: number) => number) => this.setState((state) => ({

    agents: state.agents.map((agent) => ("agent" in target && agent.id === target.agent ? { ...agent, unread: count(agent.unread) } : agent)),
    groups: state.groups.map((group) => ("group" in target && group.id === target.group ? { ...group, unread: count(group.unread) } : group)),

  }));

  markRead = (target: ReadTarget) => {

    this.setUnread(target, () => 0);
    api("/read", "POST", target).catch(this.guard);

  };

  /** A message is read at once in the chat on screen; anywhere else it adds to that chat's unread count. */
  onMessage = (target: ReadTarget) => {

    const { route, wide } = this.state;
    const open = "agent" in target ? (route.name === "agent" || (route.name === "browser" && wide)) && route.id === target.agent : route.name === "group" && route.id === target.group;

    if (open) {

      this.markRead(target);

    } else {

      this.setUnread(target, (unread) => unread + 1);

    }

  };

  connect = () => {

    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);

    this.socket = socket;

    socket.onopen = () => {

      // the first open follows a fresh refresh; later ones mean we were away and may have missed events
      if (this.retries > 0) {

        this.refresh().catch(this.guard);

      }

      this.retries = 0;
      this.reportVisibility();

      if (this.watched !== null) {

        this.sendSocket({ live: "watch", agentId: this.watched });

        if (this.holding) {

          this.sendSocket(this.taken);

        }

      }

    };

    // the one binary message is a frame of the browser this window watches
    socket.onmessage = (message) => this.onSocket(typeof message.data === "string" ? JSON.parse(message.data) : { type: "frame", agentId: this.watched ?? 0, data: message.data });

    socket.onclose = () => {

      if (!this.closed && this.state.authed !== false) {

        this.retries += 1;
        setTimeout(this.connect, Math.min(30_000, 1000 * 2 ** this.retries));

      }

    };

  };

  /** The server holds push notifications while a window is on screen, since everything shows here live. */
  reportVisibility = () => this.sendSocket({ visible: document.visibilityState === "visible" });

  /** Adds a live line to a history on screen; one never opened loads fresh when it is. */
  append<K extends "events" | "threads">(key: K, id: number, line: AppState[K][number][number]) {

    this.setState((state) => {

      const known = state[key][id] as { id: number }[] | undefined;

      return !known || known.some((one) => one.id === line.id) ? null : { [key]: { ...state[key], [id]: [...known, line] } } as Pick<AppState, K>;

    });

  }

  onSocket = (message: SocketMessage) => {

    switch (message.type) {

      case "frame":
      case "browser":
      case "tabs":

        // mirrors the server, so a reconnect retakes only what this device still had
        if (message.type === "browser" && message.mine !== undefined) {

          this.holding = message.mine;

        }

        this.liveListeners.forEach((listener) => listener(message));
        return;

      case "event":

        this.append("events", message.event.agentId, message.event);

        if (message.event.kind === "say" || (message.event.kind === "done" && !isWaiting(message.event.text))) {

          this.onMessage({ agent: message.event.agentId });

        }

        return;

      case "state":

        this.setState((state) => ({ agents: state.agents.map((agent) => (agent.id === message.agentId ? { ...agent, state: message.state, question: message.state === "waiting" ? agent.question : null } : agent)) }));

        // the question text is not in the broadcast; fetch it so the card can show it
        if (message.state === "waiting") {

          api<Agent>(`/agents/${message.agentId}`).then(this.updateAgent).catch(this.guard);

        }

        return;

      case "group":

        this.append("threads", message.message.groupId, message.message);

        if (message.message.author !== "user") {

          this.onMessage({ group: message.message.groupId });

        }

    }

  };

  updateAgent = (agent: Agent) => this.setState((state) => ({ agents: state.agents.map((one) => (one.id === agent.id ? agent : one)) }));

  /** Allow or refuse what the agent waits on; words answer its question. */
  answer = (agentId: number) => (reply: boolean | string) => api<Agent>(`/agents/${agentId}/answer`, "POST", typeof reply === "string" ? { text: reply } : { allow: reply }).then(this.updateAgent).catch(this.guard);

  signIn = async (key: string) => {

    await api("/login", "POST", { key }).catch((err) => {

      throw err instanceof Unauthorized ? new Error("That key did not work") : err;

    });

    await this.start();

  };

  /** Nothing works without Boodle, so the app waits behind this until a cookie is in. */
  connectBoodle = async (cookie: string) => {

    await api("/cookie", "PUT", { cookie }).catch((err) => {

      this.guard(err);
      throw err;

    });

    await this.refresh();

  };

  signOut = async () => {

    await api("/logout", "POST").catch(() => {});
    this.socket?.close();
    this.setState({ authed: false });

  };

  renderRoute() {

    const { route, events, agents, groups, threads, models, wide } = this.state;

    if (route.name === "agent" || route.name === "details" || route.name === "browser") {

      const agent = agents.find((one) => one.id === route.id);

      if (!agent) {

        return <Empty text="That agent no longer exists." />;

      }

      if (route.name === "details") {

        return <Details key={agent.id} agent={agent} models={models} onChanged={this.updateAgent} onDeleted={() => { location.hash = "#/"; this.refresh().catch(this.guard); }} />;

      }

      const browser = route.name === "browser";

      return (

        <div className="flex h-full min-h-0">

          <div className={browser ? (wide ? "h-full w-[40%] min-w-[320px] border-r border-line" : "hidden") : "h-full min-w-0 grow"}>

            <Chat
              key={agent.id}
              agent={agent}
              events={events[agent.id]}
              onSend={(text) => api<Agent>(`/agents/${agent.id}/messages`, "POST", { text }).then(this.updateAgent)}
              onStop={() => api(`/agents/${agent.id}/stop`, "POST").catch(this.guard)}
              onAnswer={this.answer(agent.id)}
            />

          </div>
          {browser && <div className="h-full min-w-0 flex-1"><Browser key={agent.id} agent={agent} live={this.live} split={wide} onAnswer={this.answer(agent.id)} /></div>}

        </div>

      );

    }

    if (route.name === "group") {

      const group = groups.find((one) => one.id === route.id);

      if (!group) {

        return <Empty text="That group chat no longer exists." />;

      }

      return (

        <Group
          key={group.id}
          group={group}
          messages={threads[group.id] ?? []}
          agents={agents}
          onSend={(text) => api("/group", "POST", { text, group: group.id }).then(() => {})}
          onDelete={() => api(`/groups/${group.id}`, "DELETE").then(() => { this.setState({ groups: groups.filter((one) => one.id !== group.id) }); location.hash = "#/"; }).catch(this.guard)}
        />

      );

    }

    switch (route.name) {

      case "new":

        return <NewAgent onCreated={(agent) => { this.setState({ agents: [...agents, agent] }); location.hash = `#/agent/${agent.id}`; }} />;

      case "newGroup":

        return <NewGroup agents={agents} onCreated={(group) => { this.setState({ groups: [...groups, group] }); location.hash = `#/group/${group.id}`; }} />;

      case "settings":

        return <Settings onCookie={() => { this.setState({ models: null }); this.refresh().catch(this.guard); }} onSignOut={this.signOut} />;

    }

    return null;

  }

  render() {

    const { authed, route, wide, agents, groups, account } = this.state;

    if (mustInstall) {

      return <Install />;

    }

    if (authed === null) {

      return <div className="flex h-full items-center justify-center"><Torch size={40} /></div>;

    }

    if (!authed) {

      return <Gate key="login" title="Prometheus" label="Secret key" action="Sign in" secret submit={this.signIn} />;

    }

    if (!account.set) {

      return (

        <Gate key="connect" title="Connect Boodle" label="Boodle cookie" action="Connect" submit={this.connectBoodle}>

          <div className="flex flex-col gap-3 text-center text-[13px] leading-relaxed text-dim">

            <p className="m-0">Paste the Cookie header from any box.boodle.ai request in your browser's dev tools. Your agents think on your own Boodle account.</p>
            <p className="m-0">Your cookie is stored on this server so agents can work while you are away. Only connect if you trust whoever runs it.</p>
            <button type="button" onClick={this.signOut} className="mt-2 text-[14px] text-fg">Sign out</button>

          </div>

        </Gate>

      );

    }

    const home = <Home agents={agents} groups={groups} account={account} selected={routeKey(route)} />;
    const screen = route.name === "home" && !wide ? home : this.renderRoute() ?? <Empty text="Pick an agent, or talk to everyone." />;

    // chat and browser share a key so opening the split view preserves the draft
    const page = (

      <motion.div key={`${route.name === "browser" ? "agent" : route.name}/${"id" in route ? route.id : ""}`} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>

        {screen}

      </motion.div>

    );

    return (

      <MotionConfig reducedMotion="user">

        <AgentsContext value={agents}>

          {wide ? (

            <div className="flex h-full">

              {route.name !== "browser" && <aside className="h-full w-[340px] shrink-0 border-r border-line">{home}</aside>}
              <main className="h-full min-w-0 grow">{page}</main>

            </div>

          ) : page}

        </AgentsContext>

      </MotionConfig>

    );

  }

}

function Empty({ text }: { text: string }) {

  return <div className="flex h-full items-center justify-center px-6 text-center font-serif text-[20px] text-dim">{text}</div>;

}
