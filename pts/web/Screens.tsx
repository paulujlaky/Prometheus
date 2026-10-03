import { Component, createRef, type FormEvent } from "react";

import { Composer } from "./Chat";
import { Bar, Button, Field, inputClass, Memo, Torch } from "./ui";

import { api, enablePush, pushEnabled, type Agent, type GroupMessage, type Model } from "./api";

export class Login extends Component<{ onDone: () => void }, { token: string; error: string; busy: boolean }> {

  state = { token: "", error: "", busy: false };

  submit = async (event: FormEvent) => {

    event.preventDefault();
    this.setState({ busy: true, error: "" });

    try {

      await api("/login", "POST", { token: this.state.token.trim() });
      this.props.onDone();

    } catch (err) {

      this.setState({ error: err instanceof Error ? err.message : String(err), busy: false });

    }

  };

  render() {

    return (

      <form onSubmit={this.submit} className="mx-auto flex h-full max-w-sm flex-col justify-center gap-8 px-6">

        <div className="flex flex-col items-center gap-4">

          <Torch size={64} />
          <h1 className="m-0 font-serif text-[34px] font-normal">Prometheus</h1>

        </div>

        <Field label="Access token" hint={this.state.error || "The PTS_TOKEN your server was started with."}>

          <input type="password" autoComplete="current-password" autoFocus value={this.state.token} onChange={(event) => this.setState({ token: event.target.value })} className={inputClass} />

        </Field>

        <Button type="submit" tone="primary" disabled={!this.state.token.trim() || this.state.busy}>Sign in</Button>

      </form>

    );

  }

}

interface GroupProps {

  messages: GroupMessage[];
  agents: Agent[];

  onSend: (text: string) => Promise<void>;

}

export class Group extends Component<GroupProps> {

  private end = createRef<HTMLDivElement>();

  componentDidMount() {

    this.end.current?.scrollIntoView();

  }

  componentDidUpdate(previous: GroupProps) {

    if (previous.messages.length !== this.props.messages.length) {

      this.end.current?.scrollIntoView({ behavior: "smooth" });

    }

  }

  render() {

    const { messages, agents } = this.props;
    const working = agents.filter((agent) => agent.state === "running").map((agent) => agent.name);

    return (

      <div className="flex h-full flex-col">

        <Bar back="#/" title="Everyone" subtitle={working.length ? `${working.join(", ")} working` : `You and ${agents.length} ${agents.length === 1 ? "agent" : "agents"}`} />

        <div className="grow overflow-y-auto">

          <div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-6">

            {!messages.length && <Memo text="Everyone sees what you write here. @mention an agent to ask just them, or write to all of them at once." className="text-dim" />}

            {messages.map((message) => {

              if (message.author === "user") {

                return <div key={message.id} className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-panel px-4 py-2.5 text-[15px] whitespace-pre-wrap">{message.text}</div>;

              }

              if (message.author === "system") {

                return <div key={message.id} className="self-center text-center text-[13px] text-dim">{message.text}</div>;

              }

              return (

                <div key={message.id} className="flex flex-col gap-1">

                  <span className="text-[13px] text-dim">{message.author}</span>
                  <Memo text={message.text} />

                </div>

              );

            })}

            <div ref={this.end} />

          </div>

        </div>

        <Composer placeholder="Message everyone, or @mention" onSend={this.props.onSend} />

      </div>

    );

  }

}

interface NewAgentProps {

  models: Model[] | null;
  onCreated: (agent: Agent) => void;

}

export class NewAgent extends Component<NewAgentProps, { name: string; modelId: string; persona: string; error: string; busy: boolean }> {

  state = { name: "", modelId: "", persona: "", error: "", busy: false };

  submit = async (event: FormEvent) => {

    event.preventDefault();
    this.setState({ busy: true, error: "" });

    try {

      const modelId = this.state.modelId || this.props.models?.[0]?.id || "";

      this.props.onCreated(await api<Agent>("/agents", "POST", { name: this.state.name.trim(), modelId, persona: this.state.persona.trim() }));

    } catch (err) {

      this.setState({ error: err instanceof Error ? err.message : String(err), busy: false });

    }

  };

