import { describe, expect, it, vi } from "vitest";
import { createUsagePagerSource } from "../../src/ui-core/rendering/usage-pager-source.js";

function setup(bodies: string[]) {
  const listeners = new Set<() => void>();
  let index = 0;
  const renderBody = vi.fn(() => bodies[Math.min(index, bodies.length - 1)]!);
  const source = createUsagePagerSource({
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    renderBody,
  });
  const emit = (): void => {
    index = Math.min(index + 1, bodies.length - 1);
    for (const listener of [...listeners]) listener();
  };
  return { source, emit, renderBody };
}

describe("createUsagePagerSource", () => {
  it("exposes the initial body as a single live page", async () => {
    const { source } = setup(["# Session usage\n\nfirst"]);
    const page = await source.readPage(0);
    expect(page.body).toBe("# Session usage\n\nfirst");
    expect(page.pageCount).toBe(1);
    expect(page.totalBytes).toBeGreaterThan(0);
    await expect(source.readTail()).resolves.toEqual(
      await source.readPage(0),
    );
    await expect(source.readAll()).resolves.toBe("# Session usage\n\nfirst");
    await expect(source.isGrowing?.()).toBe(true);
  });

  it("notifies watchers only when the rendered body changes", async () => {
    const { source, emit } = setup(["first", "first", "second"]);
    const onChange = vi.fn();
    const unwatch = source.watch!(onChange);
    emit();
    expect(onChange).not.toHaveBeenCalled();
    emit();
    expect(onChange).toHaveBeenCalledTimes(1);
    await expect(source.readAll()).resolves.toBe("second");
    unwatch();
    emit();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("serves fresh pages from the latest body after a change", async () => {
    const { source, emit } = setup(["first body", "second body"]);
    emit();
    const page = await source.readPage(0);
    expect(page.body).toBe("second body");
    const hit = await source.search("second");
    expect(hit?.body).toContain("second body");
    await expect(source.search("missing")).resolves.toBeUndefined();
  });

  it("stops notifying and rejects reads after dispose", async () => {
    const { source, emit } = setup(["first", "second", "third"]);
    const onChange = vi.fn();
    source.watch!(onChange);
    source.dispose();
    emit();
    expect(onChange).not.toHaveBeenCalled();
    await expect(source.readPage(0)).rejects.toThrow(
      "usage pager source is disposed",
    );
    await expect(source.readAll()).rejects.toThrow(
      "usage pager source is disposed",
    );
  });

  it("keeps watch callbacks independent per subscriber", () => {
    const { source, emit } = setup(["first", "second"]);
    const first = vi.fn();
    const second = vi.fn();
    const unwatchFirst = source.watch!(first);
    source.watch!(second);
    unwatchFirst();
    emit();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
