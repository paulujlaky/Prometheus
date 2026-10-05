import { Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { Component, createRef } from "react";

import { Composer } from "../Agent/Composer";
import { IconButton } from "../../Components/Controls";
import { colorOf, EveryoneGlyph, Glyph, GroupGlyph } from "../../Components/Glyph/Glyph";
import { withMentions } from "../../Components/Glyph/Mention";
import { Bar, Confirm } from "../../Components/Layout";
import { Memo } from "../../Components/Memo";

import type { Agent, GroupChat, GroupMessage } from "../../Lib/api";

interface GroupProps {

  group: GroupChat;
  messages: GroupMessage[];
  agents: Agent[];

  onSend: (text: string) => Promise<void>;
  onDelete: () => void;

}

/** Everyone (group 0) or a group chat with some of the agents. */
export class Group extends Component<GroupProps, { confirming: boolean }> {

  state = { confirming: false };

  private end = createRef<HTMLDivElement>();

  // messages already there when the thread opens appear at once; only new ones animate in
  private ready = false;

  componentDidMount() {

    this.end.current?.scrollIntoView();
    this.ready = true;

  }

  componentDidUpdate(previous: GroupProps) {

    if (previous.messages.length !== this.props.messages.length) {

      this.end.current?.scrollIntoView({ behavior: "smooth" });

    }

  }

  renderMessage(message: GroupMessage) {

    const { agents } = this.props;

    if (message.author === "user") {

      return <div className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-panel px-4 py-2.5 text-[15px] whitespace-pre-wrap">{withMentions(message.text, agents)}</div>;

    }

    if (message.author === "system") {

      return <div className="self-center text-center text-[13px] text-dim">{message.text}</div>;

    }

    // a deleted agent's messages keep its name but lose its mascot
    const author = agents.find((agent) => agent.id === message.agentId);

    return (

      <div className="flex flex-col gap-1.5">

        <span className="flex items-center gap-2 text-[13px] font-medium" style={author ? { color: colorOf(author) } : undefined}>

          {author ? <Glyph glyph={author.glyph} size={20} live={author.state === "running"} /> : <EveryoneGlyph size={20} />}
          {message.author}

        </span>
        <Memo text={message.text} />

      </div>

    );

  }

  render() {

    const { group, messages, agents } = this.props;
    const members = agents.filter((agent) => group.members.includes(agent.id));

    return (

      <div className="flex h-full flex-col">

        <Bar
          back="#/"
          icon={group.id ? <GroupGlyph glyphs={members.map((agent) => agent.glyph)} size={30} /> : <EveryoneGlyph size={30} />}
          title={group.name}
          actions={group.id ? <IconButton label="Delete group chat" onClick={() => this.setState({ confirming: true })}><Trash2 size={18} strokeWidth={1.6} /></IconButton> : undefined}
        />

        <div className="grow overflow-y-auto">

          <div className="mx-auto flex max-w-4xl flex-col gap-5 px-[23px] py-6 md:px-8">

            {!messages.length && <Memo text={group.id ? `Only ${members.map((agent) => agent.name).join(", ")} see what you write here. @mention one to ask just them.` : "Everyone sees what you write here. @mention an agent to ask just them, or write to all of them at once."} className="text-dim" />}

            {messages.map((message) => (

              <motion.div key={message.id} className="flex flex-col" initial={this.ready ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>

                {this.renderMessage(message)}

              </motion.div>

            ))}

            <div ref={this.end} />

          </div>

        </div>

        <Composer placeholder={group.id ? `Message ${group.name}, or @mention` : "Message everyone, or @mention"} onSend={this.props.onSend} />

        <Confirm
          open={this.state.confirming}
          title={`Delete ${group.name}?`}
          body="Its messages go. The agents stay."
          confirm="Delete"
          danger
          onCancel={() => this.setState({ confirming: false })}
          onConfirm={() => { this.setState({ confirming: false }); this.props.onDelete(); }}
        />

      </div>

    );

  }

}
