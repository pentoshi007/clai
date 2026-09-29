import { describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { shellExec } from "../../src/tools/shell.js";
import { toolRegistry } from "../../src/tools/registry.js";
import { TOOL_DEFINITIONS } from "../../src/tools/definitions.js";
import {
  createInteractiveSessionHandlers,
  INTERACTIVE_SESSION_TOOL_NAMES,
} from "../../src/tools/interactive-session-tools.js";
import * as transportFactory from "../../src/interactive-session/transport-factory.js";
import * as nodePty from "../../src/interactive-session/transport-node-pty.js";
import { InteractiveSessionManager } from "../../src/interactive-session/manager.js";
import { RecoveryJournal } from "../../src/interactive-session/recovery-journal.js";
import { SessionTelemetry } from "../../src/interactive-session/telemetry.js";
import { formatToolArgs } from "../../src/agent/tool-call-parser.js";
import { FakeTransportFactory, tempArtifactDir } from "./helpers.js";

// Feature: interactive-terminal-sessions, Property 24: Legacy execution never allocates an interactive transport
describe("Property 24: legacy execution never allocates an interactive transport", () => {
  it("runs shell.exec without touching the interactive or PTY factories", async () => {
    const createFactory = vi.spyOn(transportFactory, "createSessionTransportFactory");
    const probe = vi.spyOn(nodePty, "probePtyCapability");
    const startPty = vi.spyOn(nodePty, "startPtyTransport");

    const result = await shellExec({ command: "echo legacy", noArtifact: true });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("legacy");
    expect(createFactory).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(startPty).not.toHaveBeenCalled();

    createFactory.mockRestore();
    probe.mockRestore();
    startPty.mockRestore();
  });

  it("keeps the legacy shell/job tool names and adds the terminal tools additively", () => {
    for (const name of [
      "shell.exec",
      "shell.jobs",
      "shell.tail",
      "shell.stop",
    ]) {
      expect(typeof toolRegistry[name]).toBe("function");
      expect(TOOL_DEFINITIONS.some((definition) => definition.name === name)).toBe(true);
    }
    for (const name of INTERACTIVE_SESSION_TOOL_NAMES) {
      expect(typeof toolRegistry[name]).toBe("function");
      expect(TOOL_DEFINITIONS.some((definition) => definition.name === name)).toBe(true);
    }
  });

  it("requires an owning session id instead of defaulting to a shared owner", async () => {
    for (const name of INTERACTIVE_SESSION_TOOL_NAMES) {
      const result = await toolRegistry[name]!({ id: "its_x", cursor: 0, kind: "eof", command: "x", columns: 80, rows: 24 });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("requires an active clai session");
    }
  });

  it("prompts for secret terminal input without exposing it in display or output", async () => {
    const directory = tempArtifactDir();
    const factory = new FakeTransportFactory({ ptyAvailable: false });
    const manager = new InteractiveSessionManager({
      transports: factory,
      artifactBaseDir: directory,
      journal: new RecoveryJournal(join(directory, "journal")),
      telemetry: new SessionTelemetry(async () => undefined),
    });
    const handlers = createInteractiveSessionHandlers(manager);
    const secret = "prompted-terminal-secret";
    try {
      const started = await handlers["terminal.start"]!(
        { command: "cmd" },
        { sessionId: "secret-owner", confirmed: true },
      );
      const sessionId = (started.interactiveSession as { sessionId: string }).sessionId;
      const sent = await handlers["terminal.send"]!(
        { id: sessionId, kind: "secret", secretPrompt: "Password" },
        {
          sessionId: "secret-owner",
          confirmed: true,
          requestSecret: async () => secret,
        },
      );
      expect(sent.output).not.toContain(secret);
      expect(factory.last().writes).toEqual([`${secret}\n`]);
      expect(
        formatToolArgs({
          name: "terminal.send",
          args: { id: sessionId, kind: "secret", secretPrompt: "Password" },
        }),
      ).not.toContain(secret);
    } finally {
      await manager.closeAll("app-shutdown");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
