import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../../store/paths.js";

export type CachedThemeMode = "dark" | "light";

interface ThemeModeStore {
  version: 1;
  modes: Record<string, CachedThemeMode>;
}

function storePath(): string {
  return join(getDataDir(), "terminal-theme-mode.json");
}

/**
 * A terminal's light/dark mode is stable, but the OSC query that reports it can
 * time out. Without a remembered answer a timeout silently falls back to a
 * default and the whole UI changes hue between launches.
 */
function terminalKey(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const program = env.TERM_PROGRAM?.trim() || "";
  const term = env.TERM?.trim() || "";
  return `${program}|${term}` || "unknown";
}

function readStore(): ThemeModeStore | undefined {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), "utf8")) as
      | Partial<ThemeModeStore>
      | undefined;
    if (parsed?.version !== 1 || !parsed.modes || typeof parsed.modes !== "object") {
      return undefined;
    }
    return { version: 1, modes: parsed.modes };
  } catch {
    return undefined;
  }
}

export function readCachedThemeMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CachedThemeMode | undefined {
  const mode = readStore()?.modes[terminalKey(env)];
  return mode === "dark" || mode === "light" ? mode : undefined;
}

export function rememberThemeMode(
  mode: CachedThemeMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const key = terminalKey(env);
  const store = readStore() ?? { version: 1 as const, modes: {} };
  if (store.modes[key] === mode) return;
  store.modes[key] = mode;
  try {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
  } catch {}
}
