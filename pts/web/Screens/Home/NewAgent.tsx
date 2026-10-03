import { Component, type FormEvent } from "react";

import { Button, Field, inputClass } from "../../Components/Controls";
import { Bar } from "../../Components/Layout";

import { api, type Agent } from "../../Lib/api";

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
