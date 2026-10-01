import { normalizePasteLineBreaks } from "../../ui-core/input/paste-text.js";

const ANSI_SEQUENCE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const DISALLOWED_C0 = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizePasteText(raw: string): string {
  return normalizePasteLineBreaks(raw.replace(ANSI_SEQUENCE, "")).replace(DISALLOWED_C0, "");
}
