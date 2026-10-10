// Package glyph is an agent's mascot: one shape in one pastel, stored as "shape:color"; the PWA draws it.
package glyph

import (
	"math/rand/v2"
	"slices"
	"strings"
)

var (
	Shapes = []string{"flame", "spark", "orbit", "ember", "prism", "comet", "wave", "bloom"}
	Colors = []string{"peach", "butter", "mint", "sky", "lilac", "rose", "sand", "frost"}
)

func Random() string {

	return Shapes[rand.IntN(len(Shapes))] + ":" + Colors[rand.IntN(len(Colors))]

}

func Valid(glyph string) bool {

	shape, color, _ := strings.Cut(glyph, ":")

	return slices.Contains(Shapes, shape) && slices.Contains(Colors, color)

}