  render() {

    const { models } = this.props;

    return (

      <div className="flex h-full flex-col">

        <Bar back="#/" title="New agent" />

        <form onSubmit={this.submit} className="mx-auto flex w-full max-w-lg flex-col gap-6 overflow-y-auto px-6 py-6">

          <Field label="Name">

            <input value={this.state.name} onChange={(event) => this.setState({ name: event.target.value })} placeholder="Scout" autoFocus className={inputClass} />

          </Field>

          <Field label="Model">

            <select value={this.state.modelId || models?.[0]?.id || ""} onChange={(event) => this.setState({ modelId: event.target.value })} disabled={!models} className={inputClass}>

              {(models ?? []).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}

            </select>

          </Field>

          <Field label="Who it is" hint="A line or two. You can change it later.">

            <textarea rows={3} value={this.state.persona} onChange={(event) => this.setState({ persona: event.target.value })} placeholder="A careful research assistant. Checks sources and says when it isn’t sure." className={inputClass} />

          </Field>

          {this.state.error && <p className="m-0 text-[14px] text-dim">{this.state.error}</p>}

          <Button type="submit" tone="primary" disabled={!this.state.name.trim() || !models?.length || this.state.busy}>Create</Button>

        </form>

      </div>

    );

  }

}

interface SettingsState {

  cookieUser: string | null;
  cookie: string;

  push: boolean;
  user: string;

  note: string;

}

export class Settings extends Component<{ onCookie: () => void; onSignOut: () => void }, SettingsState> {

  state: SettingsState = { cookieUser: null, cookie: "", push: false, user: "", note: "" };

  async componentDidMount() {

    const [cookie, user, push] = await Promise.all([api<{ set: boolean; userId: string | null }>("/cookie"), api<{ text: string }>("/user"), pushEnabled()]);

    this.setState({ cookieUser: cookie.userId, user: user.text, push });

  }

  act = async (work: () => Promise<unknown>, done: string) => {

    try {

      await work();
      this.setState({ note: done });

    } catch (err) {

      this.setState({ note: err instanceof Error ? err.message : String(err) });

    }

  };

  saveCookie = () => this.act(async () => {

    const saved = await api<{ userId: string }>("/cookie", "PUT", { cookie: this.state.cookie });

    this.setState({ cookieUser: saved.userId, cookie: "" });
    this.props.onCookie();

  }, "Boodle connected.");

  render() {

    const { cookieUser, push, note } = this.state;

    return (

      <div className="flex h-full flex-col">

        <Bar back="#/" title="Settings" />

        <div className="mx-auto flex w-full max-w-lg flex-col gap-10 overflow-y-auto px-6 py-6">

          {note && <p className="m-0 rounded-xl bg-panel px-4 py-3 text-[14px]">{note}</p>}

          <section className="flex flex-col gap-3">

            <h2 className="m-0 font-serif text-[21px] font-normal">Boodle</h2>
            <p className="m-0 text-[14px] text-dim">{cookieUser ? "Connected. Paste a new cookie here if agents start failing." : "Not connected. Paste the full Cookie header from a signed-in box.boodle.ai tab."}</p>
            <textarea rows={3} value={this.state.cookie} onChange={(event) => this.setState({ cookie: event.target.value })} placeholder="d=…; teamID=…" aria-label="Boodle cookie" className={`${inputClass} font-mono text-[13px]`} />
            <Button className="self-start" disabled={!this.state.cookie.trim()} onClick={this.saveCookie}>Save cookie</Button>

          </section>

          <section className="flex flex-col gap-3">

            <h2 className="m-0 font-serif text-[21px] font-normal">Notifications</h2>
            <p className="m-0 text-[14px] text-dim">{push ? "On for this device." : "Hear when an agent finishes or needs your OK."}</p>
            {!push && <Button className="self-start" onClick={() => this.act(async () => { await enablePush(); this.setState({ push: true }); }, "Notifications on.")}>Turn on</Button>}

          </section>

          <section className="flex flex-col gap-3">

            <h2 className="m-0 font-serif text-[21px] font-normal">About you</h2>
            <p className="m-0 text-[14px] text-dim">Every agent reads this before each task.</p>
            <textarea rows={6} value={this.state.user} onChange={(event) => this.setState({ user: event.target.value })} placeholder="Name, time zone, how you like answers…" aria-label="About you" className={inputClass} />
            <Button className="self-start" onClick={() => this.act(() => api("/user", "PUT", { text: this.state.user }), "Saved.")}>Save</Button>

          </section>

          <Button className="self-start" onClick={this.props.onSignOut}>Sign out</Button>

        </div>

      </div>

    );

  }

}
