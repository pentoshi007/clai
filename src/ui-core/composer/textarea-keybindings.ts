
export type TextareaActionName =
  | "submit"
  | "newline"
  | "delete-to-line-start"
  | "delete-to-line-end"
  | "delete-line"
  | "delete-word-backward"
  | "delete-word-forward"
  | "select-all"
  | "select-word-backward"
  | "select-word-forward"
  | "select-line-home"
  | "select-line-end";

export interface TextareaKeyBindingLike {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly action: TextareaActionName;
}

const ENTER_NAMES = ["return", "kpenter"] as const;

export function buildComposerTextareaOverrides(): TextareaKeyBindingLike[] {
  const overrides: TextareaKeyBindingLike[] = [];
  for (const name of ENTER_NAMES) {
    overrides.push({ name, action: "submit" });
    overrides.push({ name, shift: true, action: "newline" });
    overrides.push({ name, meta: true, action: "newline" });
    overrides.push({ name, ctrl: true, action: "newline" });
  }

  overrides.push({
    name: "backspace",
    meta: true,
    action: "delete-word-backward",
  });
  overrides.push({
    name: "delete",
    meta: true,
    action: "delete-word-forward",
  });

  overrides.push({ name: "backspace", super: true, action: "delete-line" });
  overrides.push({ name: "delete", super: true, action: "delete-line" });
  overrides.push({ name: "backspace", ctrl: true, action: "delete-line" });
  overrides.push({ name: "delete", ctrl: true, action: "delete-line" });

  overrides.push({ name: "u", ctrl: true, action: "delete-line" });
  overrides.push({ name: "k", ctrl: true, action: "delete-to-line-end" });

  overrides.push({ name: "a", super: true, action: "select-all" });
  overrides.push({ name: "a", ctrl: true, meta: true, action: "select-all" });
  overrides.push({
    name: "left",
    meta: true,
    shift: true,
    action: "select-word-backward",
  });
  overrides.push({
    name: "right",
    meta: true,
    shift: true,
    action: "select-word-forward",
  });
  overrides.push({
    name: "left",
    super: true,
    shift: true,
    action: "select-line-home",
  });
  overrides.push({
    name: "right",
    super: true,
    shift: true,
    action: "select-line-end",
  });

  return overrides;
}
