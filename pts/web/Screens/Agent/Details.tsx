import { Plus, Tag } from "lucide-react";
import { Component, type FocusEvent, type KeyboardEvent } from "react";

import { Button, inputClass, Select, Switch } from "../../Components/Controls";
import { COLORS, Glyph, NAMES, PALETTE, SHAPES } from "../../Components/Glyph/Glyph";
import { Bar, Confirm, Section } from "../../Components/Layout";

import { parseGlyph } from "../../../Features/Glyph";
import { AgentsContext } from "../../App/context";
import { api, type Agent, type Model, type Routine } from "../../Lib/api";
import { Autosave } from "../../Lib/autosave";
import { describeWatch, routineTitle } from "../../Lib/thread";

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

  timezone: string | null;

  note: string;

  /** Typing a new category's name. */
  naming: boolean;

  /** The destructive action waiting on the confirm dialog. */
  confirming: { title: string; body: string; confirm: string; run: () => void } | null;

}

function when(routine: Routine, timeZone: string | null): string {

  if (routine.kind === "watch") {

    return describeWatch(routine.target, routine.spec);

  }

  return routine.nextAt ? `Next ${new Date(routine.nextAt).toLocaleString("en-US", { timeZone: timeZone ?? undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}` : routine.enabled ? "Never runs" : "Paused";

}

// server-side names are trimmed, so a leading space can never be a real category
const NEW_CATEGORY = " new";

export class Details extends Component<DetailsProps, DetailsState> {

  static contextType = AgentsContext;
  declare context: Agent[];

  state: DetailsState = { persona: this.props.agent.persona, memory: "", routines: [], open: null, timezone: null, note: "", naming: false, confirming: null };

  private saver = new Autosave((note) => this.flash(note));
  private noteTimer: ReturnType<typeof setTimeout> | undefined;

  async componentDidMount() {

    const [memory, routines, settings] = await Promise.all([
      api<{ text: string }>(`/agents/${this.props.agent.id}/memory`),
      this.loadRoutines(),
      api<{ timezone: string | null }>("/settings"),
    ]);

    this.setState({ memory: memory.text, routines, timezone: settings.timezone });

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

      <Section title="Look" description={NAMES[shape]} action={<Glyph glyph={this.props.agent.glyph} size={52} live />}>

        {/* shapes and colours share one 8-column grid, so every swatch sits under a shape and both rows span the section edge to edge */}
        <div className="grid grid-cols-8 gap-y-2">

          <div role="radiogroup" aria-label="Shape" className="contents">

            {SHAPES.map((option) => (

              <button key={option} type="button" role="radio" aria-checked={option === shape} aria-label={NAMES[option]} title={NAMES[option]} onClick={() => this.setGlyph(`${option}:${color}`)} className={`flex aspect-square items-center justify-center rounded-xl ${option === shape ? "bg-raised" : "hover:bg-panel"}`}>

                <Glyph glyph={`${option}:${color}`} size={34} />

              </button>

            ))}

          </div>

          <div role="radiogroup" aria-label="Colour" className="contents">

            {COLORS.map((option) => (

              <button key={option} type="button" role="radio" aria-checked={option === color} aria-label={option} title={option} onClick={() => this.setGlyph(`${shape}:${option}`)} className="flex aspect-square items-center justify-center rounded-xl hover:bg-panel">

                <span className={`size-6 rounded-full ${option === color ? "ring-2 ring-fg ring-offset-2 ring-offset-ink" : ""}`} style={{ background: PALETTE[option] }} />

              </button>

            ))}

          </div>

        </div>

      </Section>

    );

  }

  patch = (changes: Partial<Pick<Agent, "persona" | "modelId" | "glyph" | "category">>) => api<Agent>(`/agents/${this.props.agent.id}`, "PATCH", changes).then(this.props.onChanged);

  setCategory = (category: string) => {

    if (category === NEW_CATEGORY) {

      this.setState({ naming: true });
      return;

    }

    this.setState({ naming: false });
    this.patch({ category }).then(() => this.flash("Saved"), (err) => this.flash(String(err)));

  };

  renderCategory() {

    const { agent } = this.props;
    const categories = [...new Set(this.context.map((one) => one.category).filter(Boolean))].sort();

    return (

      <Section
        title="Category"
        description="Groups it in the sidebar."
        action={(

          <Select
            label="Category"
            value={this.state.naming ? NEW_CATEGORY : agent.category}
            options={[{ value: "", icon: <Tag size={16} strokeWidth={1.6} />, label: "None" }, ...categories.map((category) => ({ value: category, label: category, icon: <Tag size={16} strokeWidth={1.6} /> })), { value: NEW_CATEGORY, label: "New category", icon: <Plus size={16} strokeWidth={1.6} /> }]}
            onChange={this.setCategory}
          />

        )}
      >

        {this.state.naming && <input autoFocus maxLength={32} placeholder="Category name" aria-label="Category name" enterKeyHint="done" onKeyDown={this.onNameKey} onBlur={this.onNameBlur} className={inputClass} />}

      </Section>

    );

  }

  // Enter and Escape both end in blur, so a name is saved in one place
  onNameKey = (event: KeyboardEvent<HTMLInputElement>) => {

    if (event.key === "Escape") {

      event.currentTarget.value = "";

    }

    if (event.key === "Enter" || event.key === "Escape") {

      event.currentTarget.blur();

    }

  };

  onNameBlur = (event: FocusEvent<HTMLInputElement>) => {

    const name = event.target.value.trim();

    if (!name) {

      this.setState({ naming: false });
      return;

    }

    this.setCategory(name);

  };

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
      body: routineTitle(routine),
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

            <span className={`truncate text-[15px] ${routine.enabled ? "" : "text-dim"}`}>{routineTitle(routine)}</span>
            <span className="truncate text-[13px] text-dim">{when(routine, this.state.timezone)}</span>

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

        <Bar back={`#/agent/${agent.id}`} backAlways icon={<Glyph glyph={agent.glyph} size={30} />} title={agent.name} actions={note && <span className="px-3 text-[13px] text-dim">{note}</span>} />

        <div className="grow overflow-y-auto">

          <div className="mx-auto flex w-full max-w-2xl flex-col gap-9 px-[23px] py-6 md:px-8">

            {this.renderLook()}

            <Section title="Description">

              <textarea rows={3} value={this.state.persona} aria-label="Who it is" onChange={(event) => { const persona = event.target.value; this.setState({ persona }); this.saver.queue("persona", () => this.patch({ persona })); }} className={inputClass} />

            </Section>

            {this.renderCategory()}

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

            <Section title="Memory" description="Context built by and for the agent.">

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
