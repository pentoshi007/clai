import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildComposerTextareaOverrides,
  buildTextEditorTextareaOverrides,
} from "../../src/tui-v2/composer/textarea-keybindings.js";

describe("OpenTUI multiline editor modal", () => {
  it("binds Enter to newline and keeps the composer's editing chords", () => {
    const editor = buildTextEditorTextareaOverrides();
    const enter = editor.filter((binding) => binding.name === "return");
    expect(enter.length).toBeGreaterThan(0);
    expect(enter.every((binding) => binding.action === "newline")).toBe(true);
    expect(editor.some((binding) => binding.action === "submit")).toBe(false);

    const composerOnly = buildComposerTextareaOverrides().filter(
      (binding) => binding.action !== "submit" && binding.action !== "newline",
    );
    for (const binding of composerOnly) {
      expect(
        editor.some(
          (candidate) =>
            candidate.name === binding.name &&
            candidate.action === binding.action &&
            candidate.ctrl === binding.ctrl &&
            candidate.meta === binding.meta &&
            candidate.super === binding.super &&
            candidate.shift === binding.shift,
        ),
      ).toBe(true);
    }
    expect(
      editor.some((binding) => binding.action === "delete-word-backward"),
    ).toBe(true);
    expect(editor.some((binding) => binding.action === "select-all")).toBe(true);
  });

  it("edits in a native textarea and saves with ctrl+s", () => {
    const modal = readFileSync(
      "src/tui-v2/components/modal/text-editor-modal.tsx",
      "utf8",
    );
    expect(modal).toContain("<textarea");
    expect(modal).toContain("cursorColor");
    expect(modal).toContain("selectionBg");
    expect(modal).toContain("buildTextEditorTextareaOverrides");
    expect(modal).toContain('chord === "ctrl+s"');
    expect(modal).toContain("answerTextEditor");

    const host = readFileSync(
      "src/tui-v2/components/overlay/overlay-host.tsx",
      "utf8",
    );
    expect(host).toContain('state.kind === "text-editor"');
    expect(host).toContain("TextEditorModal");
    // Full-screen host, not the docked strip, so long JSON gets real rows.
    expect(host).not.toContain('kind === "text-editor" ||');
  });
});
