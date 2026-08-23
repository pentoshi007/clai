import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../../src/app/commands/registry.js";
import { ComposerController } from "../../../src/classic/chrome/composer-controller.js";
import { resolveCompletionMenu, type CompletionMenu } from "../../../src/ui-core/composer/completion.js";
import {
  acceptCompletion,
  completeCommonPrefix,
} from "../../../src/classic/panels/completion-accept.js";
import {
  COMPLETION_MAX_ROWS,
  COMPLETION_MIN_ROWS,
  commandLabel,
  completionCommonPrefix,
  completionItemValues,
  completionOverlayRows,
  completionRowsWanted,
  completionView,
  isImageSuggestion,
  sortSuggestions,
} from "../../../src/classic/panels/completion-rows.js";
import { listWindow, windowCounter } from "../../../src/classic/panels/list-window.js";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth } from "../../../src/classic/render/measure.js";
import type { EditorState } from "../../../src/classic/chrome/editor-model.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: true });

function registry(): CommandRegistry {
  const commands = new CommandRegistry();
  commands.register({ name: "model", description: "switch model", aliases: ["use"] });
  commands.register({ name: "models", description: "browse models" });
  commands.register({ name: "mode", description: "set ask, agent, or plan" });
  commands.register({ name: "help", description: "show help" });
  return commands;
}

function composerController(onSubmit = vi.fn()) {
  return {
    composer: new ComposerController({
      commands: registry(),
      clipboard: { async writeText() {} },
      onSubmit,
      onToast: vi.fn(),
      onScrollChat: vi.fn(),
      onJumpTop: vi.fn(),
    }),
    onSubmit,
  };
}

function draft(text: string): EditorState {
  return { text, cursor: text.length };
}

function menuFor(text: string, baseDir?: string): CompletionMenu {
  return resolveCompletionMenu(registry(), text, text.length, baseDir);
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "classic-completion-"));
  mkdirSync(join(root, "src", "routes"), { recursive: true });
  writeFileSync(join(root, "src", "routes", "users.ts"), "export const users = 1;\n");
  writeFileSync(join(root, "src", "routes", "users.test.ts"), "test\n");
  writeFileSync(join(root, "src", "logo.png"), "png");
});

describe("slash menu", () => {
  it("lists the full catalogue for a bare slash", () => {
    const menu = menuFor("/");
    expect(menu.kind).toBe("slash");
    expect(completionItemValues(menu)).toEqual(["/model", "/models", "/mode", "/help"]);
  });

  it("narrows by prefix and matches aliases", () => {
    expect(completionItemValues(menuFor("/mod"))).toEqual(["/model", "/models", "/mode"]);
    expect(completionItemValues(menuFor("/us"))).toEqual(["/model"]);
  });

  it("runs the selected mid-prompt command on Enter and preserves the draft", () => {
    const { composer, onSubmit } = composerController();
    composer.setText("draft /he");
    expect(composer.getSnapshot().menu.kind).toBe("slash");
    expect(composer.handleChord("enter")).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith("/help");
    expect(composer.getSnapshot().state).toEqual({
      text: "draft ",
      cursor: 6,
    });
  });

  it("completes on Tab without running the selected command", () => {
    const { composer, onSubmit } = composerController();
    composer.setText("draft /he");
    expect(composer.handleChord("tab")).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(composer.text).toBe("draft /help ");
  });

  it("submits normally when a slash token has no matches", () => {
    const { composer, onSubmit } = composerController();
    composer.setText("draft /not-a-command");
    expect(composer.getSnapshot().menu.kind).toBe("none");
    expect(composer.handleAction("editor.submit")).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith("draft /not-a-command");
  });

  it("treats an absolute path as a prompt, never a command", () => {
    expect(menuFor("/Users/me/file.ts").kind).toBe("none");
    expect(menuFor("/tmp\\win").kind).toBe("none");
  });

  it("closes once the command token is followed by an argument", () => {
    expect(resolveCompletionMenu(registry(), "/mode agent", 11).kind).toBe("none");
  });

  it("renders the alias list next to the name", () => {
    expect(commandLabel({ name: "model", description: "d", aliases: ["use"] })).toBe(
      "/model, /use",
    );
  });

  it("completes the common prefix on tab", () => {
    const menu = menuFor("/mod");
    expect(completeCommonPrefix(menu, draft("/mod"))).toEqual({
      text: "/mode",
      cursor: 5,
    });
    expect(completeCommonPrefix(menuFor("/mode"), draft("/mode"))).toBeUndefined();
  });

  it("computes the common prefix of the candidates", () => {
    expect(completionCommonPrefix(["/model", "/models", "/mode"])).toBe("/mode");
    expect(completionCommonPrefix(["/a", "/b"])).toBe("/");
    expect(completionCommonPrefix([])).toBe("");
  });

  it("accepts the active row with a trailing space", () => {
    const accepted = acceptCompletion({
      menu: menuFor("/mod"),
      state: draft("/mod"),
      active: 2,
      intent: "accept",
    });
    expect(accepted?.state).toEqual({ text: "/mode ", cursor: 6 });
    expect(accepted?.acceptedSlash).toBe("/mode");
    expect(accepted?.keepMenuOpen).toBe(false);
  });

  it("keeps an existing argument when accepting a command", () => {
    const menu = resolveCompletionMenu(registry(), "/mod agent", 4);
    expect(menu.kind).toBe("slash");
    const accepted = acceptCompletion({
      menu,
      state: { text: "/mod agent", cursor: 4 },
      active: 2,
      intent: "accept",
    });
    expect(accepted?.state.text).toBe("/mode  agent");
  });
});

