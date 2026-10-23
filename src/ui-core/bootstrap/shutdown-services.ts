import type { AppServices } from "./composition-root.js";
import { settleWithin } from "../../os/settle-within.js";
import { repairClaiOwnership } from "../../store/ownership.js";

export const SHUTDOWN_CLEANUP_BUDGET_MS = 2_500;

export async function shutdownServices(
  services: AppServices,
  cleanupBudgetMs = SHUTDOWN_CLEANUP_BUDGET_MS,
): Promise<void> {
  services.overlay.cancelBlockingPrompt();
  const deadline = Date.now() + cleanupBudgetMs;
  const cleanup = Promise.allSettled([
    services.cancel.cancelAll(),
    services.mcp.closeAll(),
    services.ports.interactiveSessions.closeAll("app-shutdown").then((result) => {
      for (const failure of result.failures) {
        console.warn(`clai interactive-session cleanup: [${failure.code}] ${failure.message}`);
      }
    }),
  ]);
  try {
    await services.session.shutdown();
  } finally {
    const upload = services.omnirushSessionUpload.close();
    const ownership = repairClaiOwnership(Math.max(0, deadline - Date.now()));
    await settleWithin(Promise.allSettled([cleanup, upload, ownership]), deadline - Date.now());
  }
}
