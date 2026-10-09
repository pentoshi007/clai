import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandInvocation } from "../../../src/app/commands/command.js";
import { PASTE_BURST_SETTLE_MS, PASTE_END, PASTE_START } from "../../../src/classic/input/terminal-sequences.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness;
let commands: CommandInvocation[];
let prompts: string[];

beforeEach(() => {
  vi.useFakeTimers();
  commands = [];
  prompts = [];
  harness = createHarness();
  for (const definition of harness.services.commands.all()) {
    harness.services.commands.setHandler(definition.name, (invocation) => { commands.push(invocation); });
  }
  vi.spyOn(harness.services.session, "submit").mockImplementation(async (prompt) => { prompts.push(prompt); });
  vi.spyOn(harness.services.session, "enqueue").mockImplementation((prompt) => { prompts.push(prompt); });
});

afterEach(() => {
  harness.dispose();
  vi.useRealTimers();
});

async function enter(): Promise<void> {
  await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
  harness.wiring.handleData("\r");
  await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
}

function paste(text: string): void {
  harness.wiring.handleData(`${PASTE_START}${text}${PASTE_END}`);
}

describe("Classic slash command input", () => {
  it("dispatches every registered name and alias locally with and without arguments", async () => {
    for (const definition of harness.services.commands.all()) {
      for (const name of [definition.name, ...(definition.aliases ?? [])]) {
        for (const args of ["", "sentinel-argument"]) {
          paste(`  /${name}${args ? ` ${args}` : ""}`);
          await enter();
          expect(commands.at(-1)).toMatchObject({ name: definition.name, args });
          expect(harness.wiring.composer.text).toBe("");
        }
      }
    }
    expect(prompts).toEqual([]);
  });

  it("runs an inline command after rapid Tab and Enter and preserves Unicode text", async () => {
    const prefix = "Unicode 👩🏽‍💻 é draft ";
    paste(`${prefix}/he`);
    harness.wiring.handleData("\t\r");
    await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
    expect(commands.at(-1)?.name).toBe("help");
    expect(harness.wiring.composer.text).toBe(prefix);
    expect(prompts).toEqual([]);
  });

  it("dispatches an active command after its menu is dismissed", async () => {
    paste("draft /he");
    harness.wiring.handleData("\u001b");
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.wiring.composer.menuOpen()).toBe(false);
    await enter();
    expect(commands.at(-1)?.name).toBe("help");
    expect(harness.wiring.composer.text).toBe("draft ");
    expect(prompts).toEqual([]);
  });

  it("opens the catalogue for / and filters each following keystroke", () => {
    harness.wiring.handleData("/");
    expect(harness.wiring.composer.menuItemCount()).toBe(harness.services.commands.all().length);
    for (const char of "help") harness.wiring.handleData(char);
    expect(harness.wiring.composer.getSnapshot().menu).toMatchObject({
      kind: "slash", items: [{ name: "help" }],
    });
  });

  it("keeps unknown commands local while preserving literal paths and prose", async () => {
    paste("/not-a-real-command");
    await enter();
    expect(prompts).toEqual([]);
    for (const text of ["/tmp/notes.txt", "and/or this text", "explain /help usage"]) {
      paste(text);
      await enter();
    }
    expect(prompts).toEqual(["/tmp/notes.txt", "and/or this text", "explain /help usage"]);
  });
});