describe("mention menu", () => {
  it("suggests files under the queried directory", () => {
    const menu = menuFor("look at @src/routes/us", root);
    expect(menu.kind).toBe("mention");
    expect(completionItemValues(menu)).toEqual([
      "src/routes/users.test.ts",
      "src/routes/users.ts",
    ]);
  });

  it("sorts directories before files", () => {
    const sorted = sortSuggestions([
      { value: "a.ts", label: "a.ts", isDir: false },
      { value: "b/", label: "b/", isDir: true },
    ]);
    expect(sorted.map((entry) => entry.value)).toEqual(["b/", "a.ts"]);
  });

  it("tags images", () => {
    expect(isImageSuggestion({ value: "logo.png", label: "logo.png", isDir: false })).toBe(true);
    expect(isImageSuggestion({ value: "a.ts", label: "a.ts", isDir: false })).toBe(false);
    expect(isImageSuggestion({ value: "img/", label: "img/", isDir: true })).toBe(false);
  });

  it("drills into a directory on tab and attaches it on enter", () => {
    const menu = menuFor("@sr", root);
    expect(menu.kind).toBe("mention");
    const state = draft("@sr");
    const drilled = acceptCompletion({ menu, state, active: 0, intent: "complete" });
    expect(drilled?.state.text).toBe("@src/");
    expect(drilled?.keepMenuOpen).toBe(true);
    const attached = acceptCompletion({ menu, state, active: 0, intent: "accept" });
    expect(attached?.state.text).toBe("@src ");
    expect(attached?.keepMenuOpen).toBe(false);
  });

  it("inserts a file reference and closes the menu", () => {
    const menu = menuFor("@src/routes/users.t", root);
    const accepted = acceptCompletion({
      menu,
      state: draft("@src/routes/users.t"),
      active: 1,
      intent: "accept",
      baseDir: root,
    });
    expect(accepted?.state.text).toBe(
      `${pathToFileURL(join(root, "src", "routes", "users.ts")).href} `,
    );
    expect(accepted?.keepMenuOpen).toBe(false);
    expect(accepted?.acceptedSlash).toBeUndefined();
  });

  it("never offers a common-prefix completion for mentions", () => {
    expect(completeCommonPrefix(menuFor("@src/routes/us", root), draft("@src/routes/us"))).toBeUndefined();
  });
});

describe("menu geometry", () => {
  it("clamps the row request to the spec band", () => {
    expect(completionRowsWanted(9)).toBe(COMPLETION_MIN_ROWS);
    expect(completionRowsWanted(30)).toBe(10);
    expect(completionRowsWanted(120)).toBe(COMPLETION_MAX_ROWS);
    expect(completionOverlayRows(30)).toBe(12);
  });

  it("windows the active row with a one-row margin", () => {
    expect(listWindow({ count: 20, active: 0, height: 5 })).toMatchObject({ top: 0 });
    expect(listWindow({ count: 20, active: 6, height: 5, previousTop: 0 }).top).toBe(3);
    expect(listWindow({ count: 20, active: 19, height: 5 }).top).toBe(15);
    expect(listWindow({ count: 3, active: 0, height: 9 })).toMatchObject({
      top: 0,
      clippedBelow: false,
    });
  });

  it("counts from one", () => {
    expect(windowCounter(0, 38)).toBe("1/38");
    expect(windowCounter(0, 0)).toBeUndefined();
  });

  it("renders every row at exactly the panel width", () => {
    const view = completionView({
      ink,
      menu: menuFor("/"),
      active: 1,
      columns: 60,
      rows: 8,
    });
    expect(view).toBeDefined();
    const { rows } = panelFrameRows(view!.frame);
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(displayWidth(row)).toBe(60);
  });

  it("titles and hints by trigger", () => {
    const slash = completionView({ ink, menu: menuFor("/"), active: 0, columns: 60, rows: 8 });
    expect(slash!.frame.title).toBe("/commands");
    expect(slash!.frame.hints?.join(" ")).toContain("run");
    const mention = completionView({
      ink,
      menu: menuFor("@src/routes/us", root),
      active: 0,
      columns: 60,
      rows: 8,
    });
    expect(mention!.frame.title).toBe("@files");
    expect(mention!.frame.hints?.join(" ")).toContain("insert");
  });

  it("renders nothing when there is no menu", () => {
    expect(completionView({ ink, menu: { kind: "none" }, active: 0, columns: 60, rows: 8 })).toBeUndefined();
  });
});
