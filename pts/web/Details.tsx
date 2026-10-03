import { Component } from "react";

import { Autosave, Bar, Button, inputClass, Section, Switch } from "./ui";

import { api, type Agent, type Model, type Routine } from "./api";
import { describeSchedule, describeWatch } from "./thread";

interface DetailsProps {

  agent: Agent;
  models: Model[] | null;

  onChanged: (agent: Agent) => void;
  onDeleted: () => void;

}

interface DetailsState {

  persona: string;
  memory: string;

  routines: Routine[];
  open: number | null;

  note: string;

}

function when(routine: Routine): string {

  return routine.kind === "schedule" ? describeSchedule(routine.spec) : describeWatch(routine.target, routine.spec);

}

export class Details extends Component<DetailsProps, DetailsState> {

  state: DetailsState = { persona: this.props.agent.persona, memory: "", routines: [], open: null, note: "" };

  private saver = new Autosave((note) => this.flash(note));
  private noteTimer: ReturnType<typeof setTimeout> | undefined;

  async componentDidMount() {

    const [memory, routines] = await Promise.all([api<{ text: string }>(`/agents/${this.props.agent.id}/memory`), this.loadRoutines()]);

    this.setState({ memory: memory.text, routines });

  }

  componentWillUnmount() {

    this.saver.flush();
    clearTimeout(this.noteTimer);

  }

  flash = (note: string) => {

    clearTimeout(this.noteTimer);
    this.setState({ note });
    this.noteTimer = setTimeout(() => this.setState({ note: "" }), 2000);

  };

  loadRoutines = () => api<Routine[]>(`/agents/${this.props.agent.id}/routines`);

  /** Routine changes refresh the list; their errors show where "Saved" would. */
  routineAction = async (work: () => Promise<unknown>) => {

    try {

      await work();
      this.setState({ routines: await this.loadRoutines() });

    } catch (err) {

      this.flash(err instanceof Error ? err.message : String(err));

    }

  };

  patch = (changes: Partial<Pick<Agent, "persona" | "modelId">>) => api<Agent>(`/agents/${this.props.agent.id}`, "PATCH", changes).then(this.props.onChanged);

  deleteAgent = () => {

    if (confirm(`Delete ${this.props.agent.name}? Its chat and routines go too; its files stay on the server.`)) {

      api(`/agents/${this.props.agent.id}`, "DELETE").then(this.props.onDeleted).catch((err) => this.flash(String(err)));

    }

  };

  renderRoutine(routine: Routine) {

    const open = this.state.open === routine.id;

    return (

      <li key={routine.id} className="flex flex-col border-t border-line first:border-t-0">

        <div className="flex items-center gap-4 py-3">

          <button type="button" aria-expanded={open} onClick={() => this.setState({ open: open ? null : routine.id })} className="flex min-w-0 grow flex-col text-left">

            <span className={`truncate text-[15px] ${routine.enabled ? "" : "text-dim"}`}>{routine.task.split("\n")[0]}</span>
            <span className="truncate text-[13px] text-dim">{when(routine)}</span>

          </button>

          <Switch checked={routine.enabled} label={routine.enabled ? "Pause routine" : "Resume routine"} onChange={(enabled) => this.routineAction(() => api(`/routines/${routine.id}`, "PATCH", { enabled }))} />

        </div>

        {open && (

          <div className="flex gap-5 pb-3 text-[14px]">

            <button type="button" className="text-fg" onClick={() => this.routineAction(() => api(`/routines/${routine.id}/run`, "POST")).then(() => this.flash("Started"))}>Run now</button>
            <button type="button" className="text-dim hover:text-fg" onClick={() => this.routineAction(() => api(`/routines/${routine.id}`, "DELETE"))}>Delete</button>

          </div>

        )}

      </li>

    );

  }

  render() {

    const { agent, models } = this.props;
    const { routines, note } = this.state;

    return (

      <div className="flex h-full flex-col">

        <Bar back={`#/agent/${agent.id}`} title={agent.name} actions={note && <span className="px-3 text-[13px] text-dim">{note}</span>} />

        <div className="grow overflow-y-auto">

          <div className="mx-auto flex w-full max-w-lg flex-col gap-9 px-6 py-6">

            <Section title="Who it is" description="Read before every task.">

              <textarea rows={3} value={this.state.persona} aria-label="Who it is" onChange={(event) => { const persona = event.target.value; this.setState({ persona }); this.saver.queue("persona", () => this.patch({ persona })); }} className={inputClass} />

            </Section>

            <Section
              title="Model"
              action={(

                <select value={agent.modelId} aria-label="Model" onChange={(event) => this.patch({ modelId: event.target.value }).then(() => this.flash("Saved"), (err) => this.flash(String(err)))} className="max-w-48 rounded-xl border border-line bg-panel px-3 py-2.5 text-[15px] text-fg">

                  {(models ?? [{ id: agent.modelId, name: "Current model" }]).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}

                </select>

              )}

            />

            <Section title="Routines" description={routines.length ? "Tap one for more." : `None yet. Ask ${agent.name} in chat: “every weekday at 9…”.`}>

              {routines.length > 0 && <ul className="m-0 flex list-none flex-col p-0">{routines.map((routine) => this.renderRoutine(routine))}</ul>}

            </Section>

            <Section title="Memory" description={`What ${agent.name} carries between tasks. It edits this too.`}>

              <textarea rows={8} value={this.state.memory} aria-label="Memory" onChange={(event) => { const memory = event.target.value; this.setState({ memory }); this.saver.queue("memory", () => api(`/agents/${agent.id}/memory`, "PUT", { text: memory })); }} className={`${inputClass} font-mono text-[13px]`} />

            </Section>

            <Section title="Delete agent" description="Its chat and routines go; its files stay." action={<Button onClick={this.deleteAgent}>Delete</Button>} />

          </div>

        </div>

      </div>

    );

  }

}
