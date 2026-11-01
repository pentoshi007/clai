import { CliRenderer } from "@opentui/core";

interface FrameLoopRenderer {
  readonly renderTimeout: unknown;
  startRenderLoop(): void;
}

let patched = false;

export function patchOpenTuiFrameLoop(): void {
  if (patched) return;
  patched = true;

  const proto = CliRenderer.prototype as unknown as FrameLoopRenderer;
  const startRenderLoop = proto.startRenderLoop;
  if (typeof startRenderLoop !== "function") return;
  proto.startRenderLoop = function (this: FrameLoopRenderer): void {
    if (this.renderTimeout) return;
    startRenderLoop.call(this);
  };
}
