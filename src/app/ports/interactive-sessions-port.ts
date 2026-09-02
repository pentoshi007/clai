
import type {
  CloseAllResult,
  CloseOwnerResult,
  TerminationReason,
} from "../../interactive-session/types.js";

export type { CloseAllResult, CloseOwnerResult };

export interface InteractiveSessionsPort {
  activateOwner(ownerId: string): Promise<void>;
  cancelOwner(ownerId: string): Promise<CloseOwnerResult>;
  beginCloseOwner(
    ownerId: string,
    reason?: Extract<TerminationReason, "conversation-teardown">,
  ): Promise<CloseOwnerResult>;
  awaitOwnerClose(ownerId: string): Promise<void>;
  closeAll(reason?: Extract<TerminationReason, "app-shutdown">): Promise<CloseAllResult>;
}
