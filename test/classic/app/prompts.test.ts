import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;
let view: ReturnType<typeof render> | undefined;
const frame = (): string => view?.lastFrame()?.replace(/[│║]/g, "").replace(/\s+/g, " ") ?? "";

afterEach(() => {
  view?.unmount();
  harness?.dispose();
  harness = undefined;
  view = undefined;
});

async function mount(columns: number): Promise<Harness> {
  harness = createHarness({ columns, rows: 35, commands: true });
  view = render(createElement(ServicesProvider, {
    services: harness.services,
    children: createElement(ClassicApp, { wiring: harness.wiring }),
  }));
  await expect.poll(frame).toContain("clai");
  return harness;
}

async function open(h: Harness): Promise<void> {
  h.wiring.composer.setText("/prompts");
  h.wiring.handleData("\r");
  await expect.poll(frame).toContain("Session prompts");
  await expect.poll(() => h.services.focus.activeContext()).toBe("pager");
}

describe("Classic /prompts", () => {
  it.each([120, 80])("renders prompt sections and route metadata at %s columns and returns focus on close", async (columns) => {
    const h = await mount(columns);
    await h.services.session.promptHistory.append({
      content: "Research compaction cache behavior", timestamp: 1791110400000,
      provider: "codex", model: "model-a", effort: "xhigh",
    });
    await h.services.session.promptHistory.append({
      content: "Explain bounded history", timestamp: 1791110460000,
      provider: "openai", model: "model-b", effort: "low",
    });
    await open(h);
    await expect.poll(frame).toContain("Research compaction cache behavior");
    for (const text of ["Prompt 001", "2026", "Provider", "codex", "model-a", "xhigh"]) expect(frame()).toContain(text);
    h.wiring.handleData("\x1b[F");
    await expect.poll(frame).toContain("Explain bounded history");
    for (const text of ["Prompt 002", "openai", "model-b", "low"]) expect(frame()).toContain(text);
    h.wiring.handleData("q");
    await expect.poll(() => h.services.overlay.getState().kind).toBe("none");
    expect(h.services.focus.activeContext()).toBe("composer");
    h.wiring.composer.setText("still responsive");
    await expect.poll(frame).toContain("still responsive");
  });

  it("pages and searches beyond the first disk slice and copies the complete journal", async () => {
    const h = await mount(100);
    const journal = h.services.session.promptHistory;
    await journal.append({ content: "First request", provider: "codex", model: "first-model", effort: "high" });
    await journal.append({ content: `${"filler line\n".repeat(2200)}MIDDLE_NEEDLE\n${"more filler\n".repeat(2200)}` });
    await journal.append({ content: "Newest request", provider: "openai", model: "last-model", effort: "low" });
    const copy = vi.spyOn(h.services.ports.clipboard, "writeText").mockResolvedValue(undefined);
    await open(h);
    await expect.poll(frame).toContain("First request");
    h.wiring.handleData("\x1b[F");
    await expect.poll(frame).toContain("Newest request");
    expect(frame()).toContain("last-model");
    h.wiring.handleData("\x1b[H");
    await expect.poll(frame).toContain("First request");
    h.wiring.handleData("\x12");
    for (const char of "MIDDLE_NEEDLE") h.wiring.handleData(char);
    await new Promise((resolve) => setTimeout(resolve, 40));
    h.wiring.handleData("\r");
    await expect.poll(frame).not.toContain("find:");
    await expect.poll(frame).toContain("MIDDLE_NEEDLE");
    h.wiring.handleData("c");
    await expect.poll(() => copy.mock.calls.length).toBe(1);
    const copied = copy.mock.calls[0]![0];
    expect(copied).toContain("First request");
    expect(copied).toContain("MIDDLE_NEEDLE");
    expect(copied).toContain("Newest request");
  });

  it("opens an informative empty pager", async () => {
    const h = await mount(80);
    await open(h);
    await expect.poll(frame).toContain("No user prompts have been sent");
  });
});
