import { Component, type FormEvent, type ReactNode } from "react";

import { Button, Field, inputClass } from "../../Components/Controls";
import { Torch } from "../../Components/Layout";

interface GateProps {

  title: string;
  label: string;
  action: string;

  /** Hidden as it is typed, and offered to password managers. */
  secret?: boolean;

  submit: (value: string) => Promise<unknown>;

  children?: ReactNode;

}

/** One field between the user and the app: their key to sign in, then their Boodle cookie. */
export class Gate extends Component<GateProps, { value: string; error: string; busy: boolean }> {

  state = { value: "", error: "", busy: false };

  submit = async (event: FormEvent) => {

    event.preventDefault();
    this.setState({ busy: true, error: "" });

    try {

      await this.props.submit(this.state.value.trim());

    } catch (err) {

      this.setState({ error: err instanceof Error ? err.message : String(err), busy: false });

    }

  };

  render() {

    const { title, label, action, secret, children } = this.props;

    return (

      <form onSubmit={this.submit} className="mx-auto flex h-full max-w-sm flex-col justify-center gap-8 px-6">

        <div className="flex flex-col items-center gap-4">

          <Torch size={64} />
          <h1 className="m-0 font-serif text-[34px] font-normal">{title}</h1>

        </div>

        <Field>

          <input type={secret ? "password" : "text"} placeholder={label} aria-label={label} autoComplete={secret ? "current-password" : "off"} autoFocus value={this.state.value} onChange={(event) => this.setState({ value: event.target.value })} className={`${inputClass} ${secret ? "" : "font-mono"}`} />

        </Field>

        {this.state.error && <p role="alert" className="m-0 -mt-4 text-[14px] text-danger">{this.state.error}</p>}

        <Button type="submit" tone="primary" disabled={!this.state.value.trim() || this.state.busy}>{action}</Button>

        {children}

      </form>

    );

  }

}
