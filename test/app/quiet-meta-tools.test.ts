import { describe, expect, it } from "vitest";
import {
  isQuietMetaTool,
  shouldHideQuietMetaToolInChat,
} from "../../src/app/adapters/quiet-meta-tools.js";
import { isInternalChatMessage } from "../../src/types.js";

describe("quiet meta tools", () => {
  it("recognizes plan.create and task.update", () => {
    expect(isQuietMetaTool("plan.create")).toBe(true);
    expect(isQuietMetaTool("task.add")).toBe(true);
    expect(isQuietMetaTool("task.read")).toBe(true);
    expect(isQuietMetaTool("task.update")).toBe(true);
    expect(isQuietMetaTool("shell.exec")).toBe(false);
  });

  it("hides plan.create on success, surfaces its failures/blocked", () => {
    expect(shouldHideQuietMetaToolInChat("plan.create", "ok")).toBe(true);
    expect(shouldHideQuietMetaToolInChat("plan.create", "running")).toBe(true);
    expect(shouldHideQuietMetaToolInChat("plan.create", "failed")).toBe(false);
    expect(shouldHideQuietMetaToolInChat("plan.create", "blocked")).toBe(false);
    expect(shouldHideQuietMetaToolInChat("shell.exec", "ok")).toBe(false);
  });

  it("always hides task.* (add/update/read/move) regardless of outcome", () => {
    for (const name of ["task.add", "task.update", "task.read", "task.move"]) {
      expect(shouldHideQuietMetaToolInChat(name, "ok")).toBe(true);
      expect(shouldHideQuietMetaToolInChat(name, "running")).toBe(true);
      expect(shouldHideQuietMetaToolInChat(name, "failed")).toBe(true);
      expect(shouldHideQuietMetaToolInChat(name, "blocked")).toBe(true);
    }
  });

  it("always hides turn.end regardless of outcome", () => {
    expect(isQuietMetaTool("turn.end")).toBe(true);
    for (const status of ["ok", "running", "failed", "blocked"]) {
      expect(shouldHideQuietMetaToolInChat("turn.end", status)).toBe(true);
    }
  });
});

describe("internal chat messages", () => {
  it("hides Plan approved implement directives", () => {
    expect(
      isInternalChatMessage({
        role: "user",
        content:
          "Plan approved. Execute the engagement tasks. Work through pending tasks.",
      }),
    ).toBe(true);
    expect(
      isInternalChatMessage({
        role: "user",
        content: "Plan approved. Execute it. Work through pending tasks.",
      }),
    ).toBe(true);
    expect(
      isInternalChatMessage({
        role: "user",
        content: "please implement the plan for me",
      }),
    ).toBe(false);
  });
});
