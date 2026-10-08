import { AsyncLocalStorage } from "node:async_hooks";
import type { AppServices } from "../ui-core/bootstrap/composition-root.js";
import type { ConfirmationPort } from "../app/ports/confirm-port.js";
import type { SecretPort } from "../app/ports/secret-port.js";
import { evaluateTui } from "../ui-core/bootstrap/can-use-tui.js";
import { isBunRuntime, isOpenTuiFfiError } from "../os/bun-runtime.js";
import type { RuntimeChildBridge } from "./child-bridge.js";
import type { RuntimeTerminalOptions, RuntimeViewFrame } from "./types.js";
import { RuntimeViewTerminal } from "./view-terminal.js";
import { createRuntimeViewServices } from "./view-services.js";

export interface RuntimeViewRenderer {
  repaint(): boolean;
  dispose(): Promise<void>;
}

export type RuntimeViewMount = (services: AppServices, terminal: RuntimeViewTerminal, options: RuntimeTerminalOptions) => Promise<RuntimeViewRenderer>;

interface ManagedView {
  readonly id: string;
  readonly terminal: RuntimeViewTerminal;
  readonly services: AppServices;
  ready: Promise<RuntimeViewRenderer>;
  renderer?: RuntimeViewRenderer | undefined;
  closed: boolean;
}

async function mountView(services: AppServices, terminal: RuntimeViewTerminal, options: RuntimeTerminalOptions): Promise<RuntimeViewRenderer> {
  const tui = options.ui !== "classic" && process.platform !== "win32" && isBunRuntime() && evaluateTui({ stdoutIsTTY: true, stdinIsTTY: true, columns: terminal.stdout.columns, rows: terminal.stdout.rows }).ok;
  if (tui) {
    try {
      const { mountOpenTuiRuntimeView } = await import("../tui-v2/bootstrap/runtime-view.js");
      return await mountOpenTuiRuntimeView(services, terminal, options.env);
    } catch (error) {
      if (!isOpenTuiFfiError(error)) throw error;
      services.toast.show("OpenTUI unavailable; using Classic", { level: "warn" });
    }
  }
  const { mountClassicRuntimeView } = await import("../classic/bootstrap/runtime-view.js");
  return await mountClassicRuntimeView(services, terminal, options.env);
}

export class RuntimeViewManager {
  private readonly views = new Map<string, ManagedView>();
  private readonly context = new AsyncLocalStorage<string>();
  private readonly waiting = new Set<() => void>();
  private readonly pending = new Set<ManagedView>();
  private readonly teardowns = new Set<Promise<void>>();
  private generation = 0;
  private requests: Promise<unknown> = Promise.resolve();
  private currentId: string | undefined;
  private closing = false;
  private disposal: Promise<void> | undefined;
  private shared: AppServices | undefined;

  readonly confirm: ConfirmationPort = {
    confirmTool: (call) => this.ask((view) => view.ports.confirm!.confirmTool(call), false),
    confirmPentest: (call) => this.ask((view) => view.ports.confirm!.confirmPentest(call), false),
    confirmAgentSwitch: (info) => this.ask((view) => view.ports.confirm!.confirmAgentSwitch!(info), false),
  };
  readonly requestSecret: SecretPort["request"] = (request) => this.ask((view) => view.ports.requestSecret!(request), undefined);

  constructor(private readonly bridge: Pick<RuntimeChildBridge, "writeView" | "closeView" | "minimise" | "switchSession">, private readonly mount: RuntimeViewMount = mountView) {}

  bind(services: AppServices): void { this.shared = services; }

  current(): AppServices | undefined {
    const id = this.context.getStore() ?? this.currentId;
    return (id ? this.views.get(id) : undefined)?.services ?? [...this.views.values()].at(-1)?.services;
  }

