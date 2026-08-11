import { describe, expect, it } from "vitest";
import { decideCommit } from "../../../src/classic/feed/commit-ledger.js";
import type { FeedBlock } from "../../../src/classic/feed/feed-blocks.js";

function block(
  id: string,
  rows: number,
  options: { open?: boolean; turnId?: string | undefined } = {},
): FeedBlock {
  return {
    key: `0:${id}`,
    itemId: id,
    kind: "assistant",
    open: options.open ?? false,
    lines: Array.from({ length: rows }, (_, i) => `${id}-${i}`),
    turnId: options.turnId,
    sequence: Number(id.replace(/\D/g, "")) || 0,
  };
}

describe("rule 1 — monotonic", () => {
  it("never returns a committedCount below the previous one", () => {
    const blocks = [block("a", 1), block("b", 1), block("c", 1)];
    const decision = decideCommit({
      blocks,
      liveBudgetRows: 100,
      committedCount: 2,
      turnBoundary: false,
    });
    expect(decision.committedCount).toBe(2);
    expect(decision.committed.map((b) => b.itemId)).toEqual(["a", "b"]);
    expect(decision.live.map((b) => b.itemId)).toEqual(["c"]);
  });

  it("clamps a stale committedCount to the available blocks", () => {
    const decision = decideCommit({
      blocks: [block("a", 1)],
      liveBudgetRows: 10,
      committedCount: 9,
      turnBoundary: false,
    });
    expect(decision.committedCount).toBe(1);
    expect(decision.live).toHaveLength(0);
  });

  it("is idempotent when replayed with its own output", () => {
    const blocks = [block("a", 4), block("b", 4), block("c", 4)];
    const first = decideCommit({ blocks, liveBudgetRows: 5, committedCount: 0, turnBoundary: false });
    const second = decideCommit({
      blocks,
      liveBudgetRows: 5,
      committedCount: first.committedCount,
      turnBoundary: false,
    });
    expect(second.committedCount).toBe(first.committedCount);
  });
});

describe("rule 2 — whole blocks only", () => {
  it("splits at a block boundary and preserves every line", () => {
    const blocks = [block("a", 3), block("b", 3), block("c", 3)];
    const decision = decideCommit({ blocks, liveBudgetRows: 4, committedCount: 0, turnBoundary: false });
    expect([...decision.committed, ...decision.live]).toEqual(blocks);
    for (const b of [...decision.committed, ...decision.live]) {
      expect(b.lines).toHaveLength(3);
    }
  });
});

describe("rule 3 — commit triggers", () => {
  it("commits older blocks on budget overflow, walking back from the newest", () => {
    const blocks = [block("a", 3), block("b", 3), block("c", 3)];
    const decision = decideCommit({ blocks, liveBudgetRows: 7, committedCount: 0, turnBoundary: false });
    expect(decision.live.map((b) => b.itemId)).toEqual(["b", "c"]);
    expect(decision.committed.map((b) => b.itemId)).toEqual(["a"]);
  });

  it("commits every block from a previous turn on a turn boundary", () => {
    const blocks = [
      block("a", 1, { turnId: "t1" }),
      block("b", 1, { turnId: "t1" }),
      block("c", 1, { turnId: "t2" }),
    ];
    const decision = decideCommit({
      blocks,
      liveBudgetRows: 100,
      committedCount: 0,
      turnBoundary: true,
      currentTurnId: "t2",
    });
    expect(decision.committed.map((b) => b.itemId)).toEqual(["a", "b"]);
    expect(decision.live.map((b) => b.itemId)).toEqual(["c"]);
  });

  it("commits a closed block that alone exceeds the live budget", () => {
    const blocks = [block("a", 1), block("tall", 40)];
    const decision = decideCommit({ blocks, liveBudgetRows: 8, committedCount: 0, turnBoundary: false });
    expect(decision.committedCount).toBe(2);
    expect(decision.live).toHaveLength(0);
  });
});

describe("rule 4 — open blocks are never committed", () => {
  it("keeps an open block live even when it exceeds the budget", () => {
    const blocks = [block("a", 2), block("open", 60, { open: true })];
    const decision = decideCommit({ blocks, liveBudgetRows: 8, committedCount: 0, turnBoundary: false });
    expect(decision.live.map((b) => b.itemId)).toEqual(["open"]);
    expect(decision.committed.map((b) => b.itemId)).toEqual(["a"]);
  });

  it("does not commit past the oldest open block on a turn boundary", () => {
    const blocks = [
      block("a", 1, { turnId: "t1" }),
      block("open", 1, { open: true, turnId: "t1" }),
      block("c", 1, { turnId: "t1" }),
    ];
    const decision = decideCommit({
      blocks,
      liveBudgetRows: 100,
      committedCount: 0,
      turnBoundary: true,
      currentTurnId: "t2",
    });
    expect(decision.committed.map((b) => b.itemId)).toEqual(["a"]);
    expect(decision.live.map((b) => b.itemId)).toEqual(["open", "c"]);
  });

  it("commits the block in full once it closes", () => {
    const blocks = [block("a", 2), block("x", 6, { open: true })];
    const open = decideCommit({ blocks, liveBudgetRows: 4, committedCount: 0, turnBoundary: false });
    expect(open.live.map((b) => b.itemId)).toEqual(["x"]);
    const closed = decideCommit({
      blocks: [blocks[0]!, { ...blocks[1]!, open: false }],
      liveBudgetRows: 4,
      committedCount: open.committedCount,
      turnBoundary: false,
    });
    expect(closed.committedCount).toBe(2);
    expect(closed.committed[1]!.lines).toHaveLength(6);
  });
});

describe("degenerate inputs", () => {
  it("commits everything at a zero budget", () => {
    const blocks = [block("a", 1), block("b", 1)];
    const decision = decideCommit({ blocks, liveBudgetRows: 0, committedCount: 0, turnBoundary: false });
    expect(decision.committedCount).toBe(2);
  });

  it("handles an empty block list", () => {
    const decision = decideCommit({ blocks: [], liveBudgetRows: 10, committedCount: 0, turnBoundary: true });
    expect(decision).toEqual({ committed: [], live: [], committedCount: 0 });
  });
});
