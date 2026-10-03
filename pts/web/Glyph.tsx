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

/** Round eyes read at 20px where ellipses blur into smudges; they still blink, which is what makes a shape a character. */
function Eyes({ x = 12, y, gap = 4, r = 1.35 }: { x?: number; y: number; gap?: number; r?: number }) {

  return (

    <g className="g-eyes">

      <circle fill={INK} cx={x - gap / 2} cy={y} r={r} />
      <circle fill={INK} cx={x + gap / 2} cy={y} r={r} />

    </g>

  );

}

function Smile({ x = 12, y, width = 2.6 }: { x?: number; y: number; width?: number }) {

  return <path fill="none" stroke={INK} strokeWidth="1.4" strokeLinecap="round" d={`M${x - width / 2} ${y}q${width / 2} ${width * 0.5} ${width} 0`} />;

}

// each part that moves carries a class; index.css blinks the eyes always and runs the rest only while the agent works
const DRAWINGS: Record<Shape, ReactNode> = {

  flame: (

    <g className="g-flame">

      <path fill="currentColor" d="M12 1.8c1.1 3.6 7 6.3 7 12A7 7 0 0 1 5 13.8c0-3.1 1.6-5.1 3.4-6.4.2 2 1.2 3.2 2.6 3.8-.2-3.9.2-6.8 1-9.4z" />
      <Eyes y={14.3} gap={4.2} />
      <Smile y={17.2} width={2.6} />

    </g>

  ),

  spark: (

    <g className="g-wiggle">

      <path fill="currentColor" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" d="M12 3.2 14.6 8.9 20.6 9.7 16.2 13.8 17.4 19.8 12 16.8 6.6 19.8 7.8 13.8 3.4 9.7 9.4 8.9z" />
      <Eyes y={11.9} gap={3.6} r={1.25} />
      <Smile y={14.1} width={2.2} />

    </g>

  ),

  orbit: (

    <>

      <circle fill="currentColor" cx="11" cy="13" r="7.4" />
      <Eyes x={11} y={12.2} gap={4.2} />
      <Smile x={11} y={15.4} width={2.8} />
      <g className="g-orbit"><circle fill="currentColor" cx="17.6" cy="6.6" r="1.8" /></g>

    </>

  ),

  ember: (

    <g className="g-bounce">

      <path fill="currentColor" d="M12 3.6c4.9 0 8.4 4 8.4 9.1 0 4.7-3.6 7.6-8.4 7.6s-8.4-2.9-8.4-7.6c0-5.1 3.5-9.1 8.4-9.1z" />
      <Eyes y={12} gap={4.6} />
      <circle fill={INK} opacity="0.2" cx="7.3" cy="14.6" r="1.5" />
      <circle fill={INK} opacity="0.2" cx="16.7" cy="14.6" r="1.5" />
      <Smile y={14.9} width={2.6} />

    </g>

  ),

  prism: (

    <g className="g-wobble">

      <path fill="currentColor" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" d="M12 3.8 20.6 19.2H3.4z" />
      <Eyes y={14} gap={3.8} r={1.3} />
      <Smile y={16.7} width={2.4} />

    </g>

  ),

  comet: (

    <g className="g-zoom">

      <path stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.4" d="M3.5 20.5 8.6 15.4" />
      <path stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.25" d="M8 22 11.2 18.8" />
      <path stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.25" d="M2 16 5.2 12.8" />
      <circle fill="currentColor" cx="14.2" cy="9.8" r="6.8" />
      <Eyes x={14.4} y={9} gap={4} />
      <Smile x={14.4} y={12.3} width={2.6} />

    </g>

  ),

  wave: (

    <g className="g-float">

      <path fill="currentColor" d="M4.6 11a7.4 7.4 0 0 1 14.8 0v9.4l-2.5-1.8-2.4 1.8-2.5-1.8-2.5 1.8-2.4-1.8-2.5 1.8z" />
      <Eyes y={10.8} gap={4.2} r={1.45} />
      <ellipse fill={INK} cx="12" cy="14.6" rx="1.2" ry="1.45" />

    </g>

  ),

  bloom: (

    <>

      <g className="g-petals">

        {[0, 72, 144, 216, 288].map((angle) => <ellipse key={angle} fill="currentColor" opacity="0.5" cx="12" cy="4.4" rx="3.4" ry="3.8" transform={`rotate(${angle} 12 12)`} />)}

      </g>

      <circle fill="currentColor" cx="12" cy="12" r="5.6" />
      <Eyes y={11.3} gap={3.5} r={1.2} />
      <Smile y={13.9} width={2.2} />

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

export function Glyph({ glyph, size = 32, live = false }: GlyphProps) {

  const { shape, color } = parseGlyph(glyph);
  const hex = PALETTE[color];

  return (

    <span aria-hidden="true" className={`glyph glyph-${shape} ${live ? "is-live" : ""}`} style={{ width: size, height: size, color: hex }}>

      <svg viewBox="0 0 24 24" width={size} height={size} overflow="visible">{DRAWINGS[shape]}</svg>

    </span>

  );

}

/** The "Everyone" thread's stand-in: no single agent, so no single mascot. */
export function EveryoneGlyph({ size = 32 }: { size?: number }) {

  return (

    <span aria-hidden="true" className="glyph text-dim" style={{ width: size, height: size }}>

      <Users size={Math.round(size * 0.78)} strokeWidth={1.7} />

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
