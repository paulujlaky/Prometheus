import { Component } from "react";

import { Button, inputClass, Select } from "../../Components/Controls";
import { Bar, Section } from "../../Components/Layout";

import { api, enablePush, pushEnabled, type Account, type Model } from "../../Lib/api";
import { Autosave } from "../../Lib/autosave";

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

          <div className="mx-auto flex w-full max-w-2xl flex-col gap-9 px-[23px] py-6 md:px-8">

            <Section title="Boodle" description={account?.set ? "Connected" : "Not Connected"}>

              <div className="flex gap-2">

                <input value={this.state.cookie} onChange={(event) => this.setState({ cookie: event.target.value })} placeholder="d=…; teamID=…" aria-label="Boodle cookie" className={`${inputClass} min-w-0 font-mono text-[13px]`} />
                <button type="button" disabled={!this.state.cookie.trim()} onClick={this.connect} className="shrink-0 rounded-xl border border-line px-5 text-[15px] text-fg disabled:opacity-40">Connect</button>

              </div>

            </Section>

            <Section
              title="Notifications"
              description="Get pinged when agents need you"
              action={push ? undefined : <Button onClick={() => this.attempt(async () => { await enablePush(); this.setState({ push: true }); }, "Notifications on")}>Turn on</Button>}
            />

            {this.state.models.length > 0 && (

              <Section
                title="Model"
                description="New agents use this by default"
                action={<Select label="Model for new agents" value={this.state.defaultModel ?? ""} options={this.state.models.map((model) => ({ value: model.id, label: model.name }))} onChange={this.chooseModel} />}
              />

            )}

            <Section title="About you" description="Context for agents to respond better">

              <textarea rows={6} value={this.state.user} aria-label="About you" placeholder="Name, time zone, how you like answers…" onChange={(event) => { const text = event.target.value; this.setState({ user: text }); this.saver.queue("user", () => api("/user", "PUT", { text })); }} className={inputClass} />

            </Section>

            <Section title="Sign out" action={<Button onClick={this.props.onSignOut}>Sign out</Button>} />

          </div>

        </div>

      </div>

    );

  }

}
