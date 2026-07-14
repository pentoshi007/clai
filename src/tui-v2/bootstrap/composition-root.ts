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
import {
  detectCapabilities,
  readCapabilitiesFromProcess,
  type TerminalCapabilityReport,
} from "./capabilities.js";

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
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly mode?: Mode | undefined;
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
  readonly capabilities: TerminalCapabilityReport;
  /** Events captured when no external `emit` sink is supplied (test aid). */
  readonly recordedEvents: readonly AnyAppEvent[];
  dispose(): void;
}

export function createCompositionRoot(
  options: CompositionOptions = {},
): AppServices {
  const recorded: AnyAppEvent[] = [];
  const emit = options.emit ?? ((event) => void recorded.push(event));

  const ports: AppPorts = {
    agent: options.agent ?? createCurrentAgentPort(),
    persistence: options.persistence ?? createCurrentPersistencePort(),
    jobs: options.jobs ?? createCurrentJobsPort(),
    updates: options.updates ?? createCurrentUpdatesPort(),
    clipboard: options.clipboard ?? createInMemoryClipboardPort(),
    confirm: options.confirm,
    requestSecret: options.requestSecret,
  };

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
  });

  const commands = buildDefaultCommandRegistry();
  const focus = new FocusController();
  const router = new ActionRouter();
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
    capabilities,
    recordedEvents: recorded,
    dispose() {
      if (disposed) return;
      disposed = true;
      session.dispose();
    },
  };
}
