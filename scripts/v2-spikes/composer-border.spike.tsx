/** @jsxImportSource @opentui/react */
import { createElement, createRef } from "react";
import stringWidth from "string-width";
import type { KeyEvent, MouseEvent, TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { ComposerInputBox } from "../../src/tui-v2/components/composer/composer-input-box.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

const width = 72;
const theme = themeFor("dark");
const editorRef = createRef<TextareaRenderable>();
const noop = () => {};
const node = createElement(ComposerInputBox, {
  theme,
  editorRef,
  focused: true,
  width,
  textRows: 4,
  boxHeight: 6,
  metaShown: "",
  chromeFg: theme.inputBorder,
  keyBindings: undefined as never,
  onMouseDown: noop,
  onMouseScroll: (_event: MouseEvent) => {},
  onSubmit: noop,
  onContentChange: noop,
  onCursorChange: noop,
  onKeyDown: (_event: KeyEvent) => {},
});

const setup = await testRender(node, { width, height: 8 });
try {
  editorRef.current?.setText(`${"界".repeat(40)} wrapped\nhard newline`);
  await setup.flush();
  const rows = setup.captureCharFrame().split("\n").filter((line) => /[┓┃┛]/.test(line));
  const columns = rows.map((line) => {
    const border = Math.max(line.lastIndexOf("┓"), line.lastIndexOf("┃"), line.lastIndexOf("┛"));
    return stringWidth(line.slice(0, border));
  });
  if (rows.length < 6 || new Set(columns).size !== 1 || columns[0] !== width - 1) {
    throw new Error(`right border columns were ${columns.join(", ")}; expected ${width - 1}`);
  }
  console.log("PASS composer border: hard newlines and wide wrapped text align");
} finally {
  setup.renderer.destroy();
}
process.exit(0);