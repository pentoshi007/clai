import type { Mode, ProviderId } from "../types.js";
import { createCompositionRoot } from "../ui-core/bootstrap/composition-root.js";
import { RendererLifecycle } from "../ui-core/bootstrap/lifecycle.js";
import { installConsoleGuard } from "../ui-core/bootstrap/console-guard.js";
import { isSuppressedConsoleMessage } from "../ui-core/bootstrap/console-suppress.js";
import { resolveResumeTarget, applyResumeResolution, type ResumeTarget } from "../ui-core/bootstrap/session-resume.js";
import { seedSessionModel } from "../store/session-model.js";
import { getLogsDirRoot } from "../store/paths.js";
import { setAllowInteractiveStdinInherit } from "../tools/shell.js";
import { createRuntimeChildBridge } from "./child-bridge.js";
import { bindRuntimeChildBridge } from "./binding.js";
import { RuntimeViewManager } from "./view-manager.js";
import { runFreebuffSessionShutdownCleanup } from "../llm/freebuff-session.js";

export interface IndependentRuntimeOptions {
  readonly mode?: Mode | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly modelExplicit?: boolean | undefined;
  readonly noHistory?: boolean | undefined;
  readonly sessionId?: string | undefined;
  readonly resume?: ResumeTarget | undefined;
}

export async function startIndependentRuntime(options: IndependentRuntimeOptions): Promise<void> {
  const bridge = createRuntimeChildBridge(false, true);
  if (!bridge) throw new Error("independent session runtime is unavailable");
  setAllowInteractiveStdinInherit(false);
  const manager = new RuntimeViewManager(bridge);
  let lifecycle: RendererLifecycle | undefined;
  const seeded = await seedSessionModel(options.sessionId, {
    provider: options.provider, model: options.model, modelExplicit: options.modelExplicit === true,
    inheritLastUsed: options.resume === undefined, freeCatalogFallback: options.resume === undefined,
  });
  const services = createCompositionRoot({
    ...seeded, mode: options.mode, noHistory: options.noHistory, sessionId: options.sessionId,
    confirm: manager.confirm, requestSecret: manager.requestSecret,
    interactiveOverlay: () => manager.current()?.overlay,
    requestOAuthConsent: (info) => manager.ask((view) => view.overlay.openConfirm({
      kind: "mcp-oauth",
      prompt: [info.message ?? "Authorize MCP access?", `Server: ${info.serverUrl}`, info.issuer ? `Issuer: ${info.issuer}` : undefined, info.scope ? `Scope: ${info.scope}` : undefined].filter(Boolean).join("\n"),
    }), false),
    requestExit: () => { void lifecycle?.shutdownAndExit(0); },
  });
  manager.bind(services);
  const restoreConsole = installConsoleGuard({ logDir: getLogsDirRoot(), onCapture: (level, message) => {
    if ((level === "error" || level === "warn") && !isSuppressedConsoleMessage(message)) services.session.notice("warn", message.split("\n")[0]!.slice(0, 200));
  } });
  bridge.setViewHandler((frame) => manager.receive(frame));
  let unbind = (): void => bridge.dispose();
  lifecycle = new RendererLifecycle({
    handle: { start() {}, async destroy() { await manager.dispose(); services.dispose(); } },
    disposers: [
      () => unbind(),
      () => services.session.persistNow().catch(() => undefined),
      () => services.omnirushSessionUpload.close(),
      restoreConsole,
      () => services.mcp.closeAll().catch(() => undefined),
      () => services.ports.interactiveSessions.closeAll("app-shutdown").then(() => undefined),
      () => manager.dispose(),
    ],
    epilogue: () => runFreebuffSessionShutdownCleanup(),
    onSigint: () => services.session.abort(),
    onError: (error) => { console.error(error instanceof Error ? error.message : String(error)); },
  });
  try {
    const resolution = options.resume ? await resolveResumeTarget(options.resume) : undefined;
    await applyResumeResolution(services, resolution);
    await lifecycle.start();
    unbind = bindRuntimeChildBridge(bridge, services, () => { void lifecycle?.shutdownAndExit(0); });
    if (!await bridge.connect()) throw new Error("could not connect independent session runtime");
  } catch (error) {
    await lifecycle.shutdown();
    throw error;
  }
}
