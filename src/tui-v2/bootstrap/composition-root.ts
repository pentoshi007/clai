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
import { createCurrentUpdatesPort } from "../../app/adapters/current-updates-adapter.js";
import { createInMemoryClipboardPort } from "../../app/adapters/in-memory-clipboard-adapter.js";
import { SessionController } from "../../app/controllers/session-controller.js";
import {
  buildDefaultCommandRegistry,
  type CommandRegistry,
} from "../../app/commands/registry.js";
import { ActionRouter } from "../actions/action-router.js";
import { FocusController } from "../controllers/focus-controller.js";
import { SelectionController } from "../controllers/selection-controller.js";
import { ToastController } from "../controllers/toast-controller.js";
import { OverlayController } from "../controllers/overlay-controller.js";
import { TranscriptStore } from "../state/transcript-store.js";
import { serializeForHistory } from "../state/transcript-hydrate.js";
import { PlanController } from "../../app/controllers/plan-controller.js";
import type { PagerExportPort } from "./pager-export.js";
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
  readonly updates: UpdatesPort;
  readonly clipboard: ClipboardPort;
  readonly confirm: ConfirmationPort | undefined;
  readonly requestSecret: SecretPort["request"] | undefined;
}

export interface CompositionOptions {
  readonly agent?: AgentPort | undefined;
  readonly persistence?: PersistencePort | undefined;
  readonly jobs?: JobsPort | undefined;
  readonly updates?: UpdatesPort | undefined;
  readonly clipboard?: ClipboardPort | undefined;
  readonly confirm?: ConfirmationPort | undefined;
  readonly requestSecret?: SecretPort["request"] | undefined;
  readonly emit?: ((event: AnyAppEvent) => void) | undefined;
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
  /** Events captured when no external `emit` sink is supplied (test aid). */
  readonly recordedEvents: readonly AnyAppEvent[];
  dispose(): void;
}

export function createCompositionRoot(
  options: CompositionOptions = {},
): AppServices {
  const recorded: AnyAppEvent[] = [];
  const transcript = new TranscriptStore();
  const persistence = options.persistence ?? createCurrentPersistencePort();
  const plan = new PlanController(persistence);
  const externalEmit = options.emit;
  // The transcript store and plan controller observe every event
  // unconditionally; the recorder/external sink split below is unrelated to
  // that (it is only about where raw AppEvents surface for tests/consumers).
  const emit = (event: AnyAppEvent): void => {
    transcript.dispatch(event);
    plan.observe(event);
    if (externalEmit) externalEmit(event);
    else recorded.push(event);
  };

  const focus = new FocusController();
  const overlay = new OverlayController(focus);

  const ports: AppPorts = {
    agent: options.agent ?? createCurrentAgentPort(),
    persistence,
    jobs: options.jobs ?? createCurrentJobsPort(),
    updates: options.updates ?? createCurrentUpdatesPort(),
    clipboard: options.clipboard ?? createInMemoryClipboardPort(),
    confirm: options.confirm ?? createOverlayConfirmPort(overlay),
    requestSecret: options.requestSecret ?? createOverlaySecretPort(overlay),
  };
  const toast = new ToastController();
  // Auto-copy-on-release disabled — it fought touch/focus/history.
  // Explicit copy remains via Ctrl+Shift+C (selection.copy).
  const selection = new SelectionController(ports.clipboard, {
    copyOnRelease: options.copyOnRelease ?? false,
  });

  // Late-bound: session is constructed below; snapshot closes over it.
  let sessionRef: SessionController | undefined;
  const session = new SessionController({
    agent: ports.agent,
    persistence: ports.persistence,
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
    getTranscriptSnapshot: () => {
      const live = sessionRef;
      if (!live) return undefined;
      return serializeForHistory(transcript.getState(), (id) => live.spool.tail(id));
    },
  });
  sessionRef = session;

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
      overlay.dispose();
      selection.dispose();
      toast.dispose();
      plan.dispose();
      session.dispose();
    },
  };
}
