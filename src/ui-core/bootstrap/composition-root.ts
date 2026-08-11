/**
 * Dependency-injection root (V2-031).
 *
 * Constructs the ports, controllers, and command registry once at bootstrap
 * and returns them as an explicit service bundle — no service locator, no
 * hidden singletons. Every dependency is overridable so the shell can be
 * assembled with fakes in tests. This module is renderer-independent: it wires
 * the application layer and input controllers but imports no `@opentui`/React.
 */

import type { Mode, ProviderId } from "../../types.js";
import type { AnyAppEvent } from "../../app/events/app-event.js";
import type { Clock, IdFactory } from "../../app/events/sequencer.js";
import type { AgentPort } from "../../app/ports/agent-port.js";
import type { PersistencePort } from "../../app/ports/persistence-port.js";
import type { JobsPort } from "../../app/ports/jobs-port.js";
import type { UpdatesPort } from "../../app/ports/updates-port.js";
import type { ClipboardPort } from "../../app/ports/clipboard-port.js";
import type { ConfirmationPort } from "../../app/ports/confirm-port.js";
import type { SecretPort } from "../../app/ports/secret-port.js";
import { createCurrentAgentPort } from "../../app/adapters/current-agent-adapter.js";
import { createCurrentPersistencePort } from "../../app/adapters/current-store-adapter.js";
import { createCurrentJobsPort } from "../../app/adapters/current-jobs-adapter.js";
import { createCurrentInteractiveSessionsPort } from "../../app/adapters/current-interactive-sessions-adapter.js";
import type { InteractiveSessionsPort } from "../../app/ports/interactive-sessions-port.js";
import { createCurrentUpdatesPort } from "../../app/adapters/current-updates-adapter.js";
import { createSystemClipboardPort } from "../../app/adapters/in-memory-clipboard-adapter.js";
import { SessionController } from "../../app/controllers/session-controller.js";
import {
  buildDefaultCommandRegistry,
  type CommandRegistry,
} from "../../app/commands/registry.js";
import { ActionRouter } from "../actions/action-router.js";
import { FocusController } from "../controllers/focus-controller.js";
import { SelectionController } from "../controllers/selection-controller.js";
import { ToastController, DEFAULT_TOAST_DURATION_MS } from "../controllers/toast-controller.js";
import { OverlayController } from "../controllers/overlay-controller.js";
import { TranscriptStore } from "../state/transcript-store.js";
import { serializeForHistory } from "../state/transcript-hydrate.js";
import { PlanController } from "../../app/controllers/plan-controller.js";
import type { PagerExportPort } from "../ports/pager-export-port.js";
import { createOverlayConfirmPort, createOverlaySecretPort } from "./overlay-ports.js";
import {
  detectCapabilities,
  readCapabilitiesFromProcess,
  type TerminalCapabilityReport,
} from "./capabilities.js";

function noopPagerExportPort(): PagerExportPort {
  return {
    exportToScrollback: () => ({ ok: false, error: "no renderer attached" }),
    exportToEditor: async () => ({ ok: false, error: "no renderer attached" }),
  };
}

export interface AppPorts {
  readonly agent: AgentPort;
  readonly persistence: PersistencePort;
  readonly jobs: JobsPort;
  readonly interactiveSessions: InteractiveSessionsPort;
  readonly updates: UpdatesPort;
  readonly clipboard: ClipboardPort;
  readonly confirm: ConfirmationPort | undefined;
  readonly requestSecret: SecretPort["request"] | undefined;
}

export interface CompositionOptions {
  readonly agent?: AgentPort | undefined;
  readonly persistence?: PersistencePort | undefined;
  readonly jobs?: JobsPort | undefined;
  readonly interactiveSessions?: InteractiveSessionsPort | undefined;
  readonly updates?: UpdatesPort | undefined;
  readonly clipboard?: ClipboardPort | undefined;
  readonly confirm?: ConfirmationPort | undefined;
  readonly requestSecret?: SecretPort["request"] | undefined;
  readonly emit?: ((event: AnyAppEvent) => void) | undefined;
  readonly captureEvents?: boolean | undefined;
  readonly capabilities?: TerminalCapabilityReport | undefined;
  /** SEL-006: auto-copy a non-empty mouse selection on release. Default true. */
  readonly copyOnRelease?: boolean | undefined;
  readonly pagerExport?: PagerExportPort | undefined;
  /** Signals the renderer to tear down and exit (Ctrl+D / second Ctrl+C). */
  readonly requestExit?: (() => void) | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly mode?: Mode | undefined;
  /** Skip session persistence + AI titles (CLI --no-history). */
  readonly noHistory?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly idFactory?: IdFactory | undefined;
  readonly clock?: Clock | undefined;
}

export interface AppServices {
  readonly ports: AppPorts;
  readonly commands: CommandRegistry;
  readonly session: SessionController;
  readonly focus: FocusController;
  readonly router: ActionRouter;
  /** Single owner for pane-scoped semantic selection and copy requests. */
  readonly selection: SelectionController;
  /** Ephemeral right-edge toasts (copy confirmation, short status). */
  readonly toast: ToastController;
  readonly transcript: TranscriptStore;
  readonly plan: PlanController;
  /** Single owner for the one blocking overlay (picker/confirm/secret/pager/jobs). */
  readonly overlay: OverlayController;
  readonly pagerExport: PagerExportPort;
  readonly requestExit: () => void;
  readonly capabilities: TerminalCapabilityReport;
  /** Bounded raw events when captureEvents is explicitly enabled. */
  readonly recordedEvents: readonly AnyAppEvent[];
  dispose(): void;
}

