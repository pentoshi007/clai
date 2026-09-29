export type AnsiColorName =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "blackBright"
  | "redBright"
  | "greenBright"
  | "yellowBright"
  | "blueBright"
  | "magentaBright"
  | "cyanBright"
  | "whiteBright";

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

const HUES: readonly (readonly [number, "red" | "yellow" | "green" | "cyan" | "blue" | "magenta"])[] = [
  [20, "red"],
  [70, "yellow"],
  [160, "green"],
  [200, "cyan"],
  [250, "blue"],
  [335, "magenta"],
  [360, "red"],
];

function parseHex(hex: string): Rgb | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function hsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function redmean(a: Rgb, b: Rgb): number {
  const mean = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return (2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db;
}

function paletteRgb(index: number): Rgb {
  if (index >= 232) {
    const value = 8 + (index - 232) * 10;
    return { r: value, g: value, b: value };
  }
  const offset = index - 16;
  return {
    r: CUBE_LEVELS[Math.floor(offset / 36)]!,
    g: CUBE_LEVELS[Math.floor(offset / 6) % 6]!,
    b: CUBE_LEVELS[offset % 6]!,
  };
}

const cache256 = new Map<string, number>();
const cache16 = new Map<string, AnsiColorName>();

function hueFamily(rgb: Rgb): { hue: number; chroma: number } {
  const { h, s, l } = hsl(rgb);
  return { hue: h, chroma: s * (1 - Math.abs(2 * l - 1)) };
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function nearestAnsi256(hex: string, preserveHue = false): number {
  const key = `${preserveHue ? "h" : "n"}${hex}`;
  const cached = cache256.get(key);
  if (cached !== undefined) return cached;
  const rgb = parseHex(hex);
  if (!rgb) return 7;
  const source = hueFamily(rgb);
  const keepHue = preserveHue && source.chroma > 0.02;
  let best = 16;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 16; index < 256; index += 1) {
    const candidate = paletteRgb(index);
    if (keepHue) {
      const family = hueFamily(candidate);
      if (family.chroma === 0 || hueDistance(family.hue, source.hue) > 35) continue;
    }
    const score = redmean(rgb, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }
  cache256.set(key, best);
  return best;
}

export function nearestAnsi16(hex: string, background = false): AnsiColorName {
  const key = `${background ? "b" : "f"}${hex}`;
  const cached = cache16.get(key);
  if (cached !== undefined) return cached;
  const rgb = parseHex(hex);
  const resolved = rgb ? quantize16(rgb, background) : "white";
  cache16.set(key, resolved);
  return resolved;
}

function quantize16(rgb: Rgb, background: boolean): AnsiColorName {
  const { h, s, l } = hsl(rgb);
  if (s < 0.22 || l < 0.08 || l > 0.94) {
    if (l < 0.18) return "black";
    if (l < 0.7) return "blackBright";
    if (l < 0.9) return "white";
    return "whiteBright";
  }
  const base = HUES.find(([limit]) => h < limit)?.[1] ?? "red";
  if (background) return base;
  return l >= 0.5 ? (`${base}Bright` as AnsiColorName) : base;
}
