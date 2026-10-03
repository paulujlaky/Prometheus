import { Component, type FormEvent } from "react";

import { Button, Field, inputClass } from "../../Components/Controls";
import { Torch } from "../../Components/Layout";

import { api } from "../../Lib/api";

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

        <Field>

          <input type="password" placeholder="Access token" autoComplete="current-password" autoFocus value={this.state.token} onChange={(event) => this.setState({ token: event.target.value })} className={inputClass} />

        </Field>

        <Button type="submit" tone="primary" disabled={!this.state.token.trim() || this.state.busy}>Sign in</Button>

      </form>

    );

  }

}
