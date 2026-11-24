// Colors and fonts, the same as the web apps (frontend/shared/vigora.css).

export const colors = {
  canvas: "#070708",
  surface: "#121214",
  surface2: "#1a1a1d",
  surface3: "#232327",
  ink: "#f4f4f5",
  inkSoft: "#a7a7b0",
  inkFaint: "#6f6f7a",
  line: "rgba(255,255,255,0.08)",
  lineStrong: "rgba(255,255,255,0.16)",

  orange: "#ff6b1a",
  orangeBright: "#ff8a3d",
  orangeDeep: "#e04e00",
  orangeSoft: "rgba(255,107,26,0.14)",

  teal: "#2ed3b7",
  tealBright: "#5eead4",
  tealSoft: "rgba(46,211,183,0.14)",

  red: "#f04438",
  redSoft: "rgba(240,68,56,0.15)",
  amber: "#fdb022",
  amberSoft: "rgba(253,176,34,0.14)",
  blue: "#5b9bff",
  blueSoft: "rgba(91,155,255,0.14)",
  green: "#3ccf7a",
  greenSoft: "rgba(60,207,122,0.14)",
  violet: "#8b5cf6",
};

export const fonts = {
  regular: "Onest_400Regular",
  medium: "Onest_500Medium",
  semibold: "Onest_600SemiBold",
  bold: "Onest_700Bold",
  display: "Unbounded_600SemiBold",
};

// A color with an alpha, from "#rrggbb".
export function alpha(hex, value) {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${value})`;
}

// Mix a "#rrggbb" color with white (amount 0..1), for light icon strokes.
export function lighten(hex, amount) {
  const n = parseInt(hex.replace("#", ""), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}
