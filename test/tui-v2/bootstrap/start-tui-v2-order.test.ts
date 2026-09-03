import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/tui-v2/bootstrap/start-tui-v2.ts", "utf8");

describe("OpenTUI resume bootstrap order", () => {
  it("paints a loading screen before the slow resume load and resyncs after mount", () => {
    const guard = source.indexOf("installConsoleGuard({");
    const renderer = source.indexOf("await createCliRenderer({");
    const loading = source.indexOf("Loading session…");
    const resolve = source.indexOf("await resolveResumeTarget(options.resume)");
    const hydrate = source.indexOf("await applyResumeResolution(services, pendingResume)");
    const mount = source.indexOf("createElement(App)");
    const start = source.indexOf("await lifecycle.start()");
    const resync = source.indexOf("repaintAttachedScreen({", start);

    expect(guard).toBeGreaterThanOrEqual(0);
    expect(renderer).toBeGreaterThan(guard);
    expect(loading).toBeGreaterThan(renderer);
    expect(resolve).toBeGreaterThan(loading);
    expect(hydrate).toBeGreaterThan(resolve);
    expect(mount).toBeGreaterThan(hydrate);
    expect(start).toBeGreaterThan(mount);
    expect(resync).toBeGreaterThan(start);
    expect(source.slice(start)).not.toContain(
      "await applyResumeResolution(services, pendingResume)",
    );
  });
});
