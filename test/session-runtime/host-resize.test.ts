import { describe, expect, it, vi } from "vitest";
import { resizeRuntimeTransport } from "../../src/session-runtime/host.js";

const dimensions = { columns: 132, rows: 47 } as const;

describe("runtime attach resize", () => {
  it("reports success only after the transport accepts the geometry", async () => {
    const resize = vi.fn(async () => undefined);
    expect(await resizeRuntimeTransport({ resize }, dimensions)).toBe(true);
    expect(resize).toHaveBeenCalledWith(dimensions);
    expect(await resizeRuntimeTransport(undefined, dimensions)).toBe(true);
  });

  it("reports a rejected resize so terminal attach cannot acknowledge it", async () => {
    const resize = vi.fn(async () => {
      throw new Error("resize failed");
    });
    expect(await resizeRuntimeTransport({ resize }, dimensions)).toBe(false);
    expect(resize).toHaveBeenCalledOnce();
  });
});
