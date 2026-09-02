import { describe, expect, it } from "vitest";
import { readTaskWorkSignals } from "../../src/agent/turn/task-work-signals.js";

describe("task work signals", () => {
  it("marks source writes", () => {
    expect(
      readTaskWorkSignals({ name: "fs.edit", args: { path: "a.ts" } }, ""),
    ).toMatchObject({ sourceWrite: true });
    expect(
      readTaskWorkSignals({ name: "fs.read", args: { path: "a.ts" } }, ""),
    ).not.toMatchObject({ sourceWrite: true });
  });

  it("marks installs and scaffolds from the shell command", () => {
    expect(
      readTaskWorkSignals(
        { name: "shell.exec", args: { command: "npm install express" } },
        "",
      ),
    ).toMatchObject({ installOk: true });
    expect(
      readTaskWorkSignals(
        {
          name: "shell.start",
          args: { command: "npm create vite@latest app" },
        },
        "",
      ),
    ).toMatchObject({ scaffoldOk: true });
  });

  it("marks a ready server only from tail or start output", () => {
    const ready = "Local:   http://localhost:5173/";
    expect(
      readTaskWorkSignals({ name: "shell.tail", args: { id: "j1" } }, ready),
    ).toMatchObject({ serverReady: true });
    expect(
      readTaskWorkSignals({ name: "shell.exec", args: { command: "ls" } }, ready),
    ).not.toMatchObject({ serverReady: true });
  });

  it("marks a listening port from shell.exec output", () => {
    expect(
      readTaskWorkSignals(
        { name: "shell.exec", args: { command: "ss -ltnp" } },
        "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*",
      ),
    ).toMatchObject({ portListening: true });
  });

  it("requires both a successful probe and a loopback target", () => {
    expect(
      readTaskWorkSignals(
        { name: "http.fetch", args: { url: "http://localhost:3000/" } },
        "200 OK http://localhost:3000/",
      ),
    ).toMatchObject({ localHttpProbeOk: true });
    expect(
      readTaskWorkSignals(
        { name: "http.fetch", args: { url: "https://example.com/" } },
        "200 OK https://example.com/",
      ),
    ).not.toMatchObject({ localHttpProbeOk: true });
    expect(
      readTaskWorkSignals(
        { name: "http.fetch", args: { url: "http://localhost:3000/" } },
        "ECONNREFUSED",
      ),
    ).not.toMatchObject({ localHttpProbeOk: true });
  });

  it("keeps remote recon and active testing separate from local runtime", () => {
    const recon = readTaskWorkSignals(
      { name: "whois.lookup", args: { domain: "example.com" } },
      "",
    );
    expect(recon.remoteReconOk).toBe(true);
    expect(recon.localHttpProbeOk).toBeUndefined();
  });

  it("returns an empty record for an unremarkable call", () => {
    expect(
      readTaskWorkSignals({ name: "sysinfo", args: {} }, "linux"),
    ).toEqual({});
  });
});
