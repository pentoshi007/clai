import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ToastController,
  toastTotalLifetimeMs,
} from "../../../src/ui-core/controllers/toast-controller.js";

const UPDATE_KEY = "update";

afterEach(() => {
  vi.useRealTimers();
});

describe("keyed toast updates during /update", () => {
  it("keeps one chip with a stable id and createdAt while progress streams", async () => {
    vi.useFakeTimers();
    const toast = new ToastController();

    toast.info("v4.5.0 → v4.6.1 · downloading…", {
      key: UPDATE_KEY,
      sticky: true,
    });
    const first = toast.getToasts()[0]!;

    for (const received of [12, 34, 56, 78]) {
      await vi.advanceTimersByTimeAsync(120);
      toast.info(`v4.5.0 → v4.6.1 · downloading ${received}MB/78MB`, {
        key: UPDATE_KEY,
        sticky: true,
      });
    }

    expect(toast.getToasts()).toHaveLength(1);
    const latest = toast.getToasts()[0]!;
    expect(latest.id).toBe(first.id);
    expect(latest.createdAt).toBe(first.createdAt);
    expect(latest.message).toContain("78MB/78MB");
    toast.dispose();
  });

  it("holds its stack position when other toasts arrive alongside it", () => {
    vi.useFakeTimers();
    const toast = new ToastController();

    toast.info("downloading…", { key: UPDATE_KEY, sticky: true });
    toast.success("new version available", { key: "update-found" });
    const before = toast.getToasts().findIndex((t) => t.key === UPDATE_KEY);

    toast.info("installing v4.6.1…", { key: UPDATE_KEY, sticky: true });

    const after = toast.getToasts().findIndex((t) => t.key === UPDATE_KEY);
    expect(after).toBe(before);
    expect(toast.getToasts()).toHaveLength(2);
    toast.dispose();
  });

  it("restarts the hold clock when a sticky chip settles so the result stays readable", async () => {
    vi.useFakeTimers();
    const toast = new ToastController();

    toast.info("installing v4.6.1…", { key: UPDATE_KEY, sticky: true });
    await vi.advanceTimersByTimeAsync(60_000);

    const holdMs = 6000;
    toast.success("updated to v4.6.1 · restart clai", {
      key: UPDATE_KEY,
      durationMs: holdMs,
    });
    const settled = toast.getToasts()[0]!;
    expect(settled.sticky).toBeUndefined();
    expect(settled.createdAt).toBe(Date.now());

    await vi.advanceTimersByTimeAsync(toastTotalLifetimeMs(holdMs) - 1);
    expect(toast.getToasts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(toast.getToasts()).toHaveLength(0);
    toast.dispose();
  });

  it("does not leave a sticky chip on screen forever once it settles", async () => {
    vi.useFakeTimers();
    const toast = new ToastController();

    toast.info("downloading…", { key: UPDATE_KEY, sticky: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(toast.getToasts()).toHaveLength(1);

    toast.error("update failed", { key: UPDATE_KEY, durationMs: 6000 });
    await vi.advanceTimersByTimeAsync(toastTotalLifetimeMs(6000) + 1);
    expect(toast.getToasts()).toHaveLength(0);
    toast.dispose();
  });
});
