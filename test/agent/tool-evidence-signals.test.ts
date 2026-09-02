import { describe, expect, it } from "vitest";
import type { ToolCall } from "../../src/types.js";
import {
  readToolEvidenceSignals,
  type ToolEvidenceInput,
} from "../../src/agent/turn/tool-evidence-signals.js";

const signals = (
  call: ToolCall,
  overrides: Partial<ToolEvidenceInput> = {},
) =>
  readToolEvidenceSignals({
    call,
    ok: true,
    output: "",
    pentestTurn: false,
    activeProjectRoot: undefined,
    ...overrides,
  });

describe("tool evidence signals", () => {
  it("marks a landed mutation only for successful write tools", () => {
    expect(signals({ name: "fs.edit", args: {} }).mutationLanded).toBe(true);
    expect(signals({ name: "fs.append", args: {} }).mutationLanded).toBe(true);
    expect(
      signals({ name: "fs.edit", args: {} }, { ok: false }).mutationLanded,
    ).toBe(false);
    expect(signals({ name: "fs.read", args: {} }).mutationLanded).toBe(false);
  });

  it("reports a fresh probe failure regardless of tool success", () => {
    const failing = { output: "connect ECONNREFUSED 127.0.0.1:3000" };
    expect(
      signals({ name: "shell.exec", args: {} }, { ...failing, ok: false })
        .freshProbeFailure,
    ).toBe(true);
    expect(
      signals({ name: "net.scan", args: {} }, failing).freshProbeFailure,
    ).toBe(false);
  });

  it("detects a started server from shell.start and listening output", () => {
    expect(signals({ name: "shell.start", args: {} }).serverStarted).toBe(true);
    expect(signals({ name: "shell.start", args: {} }).serverTailed).toBe(false);
    const listening = signals(
      { name: "shell.exec", args: { command: "ss -ltnp" } },
      { output: "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*" },
    );
    expect(listening.serverStarted).toBe(true);
  });

  it("always marks a tail and only marks start when the tail is ready", () => {
    const notReady = signals(
      { name: "shell.tail", args: {} },
      { output: "installing dependencies" },
    );
    expect(notReady.serverTailed).toBe(true);
    expect(notReady.serverStarted).toBe(false);
    const ready = signals(
      { name: "shell.tail", args: {} },
      { output: "Local:   http://localhost:5173/" },
    );
    expect(ready.serverTailed).toBe(true);
    expect(ready.serverStarted).toBe(true);
  });

  it("requires a pentest turn and an offensive signature for active testing", () => {
    const call: ToolCall = {
      name: "shell.exec",
      args: { command: "sqlmap -u https://lab.example" },
    };
    expect(signals(call).activePentestTest).toBe(false);
    expect(signals(call, { pentestTurn: true }).activePentestTest).toBe(true);
    expect(
      signals(
        { name: "http.fetch", args: { url: "https://lab.example", method: "POST" } },
        { pentestTurn: true },
      ).activePentestTest,
    ).toBe(true);
    expect(
      signals(
        { name: "http.fetch", args: { url: "https://lab.example", method: "GET" } },
        { pentestTurn: true },
      ).activePentestTest,
    ).toBe(false);
    expect(
      signals(
        { name: "fs.read", args: { path: "sqlmap.txt" } },
        { pentestTurn: true },
      ).activePentestTest,
    ).toBe(false);
  });

  it("separates probe failure, success, and curl soft success", () => {
    expect(
      signals(
        { name: "http.fetch", args: { url: "http://localhost:3000/" } },
        { output: "ECONNREFUSED" },
      ).localProbe,
    ).toBe("failure");
    expect(
      signals(
        { name: "http.fetch", args: { url: "http://127.0.0.1:3000/" } },
        { output: "200 OK http://127.0.0.1:3000/" },
      ).localProbe,
    ).toBe("success");
    expect(
      signals(
        { name: "shell.exec", args: { command: "curl http://localhost:3000/" } },
        { output: "hello from the dev server" },
      ).localProbe,
    ).toBe("softSuccess");
    expect(
      signals({ name: "http.fetch", args: { url: "https://example.com" } })
        .localProbe,
    ).toBe("none");
  });

  it("treats scaffolds, feature writes, and installs as material local work", () => {
    const scaffold = signals({
      name: "shell.exec",
      args: { command: "npm create vite@latest my-app -- --template react" },
    });
    expect(scaffold.scaffoldCreated).toBe(true);
    expect(scaffold.localAppMaterialWork).toBe(true);

    const install = signals({
      name: "shell.exec",
      args: { command: "npm install express" },
    });
    expect(install.scaffoldCreated).toBe(false);
    expect(install.localAppMaterialWork).toBe(true);

    expect(
      signals({ name: "fs.writeMany", args: {} }).localAppMaterialWork,
    ).toBe(true);
  });

  it("counts a relative path write as local work and ignores foreign roots", () => {
    expect(
      signals(
        { name: "fs.delete", args: { path: "src/app.ts" } },
        { activeProjectRoot: "/home/u/app" },
      ).localAppMaterialWork,
    ).toBe(true);
    expect(
      signals(
        { name: "fs.delete", args: { path: "/tmp/other/app.ts" } },
        { activeProjectRoot: "/home/u/app" },
      ).localAppMaterialWork,
    ).toBe(false);
    expect(
      signals({ name: "fs.delete", args: { path: "src/app.ts" } })
        .localAppMaterialWork,
    ).toBe(false);
  });

  it("reports nothing material for a failed call", () => {
    const failed = signals(
      { name: "shell.exec", args: { command: "npm install" } },
      { ok: false },
    );
    expect(failed.localAppMaterialWork).toBe(false);
    expect(failed.evidenceWorkTool).toBe(false);
    expect(failed.serverStarted).toBe(false);
  });
});
