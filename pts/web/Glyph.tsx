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

const INK = "#141414";

/** Two eyes that blink now and then; every character has them, which is what makes a shape a character. */
function Eyes({ x = 12, y, gap = 3.2, look = 0 }: { x?: number; y: number; gap?: number; look?: number }) {

  return (

    <g className="g-eyes">

      <ellipse fill={INK} cx={x - gap / 2 + look} cy={y} rx="1.05" ry="1.45" />
      <ellipse fill={INK} cx={x + gap / 2 + look} cy={y} rx="1.05" ry="1.45" />

    </g>

  );

}

function Smile({ x = 12, y, width = 2.4 }: { x?: number; y: number; width?: number }) {

  return <path fill="none" stroke={INK} strokeWidth="1.1" strokeLinecap="round" d={`M${x - width / 2} ${y}q${width / 2} ${width * 0.55} ${width} 0`} />;

}

// each part that moves carries a class; index.css blinks the eyes always and runs the rest only while the agent works
const DRAWINGS: Record<Shape, ReactNode> = {

  flame: (

    <g className="g-flame">

      <path fill="currentColor" d="M12 2.2c1 3.4 6.4 6 6.4 11.4A6.4 6.4 0 0 1 5.6 13.6c0-2.9 1.5-4.8 3.2-6 .2 1.9 1.1 3 2.4 3.6-.2-3.7.1-6.4.8-9z" />
      <Eyes y={14.4} />
      <Smile y={16.9} width={2} />

    </g>

  ),

  spark: (

    <g className="g-wiggle">

      <path fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="1.6" d="M12 3.2l2.3 5.4 5.6.7-4.2 3.8 1.2 5.6L12 15.9l-4.9 2.8 1.2-5.6-4.2-3.8 5.6-.7z" />
      <Eyes y={11.6} gap={2.9} />
      <Smile y={13.6} width={1.8} />

    </g>

  ),

  orbit: (

    <>

      <circle fill="currentColor" cx="11.5" cy="13" r="6.6" />
      <Eyes x={11.5} y={12.4} />
      <Smile x={11.5} y={14.8} width={2.2} />
      <g className="g-orbit"><circle fill="currentColor" cx="18.6" cy="6.6" r="1.9" /></g>

    </>

  ),

  ember: (

    <g className="g-bounce">

      <path fill="currentColor" d="M12 4.5c4.3 0 7.4 3.6 7.4 8.2 0 4.2-3.2 6.8-7.4 6.8s-7.4-2.6-7.4-6.8c0-4.6 3.1-8.2 7.4-8.2z" />
      <Eyes y={11.8} gap={3.6} />
      <circle fill={INK} opacity="0.18" cx="7.9" cy="14" r="1.3" />
      <circle fill={INK} opacity="0.18" cx="16.1" cy="14" r="1.3" />
      <Smile y={14.3} width={2.2} />

    </g>

  ),

  prism: (

    <g className="g-wobble">

      <path fill="currentColor" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" d="M12 4.2 19.6 18.4H4.4z" />
      <Eyes y={13.6} gap={3} />
      <Smile y={15.9} width={2} />

    </g>

  ),

  comet: (

    <g className="g-zoom">

      <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.4" d="M3.5 20.5 9 15" />
      <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.25" d="M7.5 22 11.5 18" />
      <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.25" d="M2 16.5 6 12.5" />
      <circle fill="currentColor" cx="14" cy="10" r="6" />
      <Eyes x={14} y={9.4} look={0.5} />
      <Smile x={14.4} y={11.9} width={2} />

    </g>

  ),

  wave: (

    <g className="g-float">

      <path fill="currentColor" d="M5.2 11.2a6.8 6.8 0 0 1 13.6 0v8.3l-2.3-1.6-2.2 1.6-2.3-1.6-2.3 1.6-2.2-1.6-2.3 1.6z" />
      <Eyes y={11} gap={3.4} />
      <ellipse fill={INK} cx="12" cy="14.2" rx="1" ry="1.2" />

    </g>

  ),

  bloom: (

    <>

      <g className="g-petals">

        {[0, 72, 144, 216, 288].map((angle) => <ellipse key={angle} fill="currentColor" cx="12" cy="5.4" rx="3" ry="3.6" transform={`rotate(${angle} 12 12)`} />)}

      </g>

      <circle fill="#FAF6EE" cx="12" cy="12" r="4.4" />
      <Eyes y={11.5} gap={2.8} />
      <Smile y={13.4} width={1.8} />

    </>

  ),

};

/** What the picker calls each shape; the stored ids stay the plain shape names. */
export const NAMES: Record<Shape, string> = {

  flame: "Blaze",
  spark: "Twinkle",
  orbit: "Luna",
  ember: "Pip",
  prism: "Pyra",
  comet: "Zip",
  wave: "Boo",
  bloom: "Petal",

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

    <span aria-hidden="true" className={`glyph glyph-${shape} ${live ? "is-live" : ""}`} style={{ width: size, height: size, borderRadius: Math.round(size * 0.32), background: `${hex}24`, color: hex }}>

      <svg viewBox="0 0 24 24" width={Math.round(size * 0.82)} height={Math.round(size * 0.82)}>{DRAWINGS[shape]}</svg>

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
