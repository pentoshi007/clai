import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { runAgent } from "../src/modes/agent.js";
import { deletePlan } from "../src/store/plan.js";
import { scratchDirFor } from "../src/prompts/index.js";

const stream = vi.fn();
const runTool = vi.fn();

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (req: unknown, onToken: (t: string) => void) =>
      stream(req, onToken),
  };
});

vi.mock("../src/tools/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/tools/registry.js")>();
  return {
    ...actual,
    runToolCall: (call: unknown, opts: unknown) => runTool(call, opts),
  };
});

vi.mock("../src/commands/providers.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

function streamReply(text: string) {
  return (_req: unknown, onToken: (t: string) => void) => {
    onToken(text);
    return Promise.resolve({ text, provider: "nvidia", model: "test-model" });
  };
}

describe("scratch-only writes bypass the plan gate", () => {
  beforeEach(async () => {
    stream.mockReset();
    runTool.mockReset();
    await deletePlan("session-123").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows fs.write to a path inside scratchDirFor(cwd) when no plan exists", async () => {
    const scratchPath = join(scratchDirFor(process.cwd()), "notes.md");
    stream
      .mockImplementationOnce(
        streamReply(
          '```tool\n{"name":"fs.write","args":{"path":"' +
            scratchPath +
            '","content":"hello"}}\n```',
        ),
      )
      .mockImplementationOnce(streamReply("wrote scratch note"));

    runTool.mockResolvedValueOnce({ ok: true, output: "ok" });

    const result = await runAgent("drop a note in scratch", {
      session: {
        sessionId: "session-123",
        planApproved: { value: false },
        allow: new Set(),
        pentestAuthorized: { value: false },
      } as any,
      maxSteps: 2,
      autoConfirm: true,
    });

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toMatchObject({
      name: "fs.write",
      args: { path: scratchPath },
    });
    expect(result).not.toBe("Blocked or Cancelled.");
  });

  it("allows fs.write to a project path through to confirmation when no plan exists", async () => {
    stream
      .mockImplementationOnce(
        streamReply(
          '```tool\n{"name":"fs.write","args":{"path":"src/index.ts","content":"export const x = 1;"}}\n```',
        ),
      )
      .mockImplementationOnce(streamReply("wrote src/index.ts"));

    runTool.mockResolvedValueOnce({ ok: true, output: "wrote src/index.ts" });

    await runAgent("edit the source", {
      session: {
        sessionId: "session-123",
        planApproved: { value: false },
        allow: new Set(),
        pentestAuthorized: { value: false },
      } as any,
      maxSteps: 2,
      autoConfirm: true,
    });

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toMatchObject({ name: "fs.write" });
  });

  it("allows fs.list (read-only) when no plan exists", async () => {
    stream
      .mockImplementationOnce(
        streamReply('```tool\n{"name":"fs.list","args":{"path":"."}}\n```'),
      )
      .mockImplementationOnce(streamReply("listed"));

    runTool.mockResolvedValueOnce({ ok: true, output: "a.ts, b.ts" });

    await runAgent("list files", {
      session: {
        sessionId: "session-123",
        planApproved: { value: false },
        allow: new Set(),
        pentestAuthorized: { value: false },
      } as any,
      maxSteps: 2,
      autoConfirm: true,
    });

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toMatchObject({ name: "fs.list" });
  });
});
