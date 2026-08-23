import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../../src/app/commands/registry.js";
import { ComposerController } from "../../../src/classic/chrome/composer-controller.js";
import {
  ARROW_BURST_THRESHOLD,
  ARROW_BURST_WINDOW_MS,
  resolveArrowIntent,
} from "../../../src/ui-core/composer/arrow-intent.js";

interface Harness {
  readonly composer: ComposerController;
  readonly onSubmit: ReturnType<typeof vi.fn>;
  readonly onScrollChat: ReturnType<typeof vi.fn>;
  readonly onJumpTop: ReturnType<typeof vi.fn>;
  readonly onToast: ReturnType<typeof vi.fn>;
  advance(ms: number): void;
}

function harness(): Harness {
  const commands = new CommandRegistry();
  commands.register({ name: "model", description: "switch model" });
  commands.register({ name: "mode", description: "set mode" });
  const onSubmit = vi.fn();
  const onScrollChat = vi.fn();
  const onJumpTop = vi.fn();
  const onToast = vi.fn();
  let clock = 10_000;
  const composer = new ComposerController({
    commands,
    clipboard: {
      async writeText() {},
      async readText() {
        return "";
      },
    },
    baseDir: process.cwd(),
    onSubmit,
    onToast,
    onScrollChat,
    onJumpTop,
    now: () => clock,
  });
  composer.setTextWidth(40);
  return {
    composer,
    onSubmit,
    onScrollChat,
    onJumpTop,
    onToast,
    advance(ms) {
      clock += ms;
    },
  };
}

function press(h: Harness, action: "editor.history-prev" | "editor.history-next"): void {
  h.advance(ARROW_BURST_WINDOW_MS + 5);
  h.composer.handleAction(action);
}

function submit(h: Harness, text: string): void {
  h.composer.setText(text);
  h.composer.handleAction("editor.submit");
}

describe("prompt history", () => {
  it("walks older entries and restores the draft past the newest", () => {
    const h = harness();
    submit(h, "first");
    submit(h, "second");
    h.composer.setText("draft");

    press(h, "editor.history-prev");
    expect(h.composer.text).toBe("second");
    press(h, "editor.history-prev");
    expect(h.composer.text).toBe("first");
    press(h, "editor.history-next");
    expect(h.composer.text).toBe("second");
    press(h, "editor.history-next");
    expect(h.composer.text).toBe("draft");
  });

  it("leaves the cursor at the end of a recalled prompt", () => {
    const h = harness();
    submit(h, "recall me");
    h.composer.handleAction("editor.history-prev");
    expect(h.composer.getSnapshot().state).toEqual({ text: "recall me", cursor: 9 });
  });

  it("scrolls the transcript when there is no history", () => {
    const h = harness();
    expect(h.composer.handleAction("editor.history-prev")).toBe(true);
    expect(h.composer.handleAction("editor.history-next")).toBe(true);
    expect(h.composer.text).toBe("");
    expect(h.onScrollChat).toHaveBeenCalled();
  });

  it("does not record consecutive duplicates", () => {
    const h = harness();
    submit(h, "same");
    submit(h, "same");
    press(h, "editor.history-prev");
    press(h, "editor.history-prev");
    expect(h.composer.text).toBe("same");
  });

  it("stops browsing once the draft is edited", () => {
    const h = harness();
    submit(h, "old");
    press(h, "editor.history-prev");
    h.composer.insertText("!");
    press(h, "editor.history-prev");
    expect(h.composer.text).toBe("old");
  });

  it("clears history browsing state on submit", () => {
    const h = harness();
    submit(h, "one");
    submit(h, "two");
    press(h, "editor.history-prev");
    submit(h, "three");
    press(h, "editor.history-prev");
    expect(h.composer.text).toBe("three");
  });
});

