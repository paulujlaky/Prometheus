import { Component } from "react";

import { COLORS, Glyph, NAMES, PALETTE, SHAPES } from "./Glyph";
import { Autosave, Bar, Button, Confirm, inputClass, Section, Select, Switch } from "./ui";

import { parseGlyph } from "../Glyph";

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

  /** The destructive action waiting on the confirm dialog. */
  confirming: { title: string; body: string; confirm: string; run: () => void } | null;

}

function when(routine: Routine): string {

  return routine.kind === "schedule" ? describeSchedule(routine.spec) : describeWatch(routine.target, routine.spec);

}

export class Details extends Component<DetailsProps, DetailsState> {

  state: DetailsState = { persona: this.props.agent.persona, memory: "", routines: [], open: null, note: "", confirming: null };

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

  setGlyph = (glyph: string) => this.patch({ glyph }).catch((err) => this.flash(String(err)));

  renderLook() {

    const { shape, color } = parseGlyph(this.props.agent.glyph);

    return (

      <Section title="Look">

        <div role="radiogroup" aria-label="Shape" className="grid grid-cols-4 gap-2">

          {SHAPES.map((option) => (

            <button key={option} type="button" role="radio" aria-checked={option === shape} onClick={() => this.setGlyph(`${option}:${color}`)} className={`flex flex-col items-center gap-2 rounded-xl py-3 ${option === shape ? "bg-raised" : "hover:bg-panel"}`}>

              <Glyph glyph={`${option}:${color}`} size={48} live={option === shape} />
              <span className={`text-[12px] ${option === shape ? "text-fg" : "text-dim"}`}>{NAMES[option]}</span>

            </button>

          ))}

        </div>

        <div role="radiogroup" aria-label="Colour" className="flex flex-wrap justify-center gap-3 pt-1">

          {COLORS.map((option) => (

            <button key={option} type="button" role="radio" aria-checked={option === color} aria-label={option} title={option} onClick={() => this.setGlyph(`${shape}:${option}`)} className={`size-8 rounded-full ${option === color ? "ring-2 ring-fg ring-offset-2 ring-offset-ink" : ""}`} style={{ background: PALETTE[option] }} />

          ))}

        </div>

      </Section>

    );

  }

  patch = (changes: Partial<Pick<Agent, "persona" | "modelId" | "glyph">>) => api<Agent>(`/agents/${this.props.agent.id}`, "PATCH", changes).then(this.props.onChanged);

  deleteAgent = () => this.setState({

    confirming: {

      title: `Delete ${this.props.agent.name}?`,
      body: "Its chat and routines go. Its files stay on the server.",
      confirm: "Delete",

      run: () => api(`/agents/${this.props.agent.id}`, "DELETE").then(this.props.onDeleted).catch((err) => this.flash(String(err))),

    },

  });

  deleteRoutine = (routine: Routine) => this.setState({

    confirming: {

      title: "Delete this routine?",
      body: routine.task.split("\n")[0],
      confirm: "Delete",

      run: () => this.routineAction(() => api(`/routines/${routine.id}`, "DELETE")),

    },

  });

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
            <button type="button" className="text-danger" onClick={() => this.deleteRoutine(routine)}>Delete</button>

          </div>

        )}

      </li>

    );

  }

  render() {

    const { agent, models } = this.props;
    const { routines, note, confirming } = this.state;

    return (

      <div className="flex h-full flex-col">

        <Bar back={`#/agent/${agent.id}`} icon={<Glyph glyph={agent.glyph} size={30} />} title={agent.name} actions={note && <span className="px-3 text-[13px] text-dim">{note}</span>} />

        <div className="grow overflow-y-auto">

          <div className="mx-auto flex w-full max-w-lg flex-col gap-9 px-6 py-6">

            {this.renderLook()}

            <Section title="Who it is">

              <textarea rows={3} value={this.state.persona} aria-label="Who it is" onChange={(event) => { const persona = event.target.value; this.setState({ persona }); this.saver.queue("persona", () => this.patch({ persona })); }} className={inputClass} />

            </Section>

            <Section
              title="Model"
              action={(

                <Select
                  label="Model"
                  value={agent.modelId}
                  options={(models ?? [{ id: agent.modelId, name: "Current model" }]).map((model) => ({ value: model.id, label: model.name }))}
                  onChange={(modelId) => this.patch({ modelId }).then(() => this.flash("Saved"), (err) => this.flash(String(err)))}
                />

              )}
            />

            <Section title="Routines" description={routines.length ? undefined : "None yet. Ask in chat."}>

              {routines.length > 0 && <ul className="m-0 flex list-none flex-col p-0">{routines.map((routine) => this.renderRoutine(routine))}</ul>}

            </Section>

            <Section title="Memory" description="It edits this too.">

              <textarea rows={8} value={this.state.memory} aria-label="Memory" onChange={(event) => { const memory = event.target.value; this.setState({ memory }); this.saver.queue("memory", () => api(`/agents/${agent.id}/memory`, "PUT", { text: memory })); }} className={`${inputClass} font-mono text-[13px]`} />

            </Section>

            <Section title="Delete agent" action={<Button tone="danger" onClick={this.deleteAgent}>Delete</Button>} />

            <Confirm
              open={Boolean(confirming)}
              title={confirming?.title ?? ""}
              body={confirming?.body}
              confirm={confirming?.confirm ?? "OK"}
              danger
              onCancel={() => this.setState({ confirming: null })}
              onConfirm={() => { confirming?.run(); this.setState({ confirming: null }); }}
            />

          </div>

        </div>

      </div>

    );

  }

}
