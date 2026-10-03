import type { ReactNode } from "react";

import { colorOf, Glyph } from "./Glyph";

import type { Agent } from "../../Lib/api";

/** An @mention, in the agent's colour with its mascot beside the name. */
export function Mention({ agent }: { agent: Agent }) {

  const hex = colorOf(agent);

  return (

    <span className="mention" style={{ color: hex, background: `${hex}1F` }}>

      <Glyph glyph={agent.glyph} size={18} />
      {agent.name}

    </span>

  );

}

function escape(text: string): string {

  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

}

/** Plain text with every @Name of a known agent turned into a Mention; longest names first so "@Scout Two" wins over "@Scout". */
export function withMentions(text: string, agents: Agent[], keyPrefix = "m"): ReactNode[] {

  if (!agents.length || !text.includes("@")) {

    return [text];

  }

  const names = [...agents].sort((a, b) => b.name.length - a.name.length).map((agent) => escape(agent.name));
  const pattern = new RegExp(`@(${names.join("|")})(?![\\w-])`, "gi");
  const out: ReactNode[] = [];

  let last = 0;

  for (const match of text.matchAll(pattern)) {

    const agent = agents.find((one) => one.name.toLowerCase() === match[1].toLowerCase())!;

    out.push(text.slice(last, match.index));
    out.push(<Mention key={`${keyPrefix}${match.index}`} agent={agent} />);
    last = match.index! + match[0].length;

  }

  out.push(text.slice(last));

  return out;

}
