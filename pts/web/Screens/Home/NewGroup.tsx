import { Check } from "lucide-react";
import { Component, type FormEvent } from "react";

import { Button, Field, inputClass } from "../../Components/Controls";
import { Glyph, GroupGlyph } from "../../Components/Glyph/Glyph";
import { Bar } from "../../Components/Layout";

import { api, type Agent, type GroupChat } from "../../Lib/api";

interface NewGroupProps {

  agents: Agent[];

  onCreated: (group: GroupChat) => void;

}

interface NewGroupState {

  name: string;
  members: number[];

  error: string;
  busy: boolean;

}

/** Who is in it is the whole decision; the name falls back to theirs. */
export class NewGroup extends Component<NewGroupProps, NewGroupState> {

  state: NewGroupState = { name: "", members: [], error: "", busy: false };

  toggle = (id: number) => this.setState(({ members }) => ({ members: members.includes(id) ? members.filter((one) => one !== id) : [...members, id] }));

  submit = async (event: FormEvent) => {

    event.preventDefault();
    this.setState({ busy: true, error: "" });

    try {

      this.props.onCreated(await api<GroupChat>("/groups", "POST", { name: this.state.name.trim(), members: this.state.members }));

    } catch (err) {

      this.setState({ error: err instanceof Error ? err.message : String(err), busy: false });

    }

  };

  render() {

    const { agents } = this.props;
    const { name, members, error, busy } = this.state;
    const chosen = agents.filter((agent) => members.includes(agent.id));

    return (

      <div className="flex h-full flex-col">

        <Bar back="#/" icon={chosen.length > 1 ? <GroupGlyph glyphs={chosen.map((agent) => agent.glyph)} size={30} /> : undefined} title="New group chat" />

        <form onSubmit={this.submit} className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-[23px] py-6 md:px-8">

          <Field label="Name">

            <input value={name} onChange={(event) => this.setState({ name: event.target.value })} placeholder={chosen.map((agent) => agent.name).join(", ") || "Research"} className={inputClass} />

          </Field>

          <div role="group" aria-label="Who's in it" className="flex flex-col gap-2">

            <span className="text-[14px] text-dim">Who’s in it</span>

            {agents.map((agent) => {

              const on = members.includes(agent.id);

              return (

                <button key={agent.id} type="button" aria-pressed={on} onClick={() => this.toggle(agent.id)} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-left ${on ? "bg-panel" : ""}`}>

                  <Glyph glyph={agent.glyph} />
                  <span className="grow font-medium">{agent.name}</span>
                  {on && <Check size={16} className="shrink-0" />}

                </button>

              );

            })}

          </div>

          {error && <p className="m-0 text-[14px] text-dim">{error}</p>}

          <Button type="submit" tone="primary" disabled={members.length < 2 || busy}>Create</Button>

        </form>

      </div>

    );

  }

}
