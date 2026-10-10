// An agent's mascot: one shape in one pastel, stored as "shape:color". The server checks the same sets in server/glyph.

export const SHAPES = ["flame", "spark", "orbit", "ember", "prism", "comet", "wave", "bloom"] as const;
export const COLORS = ["peach", "butter", "mint", "sky", "lilac", "rose", "sand", "frost"] as const;

export type Shape = (typeof SHAPES)[number];
export type Color = (typeof COLORS)[number];

export function parseGlyph(glyph: string): { shape: Shape; color: Color } {

  const [shape, color] = glyph.split(":");

  return {

    shape: (SHAPES as readonly string[]).includes(shape) ? (shape as Shape) : "spark",
    color: (COLORS as readonly string[]).includes(color) ? (color as Color) : "frost",

  };

}
