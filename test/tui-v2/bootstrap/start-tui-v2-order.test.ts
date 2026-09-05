import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/tui-v2/bootstrap/start-tui-v2.ts", "utf8");

describe("OpenTUI resume bootstrap order", () => {
  it("paints a loading screen before the slow resume load without an extra startup clear", () => {
    const guard = source.indexOf("installConsoleGuard({");
    const renderer = source.indexOf("await createCliRenderer({");
    const loading = source.indexOf("Loading session…");
    const resolve = source.indexOf("await resolveResumeTarget(options.resume)");
    const hydrate = source.indexOf("await applyResumeResolution(services, pendingResume)");
    const mount = source.indexOf("createElement(App)");
    const start = source.indexOf("await lifecycle.start()");

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(renderer).toBeGreaterThan(guard);
    expect(loading).toBeGreaterThan(renderer);
    expect(resolve).toBeGreaterThan(loading);
    expect(hydrate).toBeGreaterThan(resolve);
    expect(mount).toBeGreaterThan(hydrate);
    expect(start).toBeGreaterThan(mount);
    expect(source.indexOf("repaintAttachedScreen({", start)).toBe(-1);
    expect(source.slice(start)).not.toContain(
      "await applyResumeResolution(services, pendingResume)",
    );
  });

  it("installs a usable repaint handler before connecting or awaiting loading work", () => {
    const loading = source.indexOf("Loading session…");
    const handler = source.indexOf("const requestRepaint =");
    const bridge = source.indexOf("createRuntimeChildBridge(true)");
    const register = source.indexOf("runtimeBridge?.setRepaintHandler(requestRepaint)");
    const connect = source.indexOf("await runtimeBridge.connect()");
    const theme = source.indexOf("await renderer.waitForThemeMode(");
    const seed = source.indexOf("await seedSessionModel(");
    const resolve = source.indexOf("await resolveResumeTarget(");
    const hydrate = source.indexOf("await applyResumeResolution(");

    expect(handler).toBeGreaterThan(loading);
    expect(bridge).toBeGreaterThan(handler);
    expect(register).toBeGreaterThan(bridge);
    expect(source.slice(loading, register)).not.toMatch(/\bawait\b/);
    for (const wait of [connect, theme, seed, resolve, hydrate]) {
      expect(wait).toBeGreaterThan(register);
    }
    expect(source.slice(handler, bridge)).toContain("repaintAttachedScreen({");
    const binding = source.slice(source.indexOf("disposeRuntimeBridge = bindRuntimeChildBridge("));
    expect(binding).toContain("requestRepaint,");
  });
});