  async ask<T>(request: (view: AppServices) => Promise<T>, fallback: T): Promise<T> {
    const origin = this.context.getStore();
    const generation = this.generation;
    const task = this.requests.catch(() => undefined).then(async () => {
      while (!this.closing && generation === this.generation) {
        const view = (origin ? this.views.get(origin) : undefined) ?? (this.currentId ? this.views.get(this.currentId) : undefined) ?? [...this.views.values()].at(-1);
        if (!view) { await new Promise<void>((resolve) => this.waiting.add(resolve)); continue; }
        this.pending.add(view);
        try {
          const answer = await request(view.services);
          if (this.closing || generation !== this.generation) return fallback;
          if (!view.closed) return answer;
        } finally { this.pending.delete(view); }
      }
      return fallback;
    });
    this.requests = task.catch(() => undefined);
    return await task;
  }

  receive(frame: RuntimeViewFrame): void {
    if (this.closing) return;
    if (frame.type === "view-attach") { this.attach(frame); return; }
    const view = this.views.get(frame.clientId);
    if (!view) return;
    if (frame.type === "view-detach") { void this.detach(view.id); return; }
    if (frame.type === "view-resize") { view.terminal.resize(frame); return; }
    const bytes = Buffer.from(frame.data, "base64");
    if (bytes.toString("base64") !== frame.data) return;
    this.currentId = view.id;
    if (view.terminal.stdin.writableLength + view.terminal.stdin.readableLength + bytes.length > 1024 * 1024) {
      this.bridge.closeView(view.id);
      void this.detach(view.id);
      return;
    }
    view.terminal.stdin.write(bytes);
  }

  private attach(frame: Extract<RuntimeViewFrame, { type: "view-attach" }>): void {
    const existing = this.views.get(frame.clientId);
    if (existing) { existing.terminal.resize(frame); existing.renderer?.repaint(); return; }
    if (!this.shared || this.views.size >= 16) { this.bridge.closeView(frame.clientId); return; }
    const terminal = new RuntimeViewTerminal(frame, (bytes) => this.bridge.writeView(frame.clientId, bytes));
    let view: ManagedView;
    const services = createRuntimeViewServices({
      shared: this.shared, terminal, options: frame.terminal,
      runSession: (method, action) => {
        if (method === "abort" || method === "cancelAll") this.cancelRequests();
        return this.context.run(frame.clientId, action);
      },
      minimise: () => this.bridge.minimise(frame.clientId),
      switchSession: (sessionId, closeCurrent, fresh) => this.bridge.switchSession(sessionId, closeCurrent, fresh, frame.clientId),
      repaint: () => view?.renderer?.repaint() ?? false,
      hasOtherViews: () => this.views.size > 1,
    });
    view = { id: frame.clientId, services, terminal, closed: false, ready: Promise.resolve().then(() => this.mount(services, terminal, frame.terminal)) };
    this.views.set(view.id, view);
    this.currentId = view.id;
    terminal.stdout.on("error", () => { if (!view.closed) { this.bridge.closeView(view.id); void this.detach(view.id); } });
    void view.ready.then((renderer) => { view.renderer = renderer; }, (error: unknown) => {
      if (view.closed) return;
      services.toast.show(error instanceof Error ? error.message : String(error), { level: "error" });
      this.bridge.closeView(view.id);
      void this.detach(view.id);
    });
    this.wakeWaiting();
  }

  private wakeWaiting(): void { for (const wake of this.waiting) wake(); this.waiting.clear(); }

  private cancelRequests(): void {
    this.generation += 1;
    for (const view of this.pending) view.services.overlay.cancelBlockingPrompt();
    this.wakeWaiting();
  }

  detach(id: string): Promise<void> {
    const view = this.views.get(id);
    if (!view) return Promise.resolve();
    this.views.delete(id);
    view.closed = true;
    view.services.overlay.cancelBlockingPrompt();
    const teardown = (async () => {
      try { const renderer = await view.ready; await renderer.dispose(); }
      catch {}
      finally { view.services.dispose(); view.terminal.dispose(); }
    })();
    this.teardowns.add(teardown);
    void teardown.finally(() => this.teardowns.delete(teardown));
    return teardown;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.cancelRequests();
    for (const id of this.views.keys()) void this.detach(id);
    this.disposal = Promise.all([...this.teardowns]).then(() => undefined);
    return this.disposal;
  }
}
