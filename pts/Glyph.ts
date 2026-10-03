// An agent's mascot: one shape in one pastel, stored as "shape:color". The PWA draws them; the server only validates.

export const SHAPES = ["flame", "spark", "orbit", "ember", "prism", "comet", "wave", "bloom"] as const;
export const COLORS = ["peach", "butter", "mint", "sky", "lilac", "rose", "sand", "frost"] as const;

export type Shape = (typeof SHAPES)[number];
export type Color = (typeof COLORS)[number];

export function randomGlyph(): string {

  const pick = <T>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)];

  return `${pick(SHAPES)}:${pick(COLORS)}`;

}

export function parseGlyph(glyph: string): { shape: Shape; color: Color } {

  const [shape, color] = glyph.split(":");

  return {

    shape: (SHAPES as readonly string[]).includes(shape) ? (shape as Shape) : "spark",
    color: (COLORS as readonly string[]).includes(color) ? (color as Color) : "frost",

  };

}

export function isGlyph(glyph: string): boolean {

  const [shape, color] = glyph.split(":");

  return (SHAPES as readonly string[]).includes(shape) && (COLORS as readonly string[]).includes(color);

}
