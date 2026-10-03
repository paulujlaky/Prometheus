import { Users } from "lucide-react";
import { createContext, type ReactNode } from "react";

import { parseGlyph, type Color, type Shape } from "../Glyph";

import type { Agent } from "./api";

export { COLORS, SHAPES } from "../Glyph";

/** Every agent, for anything that turns a name into a glyph: mentions, authors, suggestions. */
export const AgentsContext = createContext<Agent[]>([]);

export const PALETTE: Record<Color, string> = {

  peach: "#F7B89C",
  butter: "#F2DC8C",
  mint: "#A8E0BE",
  sky: "#A6CBF0",
  lilac: "#C7B5F2",
  rose: "#F2A9BE",
  sand: "#DDCBA9",
  frost: "#BFE3E3",

};

// each part that moves carries a class; index.css animates it only while the agent works
const DRAWINGS: Record<Shape, ReactNode> = {

  flame: <path className="g-flame" fill="currentColor" d="M12 2.5c.8 3.6 5.5 5.9 5.5 10.9a5.5 5.5 0 0 1-11 0c0-2.6 1.3-4.3 2.8-5.4.2 1.8 1 2.8 2.2 3.3-.2-3.6 0-6.3.5-8.8z" />,

  spark: (

    <>

      <path className="g-spin" fill="currentColor" d="M11 4c.8 4.2 3.8 7.2 8 8-4.2.8-7.2 3.8-8 8-.8-4.2-3.8-7.2-8-8 4.2-.8 7.2-3.8 8-8z" />
      <circle className="g-twinkle" fill="currentColor" cx="19.5" cy="4.5" r="1.5" />

    </>

  ),

  orbit: (

    <>

      <circle fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.45" cx="12" cy="12" r="8" />
      <circle fill="currentColor" cx="12" cy="12" r="3.4" />
      <g className="g-orbit"><circle fill="currentColor" cx="20" cy="12" r="2.1" /></g>

    </>

  ),

  ember: (

    <>

      <circle className="g-ripple" fill="none" stroke="currentColor" strokeWidth="1.5" cx="12" cy="12" r="8.5" />
      <circle className="g-glow" fill="currentColor" cx="12" cy="12" r="5" />

    </>

  ),

  prism: (

    <g className="g-turn">

      <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" d="M12 3.5 20.5 18.5H3.5z" />
      <path fill="currentColor" d="M12 3.5 20.5 18.5H12z" />

    </g>

  ),

  comet: (

    <g className="g-comet">

      <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.45" d="M4 20 13 11" />
      <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.25" d="M8.5 21.5 15 15" />
      <circle fill="currentColor" cx="16" cy="8" r="4.2" />

    </g>

  ),

  wave: (

    <>

      <path className="g-wave" pathLength={100} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" d="M2.5 10c2.4-3.6 4.8-3.6 7.2 0s4.8 3.6 7.2 0 4.8-3.6 4.6-.2" />
      <path className="g-wave g-wave-late" pathLength={100} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.45" d="M2.5 16c2.4-3.6 4.8-3.6 7.2 0s4.8 3.6 7.2 0 4.8-3.6 4.6-.2" />

    </>

  ),

  bloom: (

    <g className="g-bloom">

      {[0, 72, 144, 216, 288].map((angle) => <ellipse key={angle} fill="currentColor" opacity="0.9" cx="12" cy="6.6" rx="2.7" ry="4.1" transform={`rotate(${angle} 12 12)`} />)}
      <circle fill="#0F0F0F" cx="12" cy="12" r="1.9" />

    </g>

  ),

};

interface GlyphProps {

  glyph: string;
  size?: number;

  /** Animates the mascot, which is how a working agent looks alive. */
  live?: boolean;

}

export function Glyph({ glyph, size = 28, live = false }: GlyphProps) {

  const { shape, color } = parseGlyph(glyph);
  const hex = PALETTE[color];

  return (

    <span aria-hidden="true" className={`glyph ${live ? "is-live" : ""}`} style={{ width: size, height: size, borderRadius: Math.round(size * 0.32), background: `${hex}24`, color: hex }}>

      <svg viewBox="0 0 24 24" width={Math.round(size * 0.68)} height={Math.round(size * 0.68)}>{DRAWINGS[shape]}</svg>

    </span>

  );

}

/** The "Everyone" thread's stand-in: no single agent, so no single mascot. */
export function EveryoneGlyph({ size = 28 }: { size?: number }) {

  return (

    <span aria-hidden="true" className="glyph bg-raised text-dim" style={{ width: size, height: size, borderRadius: Math.round(size * 0.32) }}>

      <Users size={Math.round(size * 0.55)} strokeWidth={1.8} />

    </span>

  );

}

export function colorOf(agent: Agent): string {

  return PALETTE[parseGlyph(agent.glyph).color];

}

/** An @mention, in the agent's colour with its mascot beside the name. */
export function Mention({ agent }: { agent: Agent }) {

  const hex = colorOf(agent);

  return (

    <span className="mention" style={{ color: hex, background: `${hex}1F` }}>

      <Glyph glyph={agent.glyph} size={16} />
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
