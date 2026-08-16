import { Component } from "react";

import { formatElapsed } from "@/Utils/Time";

/** Owns its own interval so a 10Hz clock never re-renders the transcript. */
export class Elapsed extends Component<{ since: number }, { now: number }> {

  state = { now: Date.now() };

  private timer: ReturnType<typeof setInterval> | null = null;

  componentDidMount() {

    this.timer = setInterval(() => this.setState({ now: Date.now() }), 250);

  }

  componentWillUnmount() {

    if (this.timer) {

      clearInterval(this.timer);

    }

  }

  render() {

    return (

      <span className="font-mono text-[13px] text-ink-3 tabular-nums">

        {formatElapsed(this.state.now - this.props.since)}

      </span>

    );

  }

}
