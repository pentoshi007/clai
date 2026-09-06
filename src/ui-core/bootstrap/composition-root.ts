
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
import { CancelCoordinator } from "../../app/controllers/cancel-coordinator.js";
import {
  buildDefaultCommandRegistry,
  type CommandRegistry,
} from "../../app/commands/registry.js";
import { ActionRouter } from "../actions/action-router.js";
import { FocusController } from "../controllers/focus-controller.js";
import { SelectionController } from "../controllers/selection-controller.js";
import { ToastController, DEFAULT_TOAST_DURATION_MS } from "../controllers/toast-controller.js";
import { isProviderFailureStatus } from "../../llm/key-rotation.js";
import { InterruptibleController } from "../controllers/interruptible-controller.js";
import { OverlayController } from "../controllers/overlay-controller.js";
import { McpRuntime } from "../../mcp/runtime.js";
import { openSystemBrowser } from "../../mcp/auth/loopback.js";
import { getSkillIndex } from "../../skills/registry.js";
import { safeCwd } from "../../os/cwd.js";
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
import { onTransportEvent, type TransportEvent } from "../../llm/transport-events.js";

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
  readonly mcp?: McpRuntime | undefined;
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
  readonly copyOnRelease?: boolean | undefined;
  readonly pagerExport?: PagerExportPort | undefined;
  readonly requestExit?: (() => void) | undefined;
  readonly requestMinimise?: (() => boolean) | undefined;
  readonly requestSessionSwitch?: ((sessionId: string, closeCurrent: boolean, fresh?: boolean) => boolean) | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly mode?: Mode | undefined;
  readonly noHistory?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly idFactory?: IdFactory | undefined;
  readonly clock?: Clock | undefined;
}

export interface AppServices {
  readonly mcp: McpRuntime;
  readonly ports: AppPorts;
  readonly commands: CommandRegistry;
  readonly session: SessionController;
  readonly focus: FocusController;
  readonly router: ActionRouter;
  readonly selection: SelectionController;
  readonly toast: ToastController;
  readonly transcript: TranscriptStore;
  readonly plan: PlanController;
  readonly overlay: OverlayController;
  readonly interruptible: InterruptibleController;
  readonly cancel: CancelCoordinator;
  readonly pagerExport: PagerExportPort;
  readonly requestExit: () => void;
  readonly requestMinimise: () => boolean;
  readonly requestSessionSwitch: (sessionId: string, closeCurrent: boolean, fresh?: boolean) => boolean;
  readonly capabilities: TerminalCapabilityReport;
  readonly recordedEvents: readonly AnyAppEvent[];
  dispose(): void;
}

