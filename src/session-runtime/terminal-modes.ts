const PRIVATE_MODE_PATTERN = /\u001b\[\?([0-9;]{1,64})([hl])/g;
const CARRY_BYTES = 72;

const RESTORABLE_MODE_ORDER: readonly string[] = [
  "1049",
  "1047",
  "47",
  "1",
  "25",
  "1004",
  "2004",
  "1000",
  "1002",
  "1003",
  "1005",
  "1006",
  "1015",
  "1016",
];

const RESTORABLE_MODES = new Set(RESTORABLE_MODE_ORDER);

export class TerminalModeState {
  private readonly enabled = new Map<string, boolean>();
  private carry = "";

  private applyToken(params: string | undefined, on: boolean): void {
    if (!params) return;
    for (const mode of params.split(";")) {
      if (RESTORABLE_MODES.has(mode)) this.enabled.set(mode, on);
    }
  }

  observe(bytes: Uint8Array | string): void {
    const chunk =
      typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("latin1");
    if (chunk.length === 0) return;
    const scanned = this.carry + chunk;
    for (const match of scanned.matchAll(PRIVATE_MODE_PATTERN)) {
      this.applyToken(match[1], match[2] === "h");
    }
    this.carry = scanned.slice(-CARRY_BYTES);
  }

  enabledModes(): readonly string[] {
    return RESTORABLE_MODE_ORDER.filter((mode) => this.enabled.get(mode) === true);
  }

  restoreSequence(): string {
    const active = this.enabledModes();
    if (active.length === 0) return "";
    return active.map((mode) => `\u001b[?${mode}h`).join("");
  }
}
