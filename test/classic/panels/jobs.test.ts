import { describe, expect, it } from "vitest";
import { jobsKey, jobsView, JOBS_INITIAL_STATE } from "../../../src/classic/panels/jobs-panel.js";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import { asciiInk, createHarness, ink, job, rowsOf } from "./harness.js";

const NOW = 300_000;

const JOBS = [
  job({
    id: "j1",
    commandDisplay: "nmap -sV 10.0.0.1",
    status: "exited",
    exitCode: 0,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(252_000).toISOString(),
  }),
  job({ id: "j2", commandDisplay: "ffuf -u https://target/FUZZ", status: "running" }),
  job({ id: "j3", commandDisplay: "nuclei -t cves/", status: "starting" }),
];

function render(state = JOBS_INITIAL_STATE, jobs = JOBS, theme = ink) {
  const frame = jobsView({ ink: theme, columns: 80, rows: 7, jobs, state, now: NOW });
  return { frame, rows: rowsOf(panelFrameRows(frame).rows) };
}

describe("jobs rows", () => {
  it("titles the panel, counts the list, and lists the close hints", () => {
    const { frame } = render();
    expect(frame.title).toBe("Background jobs");
    expect(frame.borderColor).toBe("border");
    expect(frame.counter).toBe("1/3");
    expect(frame.hints).toEqual(["▲▼", "⏎ live", "t tail", "k stop", "q close"]);
  });

  it("shows status and elapsed from the shared formatter", () => {
    const { rows } = render();
    expect(rows[1]).toContain("✓ nmap -sV 10.0.0.1");
    expect(rows[1]).toContain("done · 4m12s");
    expect(rows[2]).toContain("● ffuf");
    expect(rows[2]).toContain("running · 5m0s");
    expect(rows[3]).toContain("○ nuclei");
    expect(rows[3]).toContain("queued");
  });

  it("falls back to ASCII glyphs when the terminal lacks Unicode", () => {
    const { rows } = render(JOBS_INITIAL_STATE, JOBS, asciiInk);
    expect(rows[1]).toContain("v nmap");
    expect(rows[2]).toContain("* ffuf");
  });

  it("renders an empty state", () => {
    const { rows, frame } = render(JOBS_INITIAL_STATE, []);
    expect(frame.counter).toBeUndefined();
    expect(rows[1]).toContain("no background jobs");
  });

  it("marks the selected row", () => {
    const { rows } = render({ cursor: 1, top: 0 });
    expect(rows[2]).toContain("❯");
    expect(rows[1]).not.toContain("❯");
  });
});

describe("jobs keys", () => {
  it("wraps the cursor", () => {
    expect(jobsKey({ state: JOBS_INITIAL_STATE, chord: "up", jobs: JOBS, rows: 7 }).state.cursor).toBe(2);
    expect(jobsKey({ state: JOBS_INITIAL_STATE, chord: "down", jobs: JOBS, rows: 7 }).state.cursor).toBe(1);
  });

  it("opens the tail over the job list and restores it on close", () => {
    const harness = createHarness();
    harness.jobs = [...JOBS];
    harness.overlay.openJobs();
    harness.press("down");
    expect(harness.press("t")).toBe(true);
    expect(harness.overlay.getState().kind).toBe("pager");
    harness.overlay.close();
    expect(harness.overlay.getState().kind).toBe("jobs");
  });

  it("stops the selected job through the port", () => {
    const harness = createHarness();
    harness.jobs = [...JOBS];
    harness.overlay.openJobs();
    harness.press("down");
    expect(harness.press("k")).toBe(true);
    expect(harness.stopped).toEqual(["j2"]);
  });

  it("closes on q and leaves unknown chords alone", () => {
    const harness = createHarness();
    harness.jobs = [...JOBS];
    harness.overlay.openJobs();
    expect(harness.press("ctrl+g")).toBe(false);
    expect(harness.press("q")).toBe(true);
    expect(harness.overlay.isOpen()).toBe(false);
  });
});
