export interface KeyEvent {
  readonly name: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly super?: boolean | undefined;
  readonly text: string;
}

export type MouseButton = "left" | "middle" | "right" | "none";

export interface MouseEvent {
  readonly button: MouseButton;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
  readonly drag: boolean;
  readonly scroll: "up" | "down" | undefined;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export type DecodedEvent =
  | { readonly type: "key"; readonly key: KeyEvent }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "mouse"; readonly event: MouseEvent };

export interface KeyModifiers {
  readonly ctrl?: boolean | undefined;
  readonly alt?: boolean | undefined;
  readonly shift?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly super?: boolean | undefined;
}

export function keyEvent(
  name: string,
  modifiers: KeyModifiers = {},
  text = "",
): KeyEvent {
  return {
    name,
    ctrl: modifiers.ctrl === true,
    alt: modifiers.alt === true,
    shift: modifiers.shift === true,
    meta: modifiers.meta === true,
    super: modifiers.super === true ? true : undefined,
    text,
  };
}