describe("arrow intent", () => {
  it("moves the caret between lines instead of recalling", () => {
    const h = harness();
    submit(h, "old");
    h.composer.setText("one\ntwo");
    h.composer.handleChord("home");
    press(h, "editor.history-prev");
    expect(h.composer.text).toBe("one\ntwo");
    expect(h.composer.getSnapshot().state.cursor).toBe(0);
  });

  it("recalls once the caret reaches the first line", () => {
    const h = harness();
    submit(h, "old");
    h.composer.setText("one\ntwo");
    h.composer.handleChord("home");
    press(h, "editor.history-prev");
    press(h, "editor.history-prev");
    expect(h.composer.text).toBe("old");
  });

  it("treats a rapid burst as chat scroll", () => {
    const h = harness();
    submit(h, "old");
    for (let index = 0; index <= ARROW_BURST_THRESHOLD; index += 1) {
      h.advance(ARROW_BURST_WINDOW_MS - 1);
      h.composer.handleAction("editor.history-prev");
    }
    expect(h.onScrollChat).toHaveBeenCalledWith(-3);
  });

  it("resets the burst counter after the window closes", () => {
    const h = harness();
    submit(h, "old");
    for (let index = 0; index <= ARROW_BURST_THRESHOLD; index += 1) {
      h.advance(ARROW_BURST_WINDOW_MS + 5);
      h.composer.handleAction("editor.history-prev");
    }
    expect(h.onScrollChat).not.toHaveBeenCalled();
  });

  it("ignores arrows while the completion menu owns them", () => {
    expect(
      resolveArrowIntent({
        chord: "up",
        plainText: "/mo",
        line: 0,
        lineCount: 1,
        menuOpen: true,
        isBrowsingHistory: false,
        burstCount: 0,
      }),
    ).toBe("ignore");
  });

  it("moves the menu selection instead of history when a menu is open", () => {
    const h = harness();
    submit(h, "old");
    h.composer.setText("/mo");
    expect(h.composer.menuOpen()).toBe(true);
    expect(h.composer.handleChord("down")).toBe(true);
    expect(h.composer.getSnapshot().active).toBe(1);
    expect(h.composer.handleChord("down")).toBe(true);
    expect(h.composer.getSnapshot().active).toBe(0);
    expect(h.composer.handleChord("up")).toBe(true);
    expect(h.composer.getSnapshot().active).toBe(1);
    expect(h.composer.text).toBe("/mo");
  });
});

describe("submit", () => {
  it("runs the selected completion on the first enter", () => {
    const h = harness();
    h.composer.setText("/mod");
    expect(h.composer.menuOpen()).toBe(true);
    h.composer.handleAction("editor.submit");
    expect(h.composer.text).toBe("");
    expect(h.onSubmit).toHaveBeenCalledWith("/model");
  });

  it("dismisses the menu with escape and leaves the draft alone", () => {
    const h = harness();
    h.composer.setText("/mod");
    expect(h.composer.handleChord("escape")).toBe(true);
    expect(h.composer.menuOpen()).toBe(false);
    expect(h.composer.text).toBe("/mod");
  });

  it("ignores an empty or whitespace-only draft", () => {
    const h = harness();
    h.composer.setText("   \n ");
    h.composer.handleAction("editor.submit");
    expect(h.onSubmit).not.toHaveBeenCalled();
    expect(h.composer.text).toBe("");
  });

  it("adds a newline without submitting", () => {
    const h = harness();
    h.composer.setText("one");
    h.composer.handleAction("editor.newline");
    expect(h.composer.text).toBe("one\n");
    expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it("jumps the transcript to the top with ctrl+u only on an empty draft", () => {
    const h = harness();
    expect(h.composer.handleChord("ctrl+u")).toBe(true);
    expect(h.onJumpTop).toHaveBeenCalledTimes(1);
    h.composer.setText("kill me");
    h.composer.handleChord("ctrl+u");
    expect(h.onJumpTop).toHaveBeenCalledTimes(1);
    expect(h.composer.text).toBe("");
  });

  it("notifies subscribers exactly once per change", () => {
    const h = harness();
    const listener = vi.fn();
    const unsubscribe = h.composer.subscribe(listener);
    h.composer.insertText("a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    h.composer.insertText("b");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
