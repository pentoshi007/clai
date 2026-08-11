import { vi } from "vitest";
import type { PersistencePort } from "../../../src/app/ports/persistence-port.js";
import type { JobsPort } from "../../../src/app/ports/jobs-port.js";
import {
  createClassicAppWiring,
  type ClassicAppWiring,
} from "../../../src/classic/app/app-wiring.js";
import { detectCapabilities } from "../../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../../src/ui-core/commands/command-handlers.js";
import {
  createCompositionRoot,
  type AppServices,
} from "../../../src/ui-core/bootstrap/composition-root.js";
import type { AnyAppEvent } from "../../../src/app/events.js";

export function fakePersistence(): PersistencePort {
  return {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

export function stubJobsPort(): JobsPort {
  return {
    subscribe: () => () => undefined,
    running: () => [],
    recent: () => [],
    pendingNotifications: () => [],
    get: () => undefined,
    start: async () => {
      throw new Error("not supported");
    },
    stop: async () => undefined,
    tail: () => "",
    acknowledge: () => undefined,
  } as unknown as JobsPort;
}

export interface Harness {
  readonly services: AppServices;
  readonly wiring: ClassicAppWiring;
  readonly emit: (event: AnyAppEvent) => void;
  readonly toastTexts: () => readonly string[];
  dispose(): void;
}

export interface HarnessOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly commands?: boolean;
  readonly requestExit?: () => void;
  readonly updates?: AppServices["ports"]["updates"];
  readonly agent?: AppServices["ports"]["agent"];
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const columns = options.columns ?? 100;
  const rows = options.rows ?? 24;
  let emit: ((event: AnyAppEvent) => void) | undefined;
  const services = createCompositionRoot({
    persistence: fakePersistence(),
    jobs: stubJobsPort(),
    agent: options.agent,
    requestExit: options.requestExit,
    updates:
      options.updates ??
      ({
        check: async () => ({ state: "up-to-date", currentVersion: "0.0.0" }),
      } as AppServices["ports"]["updates"]),
    mode: "agent",
    model: "test-model",
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns,
      rows,
    }),
    emit: (event) => emit?.(event),
  });

  if (options.commands === true) attachCommandHandlers(services);

  const wiring = createClassicAppWiring({
    services,
    mouse: false,
    resizeSource: { columns, rows, on: () => undefined, off: () => undefined },
  });

  return {
    services,
    wiring,
    emit: (event) => services.transcript.dispatch(event),
    toastTexts: () => services.toast.getToasts().map((toast) => toast.message),
    dispose() {
      wiring.dispose();
      services.dispose();
      vi.restoreAllMocks();
    },
  };
}
