import { Users } from "lucide-react";

import { DRAWINGS } from "./Characters";

import { parseGlyph, type Color } from "../../Lib/glyph";
import type { Agent } from "../../Lib/api";

export { COLORS, SHAPES } from "../../Lib/glyph";
export { NAMES } from "./Characters";

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

// where each mascot sits in the tile, as fractions of the free space: two on a diagonal, three in a triangle, four in a grid
const SPOTS: Record<number, [number, number][]> = {

  2: [[0, 0], [1, 1]],
  3: [[0.5, 0], [0, 1], [1, 1]],
  4: [[0, 0], [1, 0], [0, 1], [1, 1]],

};

/** A group's members' mascots huddled into one tile, the way iMessage draws a group. */
export function GroupGlyph({ glyphs, size = 32 }: { glyphs: string[]; size?: number }) {

  const shown = glyphs.slice(0, 4);

  if (shown.length < 2) {

    return shown.length ? <Glyph glyph={shown[0]} size={size} /> : <EveryoneGlyph size={size} />;

  }

  const small = Math.round(size * (shown.length === 2 ? 0.64 : 0.52));

  return (

    <span aria-hidden="true" className="relative shrink-0" style={{ width: size, height: size }}>

      {shown.map((glyph, i) => (

        <span key={i} className="absolute flex" style={{ left: SPOTS[shown.length][i][0] * (size - small), top: SPOTS[shown.length][i][1] * (size - small) }}>

          <Glyph glyph={glyph} size={small} />

        </span>

      ))}

    </span>

  );

}

export function colorOf(agent: Agent): string {

  return PALETTE[parseGlyph(agent.glyph).color];

}
