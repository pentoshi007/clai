import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastController } from "../../../src/tui-v2/controllers/toast-controller.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastController", () => {
  it("shows a toast and auto-dismisses after the duration", async () => {
    vi.useFakeTimers();
    const toast = new ToastController();
    const seen: number[] = [];
    toast.subscribe(() => seen.push(toast.getToasts().length));

    toast.show("Copied to clipboard", { level: "success", durationMs: 2000 });
    expect(toast.getToasts()).toHaveLength(1);
    expect(toast.getToasts()[0]?.message).toBe("Copied to clipboard");
    expect(toast.getToasts()[0]?.level).toBe("success");

    await vi.advanceTimersByTimeAsync(1999);
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
    expect(toast.getToasts()).toHaveLength(4);
    expect(toast.getToasts()[0]?.message).toBe("msg 2");

    const id = toast.getToasts()[1]!.id;
    toast.dismiss(id);
    expect(toast.getToasts().some((t) => t.id === id)).toBe(false);
    toast.dispose();
  });

  it("ignores empty messages", () => {
    const toast = new ToastController();
    expect(toast.show("   ")).toBe("");
    expect(toast.getToasts()).toHaveLength(0);
    toast.dispose();
  });
});
