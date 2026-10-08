import { buildDefaultCommandRegistry } from "../app/commands/registry.js";
import { CancelCoordinator } from "../app/controllers/cancel-coordinator.js";
import { createSystemClipboardPort } from "../app/adapters/in-memory-clipboard-adapter.js";
import type { AppServices } from "../ui-core/bootstrap/composition-root.js";
import { ActionRouter } from "../ui-core/actions/action-router.js";
import { FocusController } from "../ui-core/controllers/focus-controller.js";
import { OverlayController } from "../ui-core/controllers/overlay-controller.js";
import { SelectionController } from "../ui-core/controllers/selection-controller.js";
import { ToastController, type ToastItem } from "../ui-core/controllers/toast-controller.js";
import { InterruptibleController } from "../ui-core/controllers/interruptible-controller.js";
import { detectCapabilities } from "../ui-core/bootstrap/capabilities.js";
import { createOverlayConfirmPort, createOverlaySecretPort } from "../ui-core/bootstrap/overlay-ports.js";
import { createOsc52ClipboardPort } from "../ui-core/ports/clipboard-osc52.js";
import { createOsc52Renderer } from "../classic/bootstrap/osc52-renderer.js";
import { attachCommandHandlers } from "../ui-core/commands/command-handlers.js";
import type { RuntimeTerminalOptions } from "./types.js";
import type { RuntimeViewTerminal } from "./view-terminal.js";

export interface RuntimeViewServicesOptions {
  readonly shared: AppServices;
  readonly terminal: RuntimeViewTerminal;
  readonly options: RuntimeTerminalOptions;
  readonly runSession: <T>(method: string, action: () => T) => T;
  readonly minimise: () => boolean;
  readonly switchSession: AppServices["requestSessionSwitch"];
  readonly repaint: () => boolean;
  readonly hasOtherViews: () => boolean;
}

export function createRuntimeViewServices(options: RuntimeViewServicesOptions): AppServices {
  const shared = options.shared;
  const capabilities = detectCapabilities({
    env: options.options.env, stdoutIsTTY: true, stdinIsTTY: true,
    columns: options.terminal.stdout.columns, rows: options.terminal.stdout.rows,
    platform: process.platform,
  });
  const focus = new FocusController();
  const overlay = new OverlayController(focus);
  const toast = new ToastController();
  const interruptible = new InterruptibleController();
  const clipboard = createOsc52ClipboardPort({
    renderer: createOsc52Renderer({ session: { write: (text) => { options.terminal.stdout.write(text); } }, supported: capabilities.osc52, env: options.options.env }),
    fallback: createSystemClipboardPort(), enabled: capabilities.osc52,
  });
  const selection = new SelectionController(clipboard);
  const methods = new Map<PropertyKey, unknown>();
  const session = new Proxy(shared.session, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!methods.has(key)) methods.set(key, (...args: unknown[]) => options.runSession(String(key), () => Reflect.apply(value, target, args)));
      return methods.get(key);
    },
  });
  const transcript = shared.transcript.fork();
  let mirrored = new Map<string, { item: ToastItem; localId: string }>();
  const mirrorToasts = (): void => {
    const latest = shared.toast.getToasts();
    const next = new Map<string, { item: ToastItem; localId: string }>();
    for (const item of latest) {
      const previous = mirrored.get(item.id);
      const localId = previous?.item === item ? previous.localId : toast.show(item.message, { level: item.level, key: `runtime-${item.id}`, durationMs: item.durationMs, sticky: item.sticky });
      next.set(item.id, { item, localId });
    }
    for (const [id, value] of mirrored) if (!next.has(id)) toast.dismiss(value.localId);
    mirrored = next;
  };
  const unsubscribeToasts = shared.toast.subscribe(mirrorToasts);
  mirrorToasts();
  let disposed = false;
  const services: AppServices = {
    ...shared, session, focus, overlay, toast, interruptible, selection,
    router: new ActionRouter(), commands: buildDefaultCommandRegistry(),
    transcript: transcript.transcript,
    ports: { ...shared.ports, clipboard, confirm: createOverlayConfirmPort(overlay), requestSecret: createOverlaySecretPort(overlay) },
    cancel: new CancelCoordinator({ session, sessionId: () => session.sessionId, jobs: shared.ports.jobs, interruptible }),
    requestMinimise: options.minimise, requestSessionSwitch: options.switchSession,
    requestRedraw: options.repaint, hasOtherViews: options.hasOtherViews, capabilities,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeToasts();
      transcript.dispose();
      interruptible.cancelAll();
      overlay.dispose();
      selection.dispose();
      toast.dispose();
    },
  };
  attachCommandHandlers(services);
  return services;
}