export function createCompositionRoot(
  options: CompositionOptions = {},
): AppServices {
  let sessionRef: SessionController | undefined;
  let overlay: OverlayController;
  const mcp =
    options.mcp ??
    new McpRuntime({
      openBrowser: openSystemBrowser,
      oauthInteractive: true,
      onDeviceAuthorization: (info) => {
        const lines = [
          `MCP server: ${info.serverUrl}`,
          "",
          "1. Open this URL on any device:",
          `   ${info.verificationUriComplete ?? info.verificationUri}`,
          "",
          `2. Enter this code: ${info.userCode}`,
          "",
          `The code expires in ${Math.max(1, Math.round(info.expiresInSeconds / 60))} minute(s). Sign-in completes automatically once approved.`,
        ];
        const shown = overlay?.openPager(
          `MCP sign-in · ${info.serverUrl}`,
          lines.join("\n"),
          undefined,
          undefined,
          "plain",
        );
        if (!shown) {
          sessionRef?.notice(
            "info",
            lines.filter((line) => line.trim().length > 0).join(" · "),
          );
        }
      },
      onAuthorizationUrl: (info) => {
        const shown = overlay?.openPager(
          `MCP sign-in · ${info.serverUrl}`,
          [
            `MCP server: ${info.serverUrl}`,
            "",
            "If the browser did not open, complete sign-in at:",
            `   ${info.url}`,
          ].join("\n"),
          undefined,
          undefined,
          "plain",
        );
        if (!shown) sessionRef?.notice("info", `MCP sign-in: ${info.url}`);
      },
      requestOAuthConsent: (info) =>
        overlay?.openConfirm({
          kind: "mcp-oauth",
          prompt: [
            info.message ?? "Authorize MCP access?",
            `Server: ${info.serverUrl}`,
            info.issuer ? `Issuer: ${info.issuer}` : undefined,
            info.scope ? `Scope: ${info.scope}` : undefined,
          ]
            .filter((line): line is string => typeof line === "string")
            .join("\n"),
        }) ?? Promise.resolve(false),
    });
  const recorded: AnyAppEvent[] = [];
  const captureEvents = options.captureEvents === true;
  const transcript = new TranscriptStore();
  const persistence = options.persistence ?? createCurrentPersistencePort();
  const plan = new PlanController(persistence);
  const externalEmit = options.emit;
  const focus = new FocusController();
  overlay = new OverlayController(focus);
  const toast = new ToastController();
  const interruptible = new InterruptibleController();

  const transportEventMessage = (event: TransportEvent): string => {
    const base = `${event.provider}/${event.model}`;
    switch (event.kind) {
      case "responses-fallback-endpoint":
        return `${base}: /responses not supported — using chat completions`;
      case "responses-fallback-shape":
        return `${base}: /responses returned chat-shaped data — using chat completions`;
      case "responses-fallback-error":
        return `${base}: /responses error${event.detail ? ` ${event.detail}` : ""} — using chat completions`;
      case "responses-fallback-reasoning":
        return `${base}: thinking not visible on /responses — using chat completions for reasoning`;
      case "responses-downgrade-extras":
        return `${base}: retrying /responses without optional extras`;
      case "responses-eof-accepted":
        return `${base}: /responses stream ended without completion — accepted partial output`;
      default:
        return `${base}: /responses fallback ${event.kind}`;
    }
  };

  const unsubscribeTransport = onTransportEvent((event) => {
    const level = event.kind === "responses-downgrade-extras" ? "info" : "warn";
    toast.show(transportEventMessage(event), {
      level,
      key: `transport-${event.provider}-${event.model}-${event.kind}`,
      durationMs: 3500,
    });
  });

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
          ...(event.payload.promptTokensKnown === false
            ? { promptTokensKnown: false }
            : {}),
          ...(event.payload.cachedPromptTokens !== undefined
            ? { cachedPromptTokens: event.payload.cachedPromptTokens }
            : {}),
          ...(event.payload.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: event.payload.cacheCreationTokens }
            : {}),
          ...(event.payload.uncachedPromptTokens !== undefined
            ? { uncachedPromptTokens: event.payload.uncachedPromptTokens }
            : {}),
          ...(event.payload.reasoningTokens !== undefined
            ? { reasoningTokens: event.payload.reasoningTokens }
            : {}),
        },
        event.payload.model,
        event.payload.provider,
        event.payload.attempt,
        event.payload.api,
      );
    }
    if (event.type === "compaction-completed" && sessionRef) {
      sessionRef.noteContextCompacted(
        event.payload.afterTokens,
        event.payload.contextScope,
        event.payload.compactionId,
      );
    }
    if (event.type === "context-estimate" && sessionRef) {
      sessionRef.noteContextEstimate(event.payload.estimatedTokens);
    }
    if (event.type === "notice") {
      const level = event.payload.level === "warn" ? "warn" : "info";
      const text = event.payload.text;
      const apiKeyRotation =
        /^switching /i.test(text.trim()) || /API keys failed/i.test(text);
      const providerFailure =
        !apiKeyRotation && event.payload.level === "warn" && isProviderFailureStatus(text);
      toast.show(text, {
        level: apiKeyRotation || providerFailure ? "warn" : level,
        key: apiKeyRotation
          ? "api-key-rotation"
          : providerFailure
            ? "provider-status"
            : `notice-${level}`,
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
    agent: options.agent ?? createCurrentAgentPort({ mcp }),
    persistence,
    jobs: options.jobs ?? createCurrentJobsPort(),
    interactiveSessions:
      options.interactiveSessions ?? createCurrentInteractiveSessionsPort(),
    updates: options.updates ?? createCurrentUpdatesPort(),
    clipboard: options.clipboard ?? createSystemClipboardPort(),
    confirm: options.confirm ?? createOverlayConfirmPort(overlay),
    requestSecret: options.requestSecret ?? createOverlaySecretPort(overlay),
  };
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
      return transcript.mergePersistSnapshot(
        serializeForHistory(transcript.getState(), (id) => live.spool.tail(id)),
      );
    },
  });
  sessionRef = session;
  const cancel = new CancelCoordinator({
    session,
    sessionId: () => session.sessionId,
    jobs: ports.jobs,
    interruptible,
  });
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

  void getSkillIndex({ cwd: safeCwd() }).catch(() => undefined);

  let disposed = false;
  return {
    mcp,
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
    interruptible,
    cancel,
    pagerExport,
    requestExit: options.requestExit ?? (() => {}),
    requestMinimise: options.requestMinimise ?? (() => false),
    requestSessionSwitch:
      options.requestSessionSwitch ?? (() => false),
    capabilities,
    recordedEvents: recorded,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeTransport();
      unsubscribePlanJobs();
      interruptible.cancelAll();
      overlay.dispose();
      selection.dispose();
      toast.dispose();
      plan.dispose();
      session.dispose();
      void mcp.closeAll();
    },
  };
}
