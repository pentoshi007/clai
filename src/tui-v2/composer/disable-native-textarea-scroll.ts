
type Mouseish = { readonly type?: string };
type Patchable = {
  onMouseEvent: (event: Mouseish) => void;
};

export function disableNativeTextareaScroll(
  editor: object | null | undefined,
): () => void {
  if (!editor) return () => {};
  const target = editor as Patchable;
  const proto = Object.getPrototypeOf(editor) as Patchable | null;
  const original = proto?.onMouseEvent;
  if (typeof original !== "function") return () => {};

  target.onMouseEvent = function patchedOnMouseEvent(
    this: unknown,
    event: Mouseish,
  ) {
    if (event?.type === "scroll") return;
    return original.call(this, event);
  };

  return () => {
    target.onMouseEvent = original.bind(editor);
  };
}
