import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOAST_DURATION_MS,
  ToastController,
  toastTotalLifetimeMs,
} from "../../../src/tui-v2/controllers/toast-controller.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastController", () => {
  it("shows a toast and auto-dismisses after enter+hold+exit", async () => {
    vi.useFakeTimers();
    const toast = new ToastController();
    const seen: number[] = [];
    toast.subscribe(() => seen.push(toast.getToasts().length));

    const holdMs = 2000;
    toast.show("Copied to clipboard", { level: "success", durationMs: holdMs });
    expect(toast.getToasts()).toHaveLength(1);
    expect(toast.getToasts()[0]?.message).toBe("Copied to clipboard");
    expect(toast.getToasts()[0]?.level).toBe("success");

    // Still visible during hold (and enter/exit budget).
    await vi.advanceTimersByTimeAsync(toastTotalLifetimeMs(holdMs) - 1);
    expect(toast.getToasts()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2);
    expect(toast.getToasts()).toHaveLength(0);
    expect(seen.at(-1)).toBe(0);
    toast.dispose();
  });

  it("caps the stack and dismisses by id", () => {
    vi.useFakeTimers();
    const toast = new ToastController();
    for (let i = 0; i < 6; i += 1) toast.show(`msg ${i}`, { durationMs: 5000 });
    expect(toast.getToasts()).toHaveLength(3);
    expect(toast.getToasts()[0]?.message).toBe("msg 3");

    const id = toast.getToasts()[1]!.id;
    toast.dismiss(id);
    expect(toast.getToasts().some((t) => t.id === id)).toBe(false);
    toast.dispose();
  });

  it("replaces toasts that share a key", () => {
    vi.useFakeTimers();
    const toast = new ToastController();
    toast.show("Thinking expanded", { key: "thinking", durationMs: 5000 });
    toast.show("Thinking collapsed", { key: "thinking", durationMs: 5000 });
    expect(toast.getToasts()).toHaveLength(1);
    expect(toast.getToasts()[0]?.message).toBe("Thinking collapsed");
    toast.dispose();
  });

  it("supports convenience level helpers", () => {
    const toast = new ToastController();
    toast.success("ok");
    toast.warn("careful");
    toast.error("bad");
    const levels = toast.getToasts().map((t) => t.level);
    expect(levels).toEqual(["success", "warn", "error"]);
    toast.dispose();
  });

  it("ignores empty messages", () => {
    const toast = new ToastController();
    expect(toast.show("   ")).toBe("");
    expect(toast.getToasts()).toHaveLength(0);
    toast.dispose();
  });

  it("defaults to a 3.5s hold", () => {
    expect(DEFAULT_TOAST_DURATION_MS).toBe(3500);
    const toast = new ToastController();
    toast.show("plain");
    expect(toast.getToasts()[0]?.durationMs).toBe(3500);
    toast.dispose();
  });

  it("sticky toasts never auto-dismiss and leave by explicit dismiss", async () => {
    vi.useFakeTimers();
    const toast = new ToastController();
    const id = toast.info("fetching provider models…", {
      key: "model-fetch",
      sticky: true,
    });
    expect(id).not.toBe("");
    expect(toast.getToasts()[0]?.sticky).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(toast.getToasts()).toHaveLength(1);
    toast.dismiss(id);
    expect(toast.getToasts()).toHaveLength(0);
    toast.dispose();
  });

  it("a same-key show replaces a sticky toast", () => {
    vi.useFakeTimers();
    const toast = new ToastController();
    toast.info("fetching provider models…", { key: "model-fetch", sticky: true });
    toast.success("provider · 42 models (live)", { key: "model-fetch" });
    expect(toast.getToasts()).toHaveLength(1);
    expect(toast.getToasts()[0]?.message).toBe("provider · 42 models (live)");
    expect(toast.getToasts()[0]?.sticky).toBeUndefined();
    toast.dispose();
  });
});
