import { describe, expect, it } from "vitest";
import { createHarness, job } from "./harness.js";

describe("pager over confirm", () => {
  it("previews a delete without resolving and restores the confirm", async () => {
    const harness = createHarness();
    let resolved: boolean | undefined;
    const answer = harness.overlay
      .openConfirm({ kind: "tool", prompt: "DELETE?", viewPath: "/tmp/x" }, undefined, () => {
        harness.overlay.openPager("Preview · /tmp/x", "file body");
      })
      .then((value) => {
        resolved = value;
        return value;
      });

    harness.press("v");
    expect(harness.overlay.getState().kind).toBe("pager");
    expect(harness.focus.activeContext()).toBe("pager");
    expect(resolved).toBeUndefined();

    harness.press("q");
    expect(harness.overlay.getState().kind).toBe("confirm");
    expect(harness.focus.activeContext()).toBe("modal");
    expect(resolved).toBeUndefined();

    harness.press("y");
    await expect(answer).resolves.toBe(true);
    expect(harness.overlay.isOpen()).toBe(false);
    expect(harness.focus.activeContext()).toBe("composer");
  });

  it("shows plan detail without resolving the plan confirm", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openPlanConfirm({ kind: "plan", prompt: "8 tasks" }, () => {
      harness.overlay.openPager("Plan", "plan detail", undefined, undefined, "force");
    });

    harness.press("p");
    expect(harness.overlay.getState().kind).toBe("pager");
    harness.overlay.close();
    expect(harness.overlay.getState().kind).toBe("confirm");
    harness.press("s");
    await expect(answer).resolves.toBe("suggest");
  });

  it("answers the confirm underneath when the pager is still stacked", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openConfirm(
      { kind: "tool", prompt: "DELETE?", viewPath: "/tmp/x" },
      undefined,
      () => {
        harness.overlay.openPager("Preview", "body");
      },
    );
    harness.press("v");
    harness.overlay.answerConfirm(false);
    await expect(answer).resolves.toBe(false);
    expect(harness.overlay.isOpen()).toBe(false);
  });
});

describe("pager over jobs", () => {
  it("restores the job list when the tail closes", () => {
    const harness = createHarness();
    harness.jobs = [job({ id: "j1", status: "running" })];
    harness.overlay.openJobs();
    expect(harness.focus.activeContext()).toBe("jobs");

    harness.press("t");
    expect(harness.overlay.getState().kind).toBe("pager");
    expect(harness.focus.activeContext()).toBe("pager");

    harness.press("q");
    expect(harness.overlay.getState().kind).toBe("jobs");
    expect(harness.focus.activeContext()).toBe("jobs");
    expect(harness.panels.getSnapshot().jobs.cursor).toBe(0);
  });

  it("keeps the pager state per open, not across opens", () => {
    const harness = createHarness();
    harness.overlay.openPager("one", "a\nb\nc\nd\ne\nf\ng\nh");
    harness.press("j");
    harness.press("j");
    expect(harness.panels.getSnapshot().pager.caret).toBe(2);
    harness.overlay.close();
    harness.overlay.openPager("two", "x\ny");
    expect(harness.panels.getSnapshot().pager.caret).toBe(0);
    expect(harness.panels.getSnapshot().pagerBody).toBe("x\ny");
  });
});

describe("single blocking overlay", () => {
  it("refuses a second modal instead of stacking it", async () => {
    const harness = createHarness();
    const first = harness.overlay.openConfirm({ kind: "tool", prompt: "one" });
    const second = harness.overlay.openConfirm({ kind: "tool", prompt: "two" });
    await expect(second).resolves.toBe(false);
    harness.press("y");
    await expect(first).resolves.toBe(true);
  });

  it("routes keys to the topmost overlay only", () => {
    const harness = createHarness();
    void harness.overlay.openConfirm({ kind: "tool", prompt: "DELETE?", viewPath: "/x" }, undefined, () => {
      harness.overlay.openPager("Preview", "a\nb\nc");
    });
    harness.press("v");
    expect(harness.press("j")).toBe(true);
    expect(harness.panels.getSnapshot().pager.caret).toBe(1);
  });
});

describe("pager over operation review", () => {
  it("scrolls the review and returns to the pending confirm unchanged", async () => {
    const harness = createHarness({ rows: 14 });
    let resolved: boolean | undefined;
    const answer = harness.overlay
      .openConfirm({
        kind: "tool",
        prompt: "Run command?",
        review: {
          title: "Review operation",
          body: Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n"),
        },
      })
      .then((value) => {
        resolved = value;
        return value;
      });

    expect(harness.press("ctrl+o")).toBe(true);
    expect(harness.overlay.getState().kind).toBe("pager");
    expect(harness.focus.activeContext()).toBe("pager");
    harness.press("j");
    harness.press("j");
    expect(harness.panels.getSnapshot().pager.caret).toBe(2);
    expect(resolved).toBeUndefined();

    harness.press("q");
    expect(harness.overlay.getState().kind).toBe("confirm");
    expect(harness.focus.activeContext()).toBe("modal");
    expect(resolved).toBeUndefined();

    harness.press("y");
    await expect(answer).resolves.toBe(true);
    expect(harness.overlay.isOpen()).toBe(false);
  });

  it("keeps a typed sudo password while the review pager is opened from the secret prompt", async () => {
    const harness = createHarness();
    const answer = harness.overlay.openSecret({
      title: "Administrator access",
      prompt: "sudo password",
      review: { title: "Review operation", body: "sudo complete command" },
    });

    harness.press("h", "h");
    harness.press("u", "u");
    expect(harness.press("ctrl+o")).toBe(true);
    expect(harness.overlay.getState().kind).toBe("pager");
    expect(harness.focus.activeContext()).toBe("pager");
    harness.press("q");
    expect(harness.focus.activeContext()).toBe("secret");
    harness.press("enter");
    await expect(answer).resolves.toBe("hu");
  });
});
