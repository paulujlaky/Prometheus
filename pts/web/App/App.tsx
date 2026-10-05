import { motion, MotionConfig } from "motion/react";
import { Component } from "react";

import { Torch } from "../Components/Layout";
import { Install, mustInstall } from "../Screens/Account/Install";
import { Login } from "../Screens/Account/Login";
import { Settings } from "../Screens/Account/Settings";
import { Browser } from "../Screens/Agent/Browser";
import { Chat } from "../Screens/Agent/Chat";
import { Details } from "../Screens/Agent/Details";
import { Group } from "../Screens/Group/Group";
import { Home } from "../Screens/Home/Home";
import { NewAgent } from "../Screens/Home/NewAgent";
import { NewGroup } from "../Screens/Home/NewGroup";

import { isWaiting } from "../../Features/Group";
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

  if (name === "new" && id === "group") {

    return { name: "newGroup" };

  }

  return name === "settings" || name === "new" ? { name } : { name: "home" };

}

function routeKey(route: Route): string {

  return "id" in route ? `${route.name === "group" ? "group" : "agent"}/${route.id}` : route.name;

}

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

      if (command.live === "watch") {

        this.watched = command.agentId;

      }

      if (command.live === "take") {

        this.taken = command;

      }

      if (command.live === "unwatch") {

        this.watched = null;

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

  onResize = (event: MediaQueryListEvent) => this.setState({ wide: event.matches });

  /** Any request can find the session gone; every caller routes that here. */
  guard = (err: unknown) => {

    if (err instanceof Unauthorized) {

      this.socket?.close();
      this.setState({ authed: false });
      return;

    }

    console.error(err);

  };

  start = async () => {

    try {

      await this.refresh();
      this.setState({ authed: true });
      this.connect();
      this.adoptZone().catch(this.guard);

    } catch (err) {

      this.guard(err);

    }

  };

  /** Schedules run on the user's clock; until Settings names one, it is this device's rather than the server's. */
  adoptZone = async () => {

    const { timezone } = await api<{ timezone: string | null }>("/settings");

    if (!timezone) {

      await api("/settings", "PUT", { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

    }

  };

  /** Everything the screens show at a glance; also re-run after a reconnect, since events sent while offline are gone. */
  refresh = async () => {

    const [agents, groups, cookie] = await Promise.all([api<Agent[]>("/agents"), api<GroupChat[]>("/groups"), api<Account>("/cookie")]);

    this.setState({ agents, groups, account: cookie });
    this.loadFor(this.state.route);

  };

  loadFor = (route: Route) => {

    if (route.name === "agent") {

      this.loadEvents(route.id).catch(this.guard);
      this.markRead({ agent: route.id });

    }

    if (route.name === "group") {

      api<GroupMessage[]>(`/group?group=${route.id}`).then((messages) => this.setState((state) => ({ threads: { ...state.threads, [route.id]: messages } }))).catch(this.guard);
      this.markRead({ group: route.id });

    }

    if (route.name === "details" && !this.state.models) {

      api<Model[]>("/models").then((models) => this.setState({ models })).catch(this.guard);

    }

  };

  loadEvents = async (agentId: number) => {

    const events = await api<AgentEvent[]>(`/agents/${agentId}/events`);

    this.setState((state) => ({ events: { ...state.events, [agentId]: events } }));

  };

  setUnread = (target: ReadTarget, count: (unread: number) => number) => {

    if ("agent" in target) {

      this.setState((state) => ({ agents: state.agents.map((agent) => (agent.id === target.agent ? { ...agent, unread: count(agent.unread) } : agent)) }));
      return;

    }

    this.setState((state) => ({ groups: state.groups.map((group) => (group.id === target.group ? { ...group, unread: count(group.unread) } : group)) }));

  };

  markRead = (target: ReadTarget) => {

    this.setUnread(target, () => 0);
    api("/read", "POST", target).catch(this.guard);

  };

  /** A message is read at once in the chat on screen; anywhere else it adds to that chat's unread count. */
  onMessage = (target: ReadTarget) => {

    const { route } = this.state;
    const open = "agent" in target ? route.name === "agent" && route.id === target.agent : route.name === "group" && route.id === target.group;

    if (open) {

      this.markRead(target);
      return;

    }

    this.setUnread(target, (unread) => unread + 1);

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

      if (this.closed || this.state.authed === false) {

        return;

      }

      this.retries += 1;
      setTimeout(this.connect, Math.min(30_000, 1000 * 2 ** this.retries));

    };

  };

  /** The server holds push notifications while a window is on screen, since everything shows here live. */
  reportVisibility = () => {

    if (this.socket?.readyState === WebSocket.OPEN) {

      this.socket.send(JSON.stringify({ visible: document.visibilityState === "visible" }));

    }

  };

  onSocket = (message: SocketMessage) => {

    if (message.type === "frame" || message.type === "browser") {

      // mirrors the server, so a reconnect retakes only what this device still had
      if (message.type === "browser" && message.mine !== undefined) {

        this.holding = message.mine;

      }

      for (const listener of this.liveListeners) {

        listener(message);

      }

      return;

    }

    if (message.type === "event") {

      const { event } = message;

      this.setState((state) => {

        const known = state.events[event.agentId];

        // an agent whose chat was never opened loads its history fresh when it is
        if (!known || known.some((one) => one.id === event.id)) {

          return null;

        }

        return { events: { ...state.events, [event.agentId]: [...known, event] } };

      });

      if (event.kind === "say" || (event.kind === "done" && !isWaiting(event.text))) {

        this.onMessage({ agent: event.agentId });

      }

      return;

    }

    if (message.type === "state") {

      this.setState((state) => ({ agents: state.agents.map((agent) => (agent.id === message.agentId ? { ...agent, state: message.state, question: message.state === "waiting" ? agent.question : null } : agent)) }));

      // the question text is not in the broadcast; fetch it so the card can show it
      if (message.state === "waiting") {

        api<Agent>(`/agents/${message.agentId}`).then(this.updateAgent).catch(this.guard);

      }

      return;

    }

    if (message.type === "group") {

      const line = message.message;

      this.setState((state) => {

        const known = state.threads[line.groupId];

        // like agent events: a thread never opened loads fresh when it is
        if (!known || known.some((one) => one.id === line.id)) {

          return null;

        }

        return { threads: { ...state.threads, [line.groupId]: [...known, line] } };

      });

      if (line.author !== "user") {

        this.onMessage({ group: line.groupId });

      }

    }

  };

  updateAgent = (agent: Agent) => this.setState((state) => ({ agents: state.agents.map((one) => (one.id === agent.id ? agent : one)) }));

  /** Allow or refuse what the agent waits on; words answer its question. */
  answer = (agentId: number) => (reply: boolean | string) => api<Agent>(`/agents/${agentId}/answer`, "POST", typeof reply === "string" ? { text: reply } : { allow: reply }).then(this.updateAgent).catch(this.guard);

  agentById(id: number): Agent | undefined {

    return this.state.agents.find((agent) => agent.id === id);

  }

  signOut = async () => {

    await api("/logout", "POST").catch(() => {});
    this.socket?.close();
    this.setState({ authed: false });

  };

  renderRoute() {

    const { route, events, agents, groups, threads, models } = this.state;

    if (route.name === "agent" || route.name === "details" || route.name === "browser") {

      const agent = this.agentById(route.id);

      if (!agent) {

        return <Empty text="That agent no longer exists." />;

      }

      if (route.name === "browser") {

        return <Browser key={agent.id} agent={agent} live={this.live} onAnswer={this.answer(agent.id)} />;

      }

      if (route.name === "details") {

        return <Details key={agent.id} agent={agent} models={models} onChanged={this.updateAgent} onDeleted={() => { location.hash = "#/"; this.refresh().catch(this.guard); }} />;

      }

      return (

        <Chat
          key={agent.id}
          agent={agent}
          events={events[agent.id]}
          onSend={(text) => api<Agent>(`/agents/${agent.id}/messages`, "POST", { text }).then(this.updateAgent)}
          onStop={() => api(`/agents/${agent.id}/stop`, "POST").catch(this.guard)}
          onAnswer={this.answer(agent.id)}
        />

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

    if (route.name === "new") {

      return <NewAgent onCreated={(agent) => { this.setState({ agents: [...agents, agent] }); location.hash = `#/agent/${agent.id}`; }} />;

    }

    if (route.name === "newGroup") {

      return <NewGroup agents={agents} onCreated={(group) => { this.setState({ groups: [...groups, group] }); location.hash = `#/group/${group.id}`; }} />;

    }

    if (route.name === "settings") {

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

      return <Login onDone={this.start} />;

    }

    const home = <Home agents={agents} groups={groups} account={account} selected={routeKey(route)} />;
    const screen = route.name === "home" && !wide ? home : this.renderRoute() ?? <Empty text="Pick an agent, or talk to everyone." />;

    // keyed by screen, not agent alone, so moving from a chat to its details fades too
    const page = (

      <motion.div key={`${route.name}/${"id" in route ? route.id : ""}`} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>

        {screen}

      </motion.div>

    );

    return (

      <MotionConfig reducedMotion="user">

        <AgentsContext value={agents}>

          {wide ? (

            <div className="flex h-full">

              <aside className="h-full w-[340px] shrink-0 border-r border-line">{home}</aside>
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
