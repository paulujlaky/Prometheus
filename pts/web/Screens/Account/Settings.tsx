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

  timezone: string;

  proxy: string | null;
  proxyInput: string;

  note: string;

}

const ZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export class Settings extends Component<{ onCookie: () => void; onSignOut: () => void }, SettingsState> {

  state: SettingsState = { account: null, cookie: "", push: false, user: "", models: [], defaultModel: null, timezone: "", proxy: null, proxyInput: "", note: "" };

  private saver = new Autosave((note) => this.flash(note));
  private noteTimer: ReturnType<typeof setTimeout> | undefined;
  private timezoneSaved = "";

  async componentDidMount() {

    const [account, user, push, settings] = await Promise.all([
      api<Account>("/cookie"),
      api<{ text: string }>("/user"),
      pushEnabled(),
      api<{ defaultModel: string | null; timezone: string | null; proxy: string | null }>("/settings"),
    ]);

    this.timezoneSaved = settings.timezone ?? "";
    this.setState({ account, user: user.text, push, timezone: this.timezoneSaved, defaultModel: settings.defaultModel, proxy: settings.proxy });

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

  saveTimezone = (next?: string) => {

    const timezone = (next ?? this.state.timezone).trim();

    if (timezone === this.timezoneSaved) {

      return;

    }

    this.attempt(async () => {

      await api("/settings", "PUT", { timezone });
      this.timezoneSaved = timezone;
      this.setState({ timezone });

    }, "Saved");

  };

  /** An empty address goes back to browsing direct. Agents' browsers restart onto the change, keeping their tabs. */
  saveProxy = (proxy: string) => this.attempt(async () => {

    const saved = await api<{ proxy: string | null }>("/settings", "PUT", { proxy });

    this.setState({ proxy: saved.proxy, proxyInput: "" });

  }, proxy ? "Proxy on" : "Proxy off");

  useDeviceZone = () => {

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    this.setState({ timezone });
    this.saveTimezone(timezone);

  };

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

        <Bar back="#/" backAlways title="Settings" actions={note && <span className="max-w-[60%] truncate px-3 text-[13px] text-dim">{note}</span>} />

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

            <Section title="Time zone" description="Used for routines, scheduling and agents' browsers">

              <div className="flex gap-2">

                <input list="time-zones" value={this.state.timezone} aria-label="Time zone" placeholder="Server time" onChange={(event) => this.setState({ timezone: event.target.value })} onBlur={() => this.saveTimezone()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); this.saveTimezone(); } }} className={`${inputClass} min-w-0`} />
                <datalist id="time-zones">{ZONES.map((zone) => <option key={zone} value={zone} />)}</datalist>
                <button type="button" onClick={this.useDeviceZone} className="shrink-0 rounded-xl border border-line px-5 text-[15px] text-fg">This device</button>

              </div>

            </Section>

            <Section title="Proxy" description={this.state.proxy ? `Browsing through ${this.state.proxy}` : "Agents browse from this server"}>

              <div className="flex gap-2">

                <input value={this.state.proxyInput} type="password" autoComplete="off" onChange={(event) => this.setState({ proxyInput: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter" && this.state.proxyInput.trim()) { event.preventDefault(); this.saveProxy(this.state.proxyInput.trim()); } }} placeholder="http://user:pass@host:port" aria-label="HTTP proxy" className={`${inputClass} min-w-0 font-mono text-[13px]`} />
                <button type="button" disabled={!this.state.proxyInput.trim()} onClick={() => this.saveProxy(this.state.proxyInput.trim())} className="shrink-0 rounded-xl border border-line px-5 text-[15px] text-fg disabled:opacity-40">Save</button>
                {this.state.proxy && <button type="button" onClick={() => this.saveProxy("")} className="shrink-0 rounded-xl border border-line px-5 text-[15px] text-fg">Off</button>}

              </div>

            </Section>

            <Section title="About you" description="Context for agents to respond better">

              <textarea rows={6} value={this.state.user} aria-label="About you" placeholder="Name, how you like answers…" onChange={(event) => { const text = event.target.value; this.setState({ user: text }); this.saver.queue("user", () => api("/user", "PUT", { text })); }} className={inputClass} />

            </Section>

            <Section title="Sign out" action={<Button onClick={this.props.onSignOut}>Sign out</Button>} />

          </div>

        </div>

      </div>

    );

  }

}
