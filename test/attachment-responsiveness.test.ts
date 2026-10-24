import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearImagePreparationCache, prepareImageForModel } from "../src/attachments/image-prepare.js";
import { imageBudgetFor } from "../src/attachments/image-content.js";
import { formatAttachmentReference, stabilizeDroppedFilesInText } from "../src/ui/mentions.js";
import { imageView } from "../src/tools/image.js";
import { captureClipboardImage } from "../src/attachments/clipboard-image.js";
import { SessionController } from "../src/app/controllers/session-controller.js";
import type { RunTurnRequest } from "../src/app/ports/agent-port.js";
import type { AnyAppEvent } from "../src/app/events/app-event.js";
import { createTurnOutcome } from "../src/agent/turn-outcome.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const directories: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "clai-responsive-image-"));
  directories.push(dir);
  return dir;
}

function slowConverter(dir: string): void {
  const executable = join(dir, "magick");
  writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => { require('fs').writeFileSync(process.argv.at(-1), Buffer.from('${png.toString("base64")}', 'base64')); }, 150);\n`);
  chmodSync(executable, 0o755);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  clearImagePreparationCache();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("attachment responsiveness", () => {
  it("keeps existing image and document references without copying files", () => {
    const dir = workspace();
    const image = join(dir, "screenshot.png");
    const document = join(dir, "report.pdf");
    writeFileSync(image, png);
    writeFileSync(document, "%PDF-1.7\n");
    const result = stabilizeDroppedFilesInText(`${image} ${document}`, dir);
    expect(result.files).toEqual([image, document]);
    expect(result.images).toEqual([image]);
    expect(result.text).toBe(`${formatAttachmentReference(image)} ${formatAttachmentReference(document)}`);
  });

  it("lets input and rendering timers run while an image converter works", async () => {
    const dir = workspace();
    slowConverter(dir);
    const source = join(dir, "large.png");
    const large = Buffer.from(png);
    large.writeUInt32BE(10_000, 16);
    large.writeUInt32BE(10_000, 20);
    writeFileSync(source, large);
    let responsive = false;
    const timer = setTimeout(() => { responsive = true; }, 20);
    try {
      const result = await prepareImageForModel(source, imageBudgetFor("openai", "gpt-4o"), dir);
      expect(result.ok).toBe(true);
      expect(responsive).toBe(true);
      if (result.ok) expect(result.transcoded).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });
});

function oversizedImage(dir: string): string {
  const source = join(dir, "oversized.png");
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(10_000, 16);
  bytes.writeUInt32BE(10_000, 20);
  writeFileSync(source, bytes);
  return source;
}

describe("attachment lifecycle", () => {
  it("keeps image.view responsive and returns the converted pixels", async () => {
    const dir = workspace();
    slowConverter(dir);
    let heartbeat = false;
    const timer = setTimeout(() => { heartbeat = true; }, 20);
    try {
      const result = await imageView({ path: oversizedImage(dir) }, { llmProvider: "openai", llmModel: "gpt-4o" });
      expect(heartbeat).toBe(true);
      expect(result.ok).toBe(true);
      expect(Buffer.from(result.images![0]!.dataBase64, "base64")).toEqual(png);
    } finally {
      clearTimeout(timer);
    }
  });

  it("cancels image conversion without caching a cancelled result", async () => {
    const dir = workspace();
    slowConverter(dir);
    const source = oversizedImage(dir);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      await expect(prepareImageForModel(source, imageBudgetFor("openai", "gpt-4o"), dir, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      const retry = await prepareImageForModel(source, imageBudgetFor("openai", "gpt-4o"), dir);
      expect(retry.ok).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("captures raw clipboard images without blocking timers", async () => {
    const dir = workspace();
    const executable = join(dir, "wl-paste");
    writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => process.stdout.write(Buffer.from('${png.toString("base64")}', 'base64')), 150);\n`);
    chmodSync(executable, 0o755);
    vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
    let heartbeat = false;
    const timer = setTimeout(() => { heartbeat = true; }, 20);
    try {
      const result = await captureClipboardImage(dir);
      expect(result.ok).toBe(true);
      expect(heartbeat).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it.each(["send", "send-now"])("publishes %s before preparing attachments and sends exact pixels once", async (action) => {
    const dir = workspace();
    slowConverter(dir);
    const prompt = `inspect ${formatAttachmentReference(oversizedImage(dir))}`;
    const events: AnyAppEvent[] = [];
    const requests: RunTurnRequest[] = [];
    const session = new SessionController({
      provider: "openai", model: "gpt-4o", noHistory: true,
      persistence: { saveSession: async () => {}, loadPlan: async () => undefined, savePlan: async () => {}, deletePlan: async () => {} },
      agent: {
        async runTurn(request, handlers) {
          requests.push(request);
          handlers.onEvent({ type: "turn-start", prompt: request.prompt });
          return createTurnOutcome({ status: "succeeded", answer: "seen", steps: 1, remainingCriteria: [] });
        },
      },
      emit: (event) => events.push(event),
    });
    try {
      let pending: Promise<unknown> | undefined;
      if (action === "send") pending = session.submit(prompt);
      else {
        session.enqueue(prompt);
        session.sendQueuedNow(0);
      }
      const started = events.filter((event) => event.type === "turn-started");
      expect(started).toHaveLength(1);
      expect(started[0]?.payload.displayPrompt).toBe("inspect [Image 1]");
      expect(session.getState().running).toBe(true);
      expect(requests).toHaveLength(0);
      if (pending) await pending;
      await vi.waitFor(() => expect(session.getState().running).toBe(false));
      expect(requests).toHaveLength(1);
      expect(Buffer.from(requests[0]!.images![0]!.dataBase64, "base64")).toEqual(png);
      expect(requests[0]!.prompt).toBe(prompt);
      expect(events.filter((event) => event.type === "turn-started")).toHaveLength(1);
      expect(session.queued()).toEqual([]);
    } finally {
      session.dispose();
    }
  });
});

it("preserves a queued image reference cancelled during preparation and sends it on retry", async () => {
  const dir = workspace();
  slowConverter(dir);
  const prompt = `inspect ${formatAttachmentReference(oversizedImage(dir))}`;
  const runTurn = vi.fn(async (_request: RunTurnRequest) =>
    createTurnOutcome({ status: "succeeded", answer: "seen", steps: 1, remainingCriteria: [] }));
  const events: AnyAppEvent[] = [];
  const session = new SessionController({
    provider: "openai", model: "gpt-4o", noHistory: true,
    persistence: { saveSession: async () => {}, loadPlan: async () => undefined, savePlan: async () => {}, deletePlan: async () => {} },
    agent: { runTurn },
    emit: (event) => events.push(event),
  });
  try {
    session.enqueue(prompt);
    session.sendQueuedNow(0);
    expect(session.getState().running).toBe(true);
    session.abort();
    await vi.waitFor(() => {
      expect(session.getState().running).toBe(false);
      expect(session.queued()).toEqual([prompt]);
    });
    expect(runTurn).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "turn-aborted")).toHaveLength(1);
    session.sendQueuedNow(0);
    await vi.waitFor(() => {
      expect(runTurn).toHaveBeenCalledOnce();
      expect(session.getState().running).toBe(false);
    });
    const sent = runTurn.mock.calls[0]![0];
    expect(sent.prompt).toBe(prompt);
    expect(Buffer.from(sent.images![0]!.dataBase64, "base64")).toEqual(png);
    expect(session.queued()).toEqual([]);
  } finally {
    session.dispose();
  }
});
