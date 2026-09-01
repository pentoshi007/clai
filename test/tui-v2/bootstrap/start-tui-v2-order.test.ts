import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/tui-v2/bootstrap/start-tui-v2.ts", "utf8");

describe("OpenTUI resume bootstrap order", () => {
  it("hydrates the resolved session before creating or mounting the React root", () => {
    const resolve = source.indexOf("await resolveResumeTarget(options.resume)");
    const hydrate = source.indexOf("await applyResumeResolution(services, pendingResume)");
    const create = source.indexOf("const root = createRoot(renderer)");
    const start = source.indexOf("await lifecycle.start()");

    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(hydrate).toBeGreaterThan(resolve);
    expect(create).toBeGreaterThan(hydrate);
    expect(start).toBeGreaterThan(create);
    expect(source.slice(start)).not.toContain(
      "await applyResumeResolution(services, pendingResume)",
    );
  });
});
