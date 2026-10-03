import { Users } from "lucide-react";

import { DRAWINGS } from "./Characters";

import { parseGlyph, type Color } from "../../../Features/Glyph";
import type { Agent } from "../../Lib/api";

export { COLORS, SHAPES } from "../../../Features/Glyph";
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

export function colorOf(agent: Agent): string {

  return PALETTE[parseGlyph(agent.glyph).color];

}