export function createCompositionRoot(
  options: CompositionOptions = {},
): AppServices {
  const recorded: AnyAppEvent[] = [];
  const captureEvents = options.captureEvents === true;
  const transcript = new TranscriptStore();
  const persistence = options.persistence ?? createCurrentPersistencePort();
  const plan = new PlanController(persistence);
  const externalEmit = options.emit;
  // The transcript store and plan controller observe every event
  // unconditionally; the recorder/external sink split below is unrelated to
  // that (it is only about where raw AppEvents surface for tests/consumers).
  // Late-bound: session is constructed below; usage recording closes over it.
  let sessionRef: SessionController | undefined;
  const focus = new FocusController();
  const overlay = new OverlayController(focus);
  const toast = new ToastController();

  const emit = (event: AnyAppEvent): void => {
    transcript.dispatch(event);
    plan.observe(event);
    if (event.type === "token-usage" && sessionRef) {
      sessionRef.recordTokenUsage(
        {
          promptTokens: event.payload.promptTokens,
          completionTokens: event.payload.completionTokens,
          totalTokens: event.payload.totalTokens,
          exact: event.payload.exact,
        },
        event.payload.model,
      );
    }
    // Auto-compaction mutates history through onMessages. Its provider usage is
    // otherwise stale until the following model response, so immediately use
    // the same final assembled-request estimate shown on the compaction card.
    if (event.type === "compaction-completed" && sessionRef) {
      sessionRef.noteContextCompacted(event.payload.afterTokens);
    }
    if (event.type === "context-estimate" && sessionRef) {
      sessionRef.noteContextEstimate(event.payload.estimatedTokens);
    }
    // session.notice / agent notices → toast only (not chat items).
    if (event.type === "notice") {
      const level = event.payload.level === "warn" ? "warn" : "info";
      const text = event.payload.text;
      // Multi-API-key rotation: only *switch* / exhausted toasts (never "using"
      // every step). Same replace-key so chips never stack.
      const apiKeyRotation =
        /^switching /i.test(text.trim()) || /API keys failed/i.test(text);
      toast.show(text, {
        level: apiKeyRotation ? "warn" : level,
        key: apiKeyRotation ? "api-key-rotation" : `notice-${level}`,
        durationMs: apiKeyRotation ? 3000 : DEFAULT_TOAST_DURATION_MS,
      });
    }
    if (captureEvents) {
      recorded.push(event);
      if (recorded.length > 2_000) recorded.splice(0, recorded.length - 2_000);
    }
    externalEmit?.(event);
  };

  const ports: AppPorts = {
    agent: options.agent ?? createCurrentAgentPort(),
    persistence,
    jobs: options.jobs ?? createCurrentJobsPort(),
    interactiveSessions:
      options.interactiveSessions ?? createCurrentInteractiveSessionsPort(),
    updates: options.updates ?? createCurrentUpdatesPort(),
    clipboard: options.clipboard ?? createSystemClipboardPort(),
    confirm: options.confirm ?? createOverlayConfirmPort(overlay),
    requestSecret: options.requestSecret ?? createOverlaySecretPort(overlay),
  };
  // Auto-copy-on-release disabled — it fought touch/focus/history.
  // Explicit copy remains via Ctrl+Shift+C (selection.copy).
  const selection = new SelectionController(ports.clipboard, {
    copyOnRelease: options.copyOnRelease ?? false,
  });

  const session = new SessionController({
    agent: ports.agent,
    persistence: ports.persistence,
    jobs: ports.jobs,
    interactiveSessions: ports.interactiveSessions,
    emit,
    confirm: ports.confirm,
    requestSecret: ports.requestSecret,
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    sessionId: options.sessionId,
    idFactory: options.idFactory,
    clock: options.clock,
    noHistory: options.noHistory,
    notifyResponderDelivery: (summary) =>
      toast.success(summary, { key: "responder-delivery", durationMs: 3200 }),
    getTranscriptSnapshot: () => {
      const live = sessionRef;
      if (!live) return undefined;
      return serializeForHistory(transcript.getState(), (id) => live.spool.tail(id));
    },
  });
  sessionRef = session;
  const unsubscribePlanJobs = ports.jobs.subscribe((change) => {
    if (change.type !== "notification") return;
    const job = ports.jobs.get(change.jobId);
    if (!job || job.ownerSessionId !== session.sessionId) return;
    void plan.refresh(session.sessionId);
  });

  const commands = buildDefaultCommandRegistry();
  const router = new ActionRouter();
  const pagerExport = options.pagerExport ?? noopPagerExportPort();
  const capabilities =
    options.capabilities ??
    (typeof process !== "undefined"
      ? readCapabilitiesFromProcess()
      : detectCapabilities({
          env: {},
          stdoutIsTTY: false,
          stdinIsTTY: false,
          columns: undefined,
          rows: undefined,
        }));

  let disposed = false;
  return {
    ports,
    commands,
    session,
    focus,
    router,
    selection,
    toast,
    transcript,
    plan,
    overlay,
    pagerExport,
    requestExit: options.requestExit ?? (() => {}),
    capabilities,
    recordedEvents: recorded,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribePlanJobs();
      overlay.dispose();
      selection.dispose();
      toast.dispose();
      plan.dispose();
      session.dispose();
    },
  };
}
