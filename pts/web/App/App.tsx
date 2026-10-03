import { motion, MotionConfig } from "motion/react";
import { Component } from "react";

import { Torch } from "../Components/Layout";
import { Install, mustInstall } from "../Screens/Account/Install";
import { Login } from "../Screens/Account/Login";
import { Settings } from "../Screens/Account/Settings";
import { Chat } from "../Screens/Agent/Chat";
import { Details } from "../Screens/Agent/Details";
import { Group } from "../Screens/Group/Group";
import { Home } from "../Screens/Home/Home";
import { NewAgent } from "../Screens/Home/NewAgent";

import { AgentsContext } from "./context";
import { api, Unauthorized, type Account, type Agent, type AgentEvent, type GroupMessage, type Model, type SocketMessage } from "../Lib/api";

type Route =

  | { name: "home" }
  | { name: "agent" | "details"; id: number }
  | { name: "group" | "settings" | "new" };

interface AppState {

  /** null while the first request decides whether the session cookie still works. */
  authed: boolean | null;

  route: Route;
  wide: boolean;

  agents: Agent[];
  events: Record<number, AgentEvent[]>;
  group: GroupMessage[];

  account: Account;
  models: Model[] | null;

}

const WIDE = "(min-width: 960px)";

function parseRoute(): Route {

  const [name, id, sub] = location.hash.replace(/^#\/?/, "").split("/");

  if (name === "agent" && Number(id)) {

    return { name: sub === "details" ? "details" : "agent", id: Number(id) };

  }

  return name === "group" || name === "settings" || name === "new" ? { name } : { name: "home" };

}

function routeKey(route: Route): string {

  return "id" in route ? `agent/${route.id}` : route.name;

}

export class App extends Component<{}, AppState> {

  state: AppState = { authed: null, route: parseRoute(), wide: matchMedia(WIDE).matches, agents: [], events: {}, group: [], account: { set: true, name: null, email: null }, models: null };

  private socket: WebSocket | null = null;
  private retries = 0;
  private closed = false;

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
      this.loadFor(this.state.route);

    } catch (err) {

      this.guard(err);

    }

  };

  /** Everything the screens show at a glance; also re-run after a reconnect, since events sent while offline are gone. */
  refresh = async () => {

    const [agents, group, cookie] = await Promise.all([api<Agent[]>("/agents"), api<GroupMessage[]>("/group"), api<Account>("/cookie")]);

    this.setState({ agents, group, account: cookie });

    const route = this.state.route;

    if ("id" in route) {

      await this.loadEvents(route.id);

    }

  };

  loadFor = (route: Route) => {

    if (route.name === "agent") {

      this.loadEvents(route.id).catch(this.guard);

    }

    if (route.name === "details" && !this.state.models) {

      api<Model[]>("/models").then((models) => this.setState({ models })).catch(this.guard);

    }

  };

  loadEvents = async (agentId: number) => {

    const events = await api<AgentEvent[]>(`/agents/${agentId}/events`);

    this.setState((state) => ({ events: { ...state.events, [agentId]: events } }));

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

    };

    socket.onmessage = (message) => this.onSocket(JSON.parse(message.data));

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

      this.setState((state) => ({ group: [...state.group, message.message] }));

    }

  };

  updateAgent = (agent: Agent) => this.setState((state) => ({ agents: state.agents.map((one) => (one.id === agent.id ? agent : one)) }));

  agentById(id: number): Agent | undefined {

    return this.state.agents.find((agent) => agent.id === id);

  }

  signOut = async () => {

    await api("/logout", "POST").catch(() => {});
    this.socket?.close();
    this.setState({ authed: false });

  };

  renderRoute() {

    const { route, events, agents, group, models } = this.state;

    if (route.name === "agent" || route.name === "details") {

      const agent = this.agentById(route.id);

      if (!agent) {

        return <Empty text="That agent no longer exists." />;

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
          onAnswer={(allow) => api<Agent>(`/agents/${agent.id}/answer`, "POST", { allow }).then(this.updateAgent).catch(this.guard)}
        />

      );

    }

    if (route.name === "group") {

      return <Group messages={group} agents={agents} onSend={(text) => api("/group", "POST", { text }).then(() => {})} />;

    }

    if (route.name === "new") {

      return <NewAgent onCreated={(agent) => { this.setState({ agents: [...agents, agent] }); location.hash = `#/agent/${agent.id}`; }} />;

    }

    if (route.name === "settings") {

      return <Settings onCookie={() => { this.setState({ models: null }); this.refresh().catch(this.guard); }} onSignOut={this.signOut} />;

    }

    return null;

  }

  render() {

    const { authed, route, wide, agents, account } = this.state;

    if (mustInstall) {

      return <Install />;

    }

    if (authed === null) {

      return <div className="flex h-full items-center justify-center"><Torch size={40} /></div>;

    }

    if (!authed) {

      return <Login onDone={this.start} />;

    }

    const home = <Home agents={agents} account={account} selected={routeKey(route)} />;
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
