import { Play, Trash2 } from "lucide-react";
import { Component } from "react";

import { Bar, Button, Field, IconButton, inputClass } from "./ui";

import { api, type Agent, type Model, type Routine } from "./api";

interface DetailsProps {

  agent: Agent;
  models: Model[] | null;

  onChanged: (agent: Agent) => void;
  onDeleted: () => void;

}

interface DetailsState {

  persona: string;
  modelId: string;
  memory: string;

  routines: Routine[];

  note: string;

}

function when(routine: Routine): string {

  return routine.kind === "schedule" ? routine.spec : `${routine.target} · every ${routine.spec} min`;

}

export class Details extends Component<DetailsProps, DetailsState> {

  state: DetailsState = { persona: this.props.agent.persona, modelId: this.props.agent.modelId, memory: "", routines: [], note: "" };

  async componentDidMount() {

    const [memory, routines] = await Promise.all([api<{ text: string }>(`/agents/${this.props.agent.id}/memory`), this.loadRoutines()]);

    this.setState({ memory: memory.text, routines });

  }

  loadRoutines = () => api<Routine[]>(`/agents/${this.props.agent.id}/routines`);

  act = async (work: () => Promise<unknown>, done: string) => {

    try {

      await work();
      this.setState({ note: done, routines: await this.loadRoutines() });

    } catch (err) {

      this.setState({ note: err instanceof Error ? err.message : String(err) });

    }

  };

  saveAgent = () => this.act(async () => {

    this.props.onChanged(await api<Agent>(`/agents/${this.props.agent.id}`, "PATCH", { persona: this.state.persona, modelId: this.state.modelId }));

  }, "Saved. It takes effect on the next task.");

  deleteAgent = () => {

    if (confirm(`Delete ${this.props.agent.name}? Its chat and routines go too; its files stay on the server.`)) {

      this.act(() => api(`/agents/${this.props.agent.id}`, "DELETE").then(this.props.onDeleted), "Deleted.");

    }

  };

  render() {

    const { agent, models } = this.props;
    const { routines, note } = this.state;

    return (

      <div className="flex h-full flex-col">

        <Bar back={`#/agent/${agent.id}`} title={agent.name} subtitle="Details" />

        <div className="mx-auto flex w-full max-w-lg flex-col gap-10 overflow-y-auto px-6 py-6">

          {note && <p className="m-0 rounded-xl bg-panel px-4 py-3 text-[14px]">{note}</p>}

          <section className="flex flex-col gap-5">

            <Field label="Who it is">

              <textarea rows={3} value={this.state.persona} onChange={(event) => this.setState({ persona: event.target.value })} className={inputClass} />

            </Field>

            <Field label="Model">

              <select value={this.state.modelId} onChange={(event) => this.setState({ modelId: event.target.value })} className={inputClass}>

                {(models ?? [{ id: agent.modelId, name: "Current model" }]).map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}

              </select>

            </Field>

            <Button className="self-start" onClick={this.saveAgent}>Save</Button>

          </section>

          <section className="flex flex-col gap-3">

            <h2 className="m-0 font-serif text-[21px] font-normal">Routines</h2>

            {!routines.length && <p className="m-0 text-[14px] text-dim">None yet. Ask {agent.name} in chat — “every weekday at 9, …”.</p>}

            {routines.map((routine) => (

              <div key={routine.id} className="flex items-center gap-2 border-t border-line pt-3">

                <span className="flex min-w-0 grow flex-col">

                  <span className="truncate text-[15px]">{routine.task.split("\n")[0]}</span>
                  <span className="truncate font-mono text-[12px] text-dim">{routine.kind === "watch" ? "watch " : ""}{when(routine)}{routine.enabled ? "" : " · paused"}</span>

                </span>

                <label className="flex items-center gap-2 text-[13px] text-dim">

                  <input type="checkbox" checked={routine.enabled} onChange={(event) => this.act(() => api(`/routines/${routine.id}`, "PATCH", { enabled: event.target.checked }), event.target.checked ? "Routine on." : "Routine paused.")} className="size-5 accent-[#F5F5F5]" />
                  On

                </label>

                <IconButton label="Run now" onClick={() => this.act(() => api(`/routines/${routine.id}/run`, "POST"), "Started.")}><Play size={16} /></IconButton>
                <IconButton label="Delete routine" onClick={() => this.act(() => api(`/routines/${routine.id}`, "DELETE"), "Routine deleted.")}><Trash2 size={16} /></IconButton>

              </div>

            ))}

          </section>

          <section className="flex flex-col gap-3">

            <h2 className="m-0 font-serif text-[21px] font-normal">Memory</h2>
            <p className="m-0 text-[14px] text-dim">What {agent.name} carries from task to task. It edits this itself; so can you.</p>
            <textarea rows={8} value={this.state.memory} onChange={(event) => this.setState({ memory: event.target.value })} aria-label="Memory" className={`${inputClass} font-mono text-[13px]`} />
            <Button className="self-start" onClick={() => this.act(() => api(`/agents/${agent.id}/memory`, "PUT", { text: this.state.memory }), "Memory saved.")}>Save memory</Button>

          </section>

          <Button className="self-start" onClick={this.deleteAgent}>Delete agent</Button>

        </div>

      </div>

    );

  }

}
