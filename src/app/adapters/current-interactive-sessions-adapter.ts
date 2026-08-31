import {
  interactiveSessionManager,
  type InteractiveSessionManager,
} from "../../interactive-session/manager.js";
import type { InteractiveSessionsPort } from "../ports/interactive-sessions-port.js";

export function createCurrentInteractiveSessionsPort(
  manager: InteractiveSessionManager = interactiveSessionManager,
): InteractiveSessionsPort {
  return {
    activateOwner: (ownerId) => manager.activateOwner(ownerId),
    cancelOwner: (ownerId) => manager.cancelOwner(ownerId),
    beginCloseOwner: (ownerId, reason) =>
      manager.beginCloseOwner(ownerId, reason ?? "conversation-teardown"),
    awaitOwnerClose: (ownerId) => manager.awaitOwnerClose(ownerId),
    closeAll: (reason) => manager.closeAll(reason ?? "app-shutdown"),
  };
}
