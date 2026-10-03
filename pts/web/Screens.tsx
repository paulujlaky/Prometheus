import { Component, createRef, type FormEvent } from "react";

import { Composer } from "./Chat";
import { colorOf, EveryoneGlyph, Glyph, withMentions } from "./Glyph";
import { Autosave, Bar, Button, Field, inputClass, Memo, Section, Select, Torch } from "./ui";

import { api, enablePush, pushEnabled, type Account, type Agent, type GroupMessage, type Model } from "./api";

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

        <Bar back="#/" icon={<EveryoneGlyph size={30} />} title="Everyone" subtitle={working.length ? `${working.join(", ")} working` : `${agents.length} online`} />

        <div className="grow overflow-y-auto">

          <div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-6">

            {!messages.length && <Memo text="Everyone sees what you write here. @mention an agent to ask just them, or write to all of them at once." className="text-dim" />}

            {messages.map((message) => {

              if (message.author === "user") {

                return <div key={message.id} className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-panel px-4 py-2.5 text-[15px] whitespace-pre-wrap">{withMentions(message.text, agents)}</div>;

              }

              if (message.author === "system") {

                return <div key={message.id} className="self-center text-center text-[13px] text-dim">{message.text}</div>;

              }

              // a deleted agent's messages keep its name but lose its mascot
              const author = agents.find((agent) => agent.id === message.agentId);

              return (

                <div key={message.id} className="flex flex-col gap-1.5">

                  <span className="flex items-center gap-2 text-[13px] font-medium" style={author ? { color: colorOf(author) } : undefined}>

                    {author ? <Glyph glyph={author.glyph} size={20} live={author.state === "running"} /> : <EveryoneGlyph size={20} />}
                    {message.author}

                  </span>
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

/** The model comes from settings, so creating an agent is just who it is. */
export class NewAgent extends Component<{ onCreated: (agent: Agent) => void }, { name: string; persona: string; error: string; busy: boolean }> {

  state = { name: "", persona: "", error: "", busy: false };

  submit = async (event: FormEvent) => {

    event.preventDefault();
    this.setState({ busy: true, error: "" });

    try {

      this.props.onCreated(await api<Agent>("/agents", "POST", { name: this.state.name.trim(), persona: this.state.persona.trim() }));

    } catch (err) {

      this.setState({ error: err instanceof Error ? err.message : String(err), busy: false });

    }

  };

  render() {

    return (

      <div className="flex h-full flex-col">

        <Bar back="#/" title="New agent" />

        <form onSubmit={this.submit} className="mx-auto flex w-full max-w-lg flex-col gap-6 overflow-y-auto px-6 py-6">

          <Field label="Name">

            <input value={this.state.name} onChange={(event) => this.setState({ name: event.target.value })} placeholder="Scout" autoFocus className={inputClass} />

          </Field>

          <Field label="Who it is">

            <textarea rows={3} value={this.state.persona} onChange={(event) => this.setState({ persona: event.target.value })} placeholder="A careful research assistant. Checks sources and says when it isn’t sure." className={inputClass} />

          </Field>

          {this.state.error && <p className="m-0 text-[14px] text-dim">{this.state.error}</p>}

          <Button type="submit" tone="primary" disabled={!this.state.name.trim() || this.state.busy}>Create</Button>

        </form>

      </div>

    );

  }

}

interface SettingsState {

  account: Account | null;
  cookie: string;

  push: boolean;
  user: string;

  models: Model[];
  defaultModel: string | null;

  note: string;

}

export class Settings extends Component<{ onCookie: () => void; onSignOut: () => void }, SettingsState> {

  state: SettingsState = { account: null, cookie: "", push: false, user: "", models: [], defaultModel: null, note: "" };

  private saver = new Autosave((note) => this.flash(note));
  private noteTimer: ReturnType<typeof setTimeout> | undefined;

  async componentDidMount() {

    const [account, user, push] = await Promise.all([api<Account>("/cookie"), api<{ text: string }>("/user"), pushEnabled()]);

    this.setState({ account, user: user.text, push });

    if (account.set) {

      this.loadModels();

    }

  }

  /** Needs Boodle, so it waits for a connected cookie. */
  loadModels = async () => {

    const [models, settings] = await Promise.all([api<Model[]>("/models"), api<{ defaultModel: string | null }>("/settings")]);

    this.setState({ models, defaultModel: settings.defaultModel });

  };

  chooseModel = (defaultModel: string) => this.attempt(async () => {

    await api("/settings", "PUT", { defaultModel });
    this.setState({ defaultModel });

  }, "Saved");

  componentWillUnmount() {

    this.saver.flush();
    clearTimeout(this.noteTimer);

  }

  flash = (note: string, hold = 2000) => {

    clearTimeout(this.noteTimer);
    this.setState({ note });
    this.noteTimer = setTimeout(() => this.setState({ note: "" }), hold);

  };

  attempt = async (work: () => Promise<unknown>, done: string) => {

    try {

      await work();
      this.flash(done);

    } catch (err) {

      // failures stay up longer: they usually carry an instruction
      this.flash(err instanceof Error ? err.message : String(err), 6000);

    }

  };

  connect = () => this.attempt(async () => {

    const saved = await api<Account & { userId: string }>("/cookie", "PUT", { cookie: this.state.cookie.trim() });

    this.setState({ account: { set: true, name: saved.name, email: saved.email }, cookie: "" });
    this.props.onCookie();
    this.loadModels();

  }, "Connected");

  render() {

    const { account, push, note } = this.state;

    return (

      <div className="flex h-full flex-col">

        <Bar back="#/" title="Settings" actions={note && <span className="max-w-[60%] truncate px-3 text-[13px] text-dim">{note}</span>} />

        <div className="grow overflow-y-auto">

          <div className="mx-auto flex w-full max-w-lg flex-col gap-9 px-6 py-6">

            <Section title="Boodle" description={account?.set ? "Connected" : "Paste your Boodle cookie"}>

              <div className="flex gap-2">

                <input value={this.state.cookie} onChange={(event) => this.setState({ cookie: event.target.value })} placeholder="d=…; teamID=…" aria-label="Boodle cookie" className={`${inputClass} min-w-0 font-mono text-[13px]`} />
                <button type="button" disabled={!this.state.cookie.trim()} onClick={this.connect} className="shrink-0 rounded-xl border border-line px-5 text-[15px] text-fg disabled:opacity-40">Connect</button>

              </div>

            </Section>

            <Section
              title="Notifications"
              description={push ? "On" : "Off"}
              action={push ? undefined : <Button onClick={() => this.attempt(async () => { await enablePush(); this.setState({ push: true }); }, "Notifications on")}>Turn on</Button>}
            />

            {this.state.models.length > 0 && (

              <Section
                title="Model"
                description="For new agents"
                action={<Select label="Model for new agents" value={this.state.defaultModel ?? ""} options={this.state.models.map((model) => ({ value: model.id, label: model.name }))} onChange={this.chooseModel} />}
              />

            )}

            <Section title="About you" description="Shared with every agent">

              <textarea rows={6} value={this.state.user} aria-label="About you" placeholder="Name, time zone, how you like answers…" onChange={(event) => { const text = event.target.value; this.setState({ user: text }); this.saver.queue("user", () => api("/user", "PUT", { text })); }} className={inputClass} />

            </Section>

            <Section title="Sign out" action={<Button onClick={this.props.onSignOut}>Sign out</Button>} />

          </div>

        </div>

      </div>

    );

  }

}
