import { describe, expect, it } from "vitest";
import { snapSelectionStart, startSnappedSelection, type SnapNode } from "../../src/tui-v2/components/transcript/selection-snap.js";
import { inclusiveSelectionFocus } from "../../src/tui-v2/bootstrap/patch-opentui-selection.js";

interface Node extends SnapNode {
  readonly id: string;
  readonly children: Node[];
}

function node(id: string, x: number, y: number, width: number, height: number, selectable: boolean, children: Node[] = []): Node {
  return { id, x, y, width, height, selectable, visible: true, children, getChildren: () => children };
}

const first = node("first", 2, 1, 20, 1, true);
const second = node("second", 2, 2, 20, 1, true);
const third = node("third", 2, 5, 20, 1, true);
const hidden = node("hidden", 2, 8, 20, 1, true);
const root = node("root", 0, 0, 40, 10, false, [
  node("card", 0, 0, 40, 4, false, [first, second]),
  node("block", 0, 5, 40, 1, false, [third]),
  hidden,
]);
const viewport = { x: 0, y: 0, width: 40, height: 7 };
const snap = (x: number, y: number) => {
  const target = snapSelectionStart([{ root, viewport }], x, y);
  return target && { id: (target.node as Node).id, x: target.x, y: target.y };
};

describe("snapSelectionStart", () => {
  it("clamps a press in row padding to the nearest end of that row's text", () => {
    expect(snap(0, 1)).toEqual({ id: "first", x: 2, y: 1 });
    expect(snap(30, 2)).toEqual({ id: "second", x: 21, y: 2 });
  });

  it("anchors a press below text at the end of the line above", () => {
    expect(snap(5, 3)).toEqual({ id: "second", x: 21, y: 2 });
  });

  it("anchors a press above text at the start of the line below", () => {
    expect(snap(5, 0)).toEqual({ id: "first", x: 2, y: 1 });
  });

  it("prefers the line above when a gap is equidistant", () => {
    expect(snap(5, 4)?.id).toBe("third");
    const tie = snapSelectionStart([{ root: node("r", 0, 0, 10, 3, false, [node("a", 0, 0, 5, 1, true), node("b", 0, 2, 5, 1, true)]) }], 3, 1);
    expect((tie?.node as Node).id).toBe("a");
  });

  it("ignores text scrolled outside the viewport", () => {
    expect(snap(5, 9)?.id).toBe("third");
  });

  it("starts a native selection only when the press missed selectable text", () => {
    const started: string[] = [];
    let prevented = 0;
    const renderer = {
      dragging: false,
      getSelection() { return this.dragging ? { isDragging: true } : null; },
      startSelection(target: Node, x: number, y: number) { started.push(`${target.id}@${x},${y}`); },
    };
    const press = { x: 0, y: 2, button: 0, preventDefault: () => { prevented += 1; } };
    expect(startSnappedSelection(renderer, press, [{ root, viewport }])).toBe(true);
    expect(started).toEqual(["second@2,2"]);
    expect(prevented).toBe(1);
    renderer.dragging = true;
    expect(startSnappedSelection(renderer, press, [{ root, viewport }])).toBe(false);
    renderer.dragging = false;
    expect(startSnappedSelection(renderer, { ...press, button: 2 }, [{ root, viewport }])).toBe(false);
    expect(startSnappedSelection(renderer, { ...press, modifiers: { ctrl: true } }, [{ root, viewport }])).toBe(false);
  });
});

describe("inclusiveSelectionFocus", () => {
  it("moves a forward focus one cell right so the cell under the pointer is selected", () => {
    expect(inclusiveSelectionFocus({ x: 2, y: 1 }, { x: 12, y: 1 })).toEqual({ x: 13, y: 1 });
    expect(inclusiveSelectionFocus({ x: 20, y: 1 }, { x: 0, y: 3 })).toEqual({ x: 1, y: 3 });
  });

  it("leaves backward drags and the pressed cell itself unchanged", () => {
    expect(inclusiveSelectionFocus({ x: 12, y: 1 }, { x: 2, y: 1 })).toEqual({ x: 2, y: 1 });
    expect(inclusiveSelectionFocus({ x: 5, y: 3 }, { x: 9, y: 1 })).toEqual({ x: 9, y: 1 });
    expect(inclusiveSelectionFocus({ x: 5, y: 1 }, { x: 5, y: 1 })).toEqual({ x: 5, y: 1 });
  });
});
