import type { SessionState } from "../app/controllers/session-controller.js";
import type { AppServices } from "../ui-core/bootstrap/composition-root.js";
import { safeCwd } from "../os/cwd.js";
import type { RuntimeChildBridge } from "./child-bridge.js";

export function runtimeSessionBusy(state: SessionState): boolean {
  return (
    state.running ||
    state.compacting ||
    state.queued.length > 0 ||
    state.responder.running > 0 ||
    state.responder.ready > 0 ||
    state.responder.delivered > 0
  );
}

export function bindRuntimeChildBridge(
  bridge: RuntimeChildBridge,
  services: AppServices,
  requestExit: () => void,
): () => void {
  bridge.setShutdownHandler(requestExit);
  const report = (): void => {
    const state = services.session.getState();
    bridge.report({
      sessionId: state.sessionId,
      cwd: safeCwd(),
      busy: runtimeSessionBusy(state),
      ...(state.title ? { title: state.title } : {}),
    });
  };
  const unsubscribe = services.session.subscribe(report);
  report();
  return () => {
    unsubscribe();
    bridge.dispose();
  };
}
