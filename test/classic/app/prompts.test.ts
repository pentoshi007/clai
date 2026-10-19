import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { createHarness, type Harness, type HarnessOptions } from "./harness.js";
import { createTurnOutcome } from "../../../src/agent/turn-outcome.js";
import { SessionPromptStore } from "../../../src/store/session-prompts.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const { withWindowsAppendHandles } = await import("../../fixtures/windows-append-handles.js");
  return withWindowsAppendHandles(await importOriginal<typeof import("node:fs/promises")>());
});

let harness: Harness | undefined;
let view: ReturnType<typeof render> | undefined;
const frame = (): string => view?.lastFrame()?.replace(/[│║]/g, "").replace(/\s+/g, " ") ?? "";

afterEach(() => {
  view?.unmount();
  harness?.dispose();
  harness = undefined;
  view = undefined;
});

async function mount(columns: number, agent?: HarnessOptions["agent"]): Promise<Harness> {
  harness = createHarness({ columns, rows: 35, commands: true, agent });
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
  it.each([120, 80])("recalls only the resumed session's prompts in a fresh composer at %s columns", async (columns) => {
    const old = new SessionPromptStore(`closed-${columns}-${Math.random()}`);
    await old.append({ content: "Earlier request\n    Keep indentation" });
    await old.append({ content: "Newest saved request" });
    const h = await mount(columns);
    expect(h.services.session.sessionId).not.toBe(old.sessionId);
    await new SessionPromptStore(`other-${columns}-${Math.random()}`).append({ content: "Unrelated newer session prompt" });
    h.services.session.loadHistory([], { sessionId: old.sessionId });
    h.wiring.composer.setText("Unsent draft");
    h.wiring.handleData("\x1b[A");
    await expect.poll(() => h.wiring.composer.text).toBe("Newest saved request");
    await new Promise((resolve) => setTimeout(resolve, 100));
    h.wiring.handleData("\x1b[A");
    await expect.poll(() => h.wiring.composer.text).toBe("Earlier request\n    Keep indentation");
    await new Promise((resolve) => setTimeout(resolve, 100));
    h.wiring.handleData("\x1b[A");
    await expect.poll(() => h.wiring.composer.text).toBe("Earlier request\n    Keep indentation");
    await new Promise((resolve) => setTimeout(resolve, 100));
    h.wiring.handleData("\x1b[B");
    expect(h.wiring.composer.text).toBe("Newest saved request");
    await new Promise((resolve) => setTimeout(resolve, 100));
    h.wiring.handleData("\x1b[B");
    expect(h.wiring.composer.text).toBe("Unsent draft");
  });

  it.each([120, 80])("preserves literal placeholders and markdown inside prompts at %s columns", async (columns) => {
    const h = await mount(columns);
    const lines = [
      "clai set <provider> <key>, then clai use <provider>",
      "**literal** _text_ `command` [label](target)",
      "<p> <path> <br> <hr> a < b > c",
    ];
    await h.services.session.promptHistory.append({ content: lines.join("\n") });
    await open(h);
    for (const line of lines) await expect.poll(frame).toContain(line);
  });

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
    const promptRow = view!.lastFrame()!.split("\n").find((line) => line.includes("Research compaction cache behavior"))!;
    expect(promptRow.match(/│/g)).toHaveLength(2);
    for (const text of ["Prompt 001", "2026", "Provider", "codex", "model-a", "xhigh"]) expect(frame()).toContain(text);
    h.wiring.handleData("\x1b[F");
    await expect.poll(frame).toContain("Explain bounded history");
    for (const text of ["Prompt 002", "openai", "model-b", "low"]) expect(frame()).toContain(text);
    h.wiring.handleData("q");
    await expect.poll(() => h.services.overlay.getState().kind).toBe("none");
    expect(h.services.focus.activeContext()).toBe("composer");
    h.wiring.composer.setText("still responsive");
    await expect.poll(frame).toContain("still responsive");
  }, 20_000);

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

  it("recovers sent user prompts when their journal append failed", async () => {
    const h = await mount(80, {
      async runTurn(request, handlers) {
        handlers.onMessages?.([
          { role: "user", content: request.prompt },
          { role: "assistant", content: "Assistant-only response" },
        ]);
        return createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] });
      },
    });
    const journal = h.services.session.promptHistory;
    vi.spyOn(journal, "append").mockRejectedValueOnce(new Error("timed out waiting for history write lock"));
    expect((await h.services.session.submit("Restore this real submitted prompt")).status).toBe("completed");
    expect(await journal.count()).toBe(0);
    await open(h);
    await expect.poll(frame).toContain("Restore this real submitted prompt");
    expect(frame()).not.toContain("Assistant-only response");
    expect(frame()).not.toContain("No user prompts have been sent");
    expect(await journal.count()).toBe(1);
  });

  it("submits, reloads, repairs and displays prompts with Windows append-handle restrictions", async () => {
    const h = await mount(100, {
      async runTurn(request, handlers) {
        handlers.onMessages?.([{ role: "user", content: request.prompt }]);
        return createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] });
      },
    });
    expect((await h.services.session.submit("Windows saved request 界\nPreserve multiline input")).status).toBe("completed");
    const journal = h.services.session.promptHistory;
    await journal.flush();
    await Promise.all([
      appendFile(journal.path, "uncommitted body suffix"),
      appendFile(join(dirname(journal.path), "metadata.jsonl"), "{incomplete"),
      appendFile(join(dirname(journal.path), "offsets.bin"), Buffer.from([1, 2, 3])),
    ]);
    h.services.session.loadHistory([], { sessionId: journal.sessionId });
    expect((await h.services.session.submit("Second Windows request after reload")).status).toBe("completed");
    await open(h);
    await expect.poll(frame).toContain("Windows saved request 界");
    expect(frame()).toContain("Preserve multiline input");
    h.wiring.handleData("\x1b[F");
    await expect.poll(frame).toContain("Second Windows request after reload");
    expect(frame()).not.toContain("uncommitted body suffix");
    expect(h.toastTexts().join(" ")).not.toMatch(/EPERM|could not (?:save|load) session prompts/);
    expect(await h.services.session.promptHistory.count()).toBe(2);
  }, 20_000);

  it("reports unavailable prompt storage without rejecting the slash command", async () => {
    const h = await mount(80, {
      async runTurn() {
        return createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] });
      },
    });
    vi.spyOn(h.services.session.promptHistory, "append").mockRejectedValue(new Error("storage unavailable"));
    expect((await h.services.session.submit("Request whose journal storage remains unavailable")).status).toBe("completed");
    await expect.poll(h.toastTexts).toContain("could not save session prompts: storage unavailable");
    h.services.session.notice("info", "An older workspace notice ".repeat(12));
    await expect.poll(frame).toContain("An older workspace notice");
    h.wiring.composer.setText("/prompts");
    h.wiring.handleData("\r");
    await expect.poll(h.toastTexts).toContain("could not load session prompts: storage unavailable");
    await expect.poll(frame).toContain("could not load session prompts: storage unavailable");
    expect(h.services.overlay.getState().kind).toBe("none");
    expect(h.services.focus.activeContext()).toBe("composer");
    h.wiring.composer.setText("still responsive");
    await expect.poll(frame).toContain("still responsive");
  });

  it("opens an informative empty pager", async () => {
    const h = await mount(80);
    await open(h);
    await expect.poll(frame).toContain("No user prompts have been sent");
  });
});
