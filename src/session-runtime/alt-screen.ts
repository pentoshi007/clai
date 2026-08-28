export const ALT_SCREEN_OFF = "\u001b[?1049l";

const ALT_SCREEN_MODES = new Set(["47", "1047", "1049"]);
const PRIVATE_MODE_PATTERN = /\u001b\[\?([0-9;]{1,64})([hl])/g;
const CARRY_BYTES = 72;

export class AltScreenTracker {
  private active = false;
  private carry = "";

  constructor(active = false) {
    this.active = active;
  }

  get isActive(): boolean {
    return this.active;
  }

  observe(bytes: Uint8Array | string): void {
    const chunk =
      typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("latin1");
    if (chunk.length === 0) return;
    const scanned = this.carry + chunk;
    for (const match of scanned.matchAll(PRIVATE_MODE_PATTERN)) {
      if (this.togglesAltScreen(match[1])) this.active = match[2] === "h";
    }
    this.carry = scanned.slice(-CARRY_BYTES);
  }

  private togglesAltScreen(params: string | undefined): boolean {
    if (!params) return false;
    return params.split(";").some((param) => ALT_SCREEN_MODES.has(param));
  }
}
