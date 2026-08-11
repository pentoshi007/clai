import type { BackgroundJob, JobsPort } from "../../../src/app/ports/jobs-port.js";
import type { SessionPlan } from "../../../src/store/plan.js";
import { FocusController } from "../../../src/ui-core/controllers/focus-controller.js";
import { OverlayController } from "../../../src/ui-core/controllers/overlay-controller.js";
import { PanelController } from "../../../src/classic/panels/panel-controller.js";
import { plainText } from "../../../src/classic/render/ansi-text.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type TranscriptState,
} from "../../../src/ui-core/state/transcript-types.js";

export const ink = createInkTheme({
  themeHint: "dark",
  colorMode: "none",
  unicode: true,
});

export const colorInk = createInkTheme({
  themeHint: "dark",
  colorMode: "truecolor",
  unicode: true,
});

export const asciiInk = createInkTheme({
  themeHint: "dark",
  colorMode: "none",
  unicode: false,
});

export function rowsOf(frameRows: readonly string[]): string[] {
  return frameRows.map((row) => plainText(row).trimEnd());
}

export interface Harness {
  readonly focus: FocusController;
  readonly overlay: OverlayController;
  readonly panels: PanelController;
  readonly toasts: string[];
  readonly copied: string[];
  readonly edited: string[];
  readonly revealed: string[];
  readonly hidden: number[];
  readonly exports: string[];
  readonly stopped: string[];
  jobs: BackgroundJob[];
  plan: SessionPlan | undefined;
  transcript: TranscriptState;
  columns: number;
  rows: number;
  press(chord: string, text?: string): boolean;
  handlePasteThroughPanels(text: string): boolean;
}

export function createJobsPort(getJobs: () => BackgroundJob[], stopped: string[]): JobsPort {
  return {
    list: () => ({ ok: true, content: "" }) as never,
    running: () => getJobs().filter((job) => job.status === "running"),
    recent: () => getJobs(),
    get: (id) => getJobs().find((job) => job.id === id),
    tail: async () => ({ ok: true, content: "" }) as never,
    stop: async (id) => {
      stopped.push(id);
      return { ok: true, content: "" } as never;
    },
    start: async () => ({ ok: true, content: "" }) as never,
    pendingNotifications: () => [],
    activateResponderLease: () => "lease",
    getResponderLeaseId: () => undefined,
    releaseResponderLease: () => undefined,
    claimNextResponderNotification: () => undefined,
    markDeliveryStarted: () => true,
    markDelivered: () => true,
    markRead: () => true,
    markAnalyzed: () => true,
    acknowledge: () => true,
    subscribe: () => () => undefined,
    linkJob: () => undefined,
    cancelAll: async () => ({ ok: true, content: "" }) as never,
  };
}

export function createHarness(
  options: { readonly columns?: number; readonly rows?: number } = {},
): Harness {
  const focus = new FocusController();
  const overlay = new OverlayController(focus);
  const toasts: string[] = [];
  const copied: string[] = [];
  const edited: string[] = [];
  const revealed: string[] = [];
  const hidden: number[] = [];
  const exports: string[] = [];
  const stopped: string[] = [];

  const state = {
    jobs: [] as BackgroundJob[],
    plan: undefined as SessionPlan | undefined,
    transcript: EMPTY_TRANSCRIPT_STATE as TranscriptState,
    columns: options.columns ?? 80,
    rows: options.rows ?? 24,
  };

  const panels = new PanelController({
    overlay,
    clipboard: {
      writeText: async (text) => {
        copied.push(text);
      },
    },
    jobs: createJobsPort(() => state.jobs, stopped),
    transcript: () => state.transcript,
    plan: () => state.plan,
    columns: () => state.columns,
    rows: () => Math.max(0, state.rows - 6),
    onToast: (text) => toasts.push(text),
    onEditPrompt: (text) => edited.push(text),
    onHidePlan: () => hidden.push(1),
    onRevealItem: (id) => revealed.push(id),
    exportScrollback: (body) => exports.push(`scrollback:${body}`),
    exportEditor: (body) => exports.push(`editor:${body}`),
  });

  return {
    focus,
    overlay,
    panels,
    toasts,
    copied,
    edited,
    revealed,
    hidden,
    exports,
    stopped,
    get jobs() {
      return state.jobs;
    },
    set jobs(value: BackgroundJob[]) {
      state.jobs = value;
    },
    get plan() {
      return state.plan;
    },
    set plan(value: SessionPlan | undefined) {
      state.plan = value;
    },
    get transcript() {
      return state.transcript;
    },
    set transcript(value: TranscriptState) {
      state.transcript = value;
    },
    get columns() {
      return state.columns;
    },
    set columns(value: number) {
      state.columns = value;
    },
    get rows() {
      return state.rows;
    },
    set rows(value: number) {
      state.rows = value;
    },
    press: (chord, text) => panels.handleKey(chord, text),
    handlePasteThroughPanels: (text) => panels.handlePaste(text),
  };
}

export function job(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: overrides.id ?? "job-1",
    command: overrides.command ?? "npm test",
    commandDisplay: overrides.commandDisplay ?? "npm test",
    cwd: "/tmp",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? new Date(0).toISOString(),
    endedAt: overrides.endedAt,
    exitCode: overrides.exitCode,
    artifactPath: "/tmp/job-1",
    stdoutArtifact: "/tmp/job-1.out",
    stderrArtifact: "/tmp/job-1.err",
    artifacts: {
      stdout: { path: "/tmp/job-1.out", chunks: [], bytes: 0, droppedBytes: 0, redacted: false, sha256: "" },
      stderr: { path: "/tmp/job-1.err", chunks: [], bytes: 0, droppedBytes: 0, redacted: false, sha256: "" },
    },
    redactionProfile: "default",
    ownerSessionId: "session",
    ...overrides,
  } as BackgroundJob;
}

export function plan(tasks: SessionPlan["tasks"], status: SessionPlan["status"] = "in_progress"): SessionPlan {
  return {
    sessionId: "session",
    goal: "add pagination to the users endpoint",
    detail: "",
    tasks,
    status,
    kind: "code",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
