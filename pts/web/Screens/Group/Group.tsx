import { Component, createRef } from "react";

import { Composer } from "../Agent/Composer";
import { colorOf, EveryoneGlyph, Glyph } from "../../Components/Glyph/Glyph";
import { withMentions } from "../../Components/Glyph/Mention";
import { Bar } from "../../Components/Layout";
import { Memo } from "../../Components/Memo";

import type { Agent, GroupMessage } from "../../Lib/api";

interface GroupProps {

  messages: GroupMessage[];
  agents: Agent[];

  onSend: (text: string) => Promise<void>;

}

export class Group extends Component<GroupProps> {

  private end = createRef<HTMLDivElement>();

  componentDidMount() {

    this.end.current?.scrollIntoView();

  }

  componentDidUpdate(previous: GroupProps) {

    if (previous.messages.length !== this.props.messages.length) {

      this.end.current?.scrollIntoView({ behavior: "smooth" });

    }

  }

  render() {

    const { messages, agents } = this.props;

    return (

      <div className="flex h-full flex-col">

        <Bar back="#/" icon={<EveryoneGlyph size={30} />} title="Everyone" />

        <div className="grow overflow-y-auto">

          <div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-6">

            {!messages.length && <Memo text="Everyone sees what you write here. @mention an agent to ask just them, or write to all of them at once." className="text-dim" />}

            {messages.map((message) => {

              if (message.author === "user") {

                return <div key={message.id} className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-panel px-4 py-2.5 text-[15px] whitespace-pre-wrap">{withMentions(message.text, agents)}</div>;

              }

              if (message.author === "system") {

                return <div key={message.id} className="self-center text-center text-[13px] text-dim">{message.text}</div>;

              }

              // a deleted agent's messages keep its name but lose its mascot
              const author = agents.find((agent) => agent.id === message.agentId);

              return (

                <div key={message.id} className="flex flex-col gap-1.5">

                  <span className="flex items-center gap-2 text-[13px] font-medium" style={author ? { color: colorOf(author) } : undefined}>

                    {author ? <Glyph glyph={author.glyph} size={20} live={author.state === "running"} /> : <EveryoneGlyph size={20} />}
                    {message.author}

                  </span>
                  <Memo text={message.text} />

                </div>

              );

            })}

            <div ref={this.end} />

          </div>

        </div>

        <Composer placeholder="Message everyone, or @mention" onSend={this.props.onSend} />

      </div>

    );

  }

}
