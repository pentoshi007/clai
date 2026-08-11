import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chordFromKey } from "../../../src/classic/input/chord-from-key.js";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";
import { sanitizePasteText } from "../../../src/classic/input/paste-decoder.js";

interface WindowsFixture {
  readonly id: string;
  readonly host: string;
  readonly recorded: boolean;
  readonly skip?: string;
  readonly expected: { readonly unicode: boolean };
  readonly keys: readonly { readonly chord: string; readonly bytes: string | null }[];
  readonly paste: { readonly lines: number; readonly bytes: string | null } | null;
}

const REQUIRED_CHORDS = [
  "shift+enter",
  "alt+enter",
  "shift+tab",
  "ctrl+h",
  "ctrl+j",
  "ctrl+o",
  "ctrl+t",
  "ctrl+g",
  "ctrl+p",
  "ctrl+r",
  "escape",
  "ctrl+c",
];

const dir = fileURLToPath(new URL("./fixtures/windows", import.meta.url));
const fixtures: WindowsFixture[] = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as WindowsFixture);

describe("Windows key fixtures", () => {
  it("covers every host named in 05-INPUT.md §10", () => {
    expect(fixtures.map((f) => f.id).sort()).toEqual([
      "conhost",
      "powershell-51",
      "powershell-7",
      "vscode-terminal",
      "windows-terminal",
    ]);
  });

  it("validates recording metadata before enabling a host suite", () => {
    for (const fixture of fixtures) {
      expect(typeof fixture.expected?.unicode).toBe("boolean");
      if (fixture.recorded) {
        expect(fixture.skip, `${fixture.id} is recorded but still skipped`).toBeUndefined();
        for (const entry of fixture.keys) {
          expect(entry.bytes, `${fixture.id}:${entry.chord} is a placeholder`).not.toBeNull();
        }
        expect(fixture.paste?.bytes, `${fixture.id}:paste is a placeholder`).not.toBeNull();
      } else {
        expect(fixture.skip, `${fixture.id} needs an evidence reason`).toBeTruthy();
      }
    }
  });

  it("keeps legacy conhost on the ASCII capability path", () => {
    expect(fixtures.find((fixture) => fixture.id === "conhost")?.expected.unicode).toBe(false);
  });

  for (const fixture of fixtures) {
    describe(fixture.host, () => {
      const run = fixture.recorded ? it : it.skip;

      run("decodes every recorded chord", () => {
        for (const entry of fixture.keys) {
          const decoder = new RawDecoder();
          const events = [...decoder.push(entry.bytes ?? ""), ...decoder.flush()];
          const keys = events.flatMap((event) =>
            event.type === "key" ? [event.key] : [],
          );
          expect(keys, `${fixture.id}:${entry.chord}`).toHaveLength(1);
          expect(chordFromKey(keys[0]!)).toBe(entry.chord);
        }
      });

      run("decodes the recorded 500-line paste as one event", () => {
        const decoder = new RawDecoder();
        const events = [
          ...decoder.push(fixture.paste?.bytes ?? ""),
          ...decoder.flush(),
        ];
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe("paste");
        const text = events[0]?.type === "paste" ? events[0].text : "";
        expect(text.split("\n")).toHaveLength(fixture.paste?.lines ?? 0);
        expect(sanitizePasteText(text)).toBe(text);
      });
    });
  }
});
