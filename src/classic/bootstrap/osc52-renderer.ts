import type { Osc52RendererPort } from "../../ui-core/ports/clipboard-osc52.js";
import type { TerminalSession } from "./terminal-session.js";

export interface Osc52RendererOptions {
  readonly session: Pick<TerminalSession, "write">;
  readonly supported: boolean;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export type Passthrough = "none" | "tmux" | "screen";

function passthroughFor(env: Readonly<Record<string, string | undefined>>): Passthrough {
  if (env.TMUX) return "tmux";
  if ((env.TERM ?? "").startsWith("screen")) return "screen";
  return "none";
}

export function osc52Sequence(text: string, passthrough: Passthrough): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  const osc = `\x1b]52;c;${payload}\x07`;
  if (passthrough === "tmux") return `\x1bPtmux;${osc.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
  if (passthrough === "screen") return `\x1bP${osc}\x1b\\`;
  return osc;
}

export function createOsc52Renderer(options: Osc52RendererOptions): Osc52RendererPort {
  const env = options.env ?? process.env;
  const passthrough = passthroughFor(env);

  return {
    isOsc52Supported() {
      return options.supported;
    },
    copyToClipboardOSC52(text: string) {
      if (!options.supported) return false;
      try {
        options.session.write(osc52Sequence(text, passthrough));
        return true;
      } catch {
        return false;
      }
    },
  };
}
