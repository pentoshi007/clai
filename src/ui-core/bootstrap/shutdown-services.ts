import type { AppServices } from "./composition-root.js";

export async function shutdownServices(services: AppServices): Promise<void> {
  services.overlay.cancelBlockingPrompt();
  const results = await Promise.allSettled([
    services.session.shutdown(),
    services.mcp.closeAll(),
    services.ports.interactiveSessions.closeAll("app-shutdown").then((result) => {
      for (const failure of result.failures) {
        console.warn(`clai interactive-session cleanup: [${failure.code}] ${failure.message}`);
      }
    }),
  ]);
  const persistence = results[0];
  if (persistence?.status === "rejected") throw persistence.reason;
  await services.omnirushSessionUpload.close();
}
