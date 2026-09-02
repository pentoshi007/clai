import { beforeEach, describe, expect, it, vi } from "vitest";

const conflict = vi.fn();
const resolveTarget = vi.fn();
const materialized = vi.fn();

vi.mock("../../src/agent/workspace-orient.js", () => ({
  scaffoldTargetConflictMessage: (...args: unknown[]) => conflict(...args),
  resolveScaffoldTargetPath: (...args: unknown[]) => resolveTarget(...args),
  scaffoldLooksMaterialized: (...args: unknown[]) => materialized(...args),
}));

const { decideScaffoldPreflight } = await import(
  "../../src/agent/turn/scaffold-preflight.js"
);

const scaffoldCommand = "npm create vite@latest app -- --template react";

beforeEach(() => {
  conflict.mockReset();
  resolveTarget.mockReset();
  materialized.mockReset();
});

describe("scaffold preflight", () => {
  it("ignores tools that are not shell launches", () => {
    expect(
      decideScaffoldPreflight({
        name: "fs.write",
        args: { command: scaffoldCommand },
      }).skip,
    ).toBe(false);
    expect(conflict).not.toHaveBeenCalled();
  });

  it("ignores non-scaffold commands", () => {
    expect(
      decideScaffoldPreflight({ name: "shell.exec", args: { command: "ls" } })
        .skip,
    ).toBe(false);
    expect(conflict).not.toHaveBeenCalled();
  });

  it("ignores a missing command argument", () => {
    expect(decideScaffoldPreflight({ name: "shell.start", args: {} }).skip).toBe(
      false,
    );
  });

  it("proceeds when the target has no conflict", () => {
    conflict.mockReturnValue(undefined);
    expect(
      decideScaffoldPreflight({
        name: "shell.exec",
        args: { command: scaffoldCommand, cwd: "/work" },
      }).skip,
    ).toBe(false);
    expect(conflict).toHaveBeenCalledWith(scaffoldCommand, "/work");
  });

  it("adopts a materialized target and tells the model to continue it", () => {
    conflict.mockReturnValue("target not empty");
    resolveTarget.mockReturnValue("/work/app");
    materialized.mockReturnValue(true);
    const decision = decideScaffoldPreflight({
      name: "shell.exec",
      args: { command: scaffoldCommand },
    });
    expect(decision).toEqual({
      skip: true,
      target: "/work/app",
      adoptTarget: true,
      message:
        "Scaffold skipped: the target already contains a usable project at /work/app. Continue that project directly; do not re-run the scaffolder.",
    });
  });

  it("refuses to retry into an incomplete target without adopting it", () => {
    conflict.mockReturnValue("target not empty");
    resolveTarget.mockReturnValue("/work/app");
    materialized.mockReturnValue(false);
    const decision = decideScaffoldPreflight({
      name: "shell.start",
      args: { command: scaffoldCommand },
    });
    expect(decision.skip).toBe(true);
    expect(decision.adoptTarget).toBe(false);
    expect(decision.message).toBe(
      "Scaffold was not run: the existing target at /work/app is incomplete. Inspect and repair it before completing the scaffold task; do not retry the scaffolder into this non-empty directory.",
    );
  });

  it("omits the location when the target cannot be resolved", () => {
    conflict.mockReturnValue("target not empty");
    resolveTarget.mockReturnValue(undefined);
    materialized.mockReturnValue(true);
    const decision = decideScaffoldPreflight({
      name: "shell.exec",
      args: { command: scaffoldCommand },
    });
    expect(decision.adoptTarget).toBe(false);
    expect(decision.message).toBe(
      "Scaffold skipped: the target already contains a usable project. Continue that project directly; do not re-run the scaffolder.",
    );
  });
});
