import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { renderIntroHeaderLines } from "../src/ui-core/rendering/intro-header.js";

const stripAnsi = (value: string): string =>
  value.replace(/\x1b\[[0-9;]*m/g, "");

const options = {
  version: "1.2.3",
  mode: "agent",
  provider: "openrouter",
  model: "example/model",
  permissions: "default",
  workdir: "~/project",
  variant: "high",
};

describe("intro header layout", () => {
  it("uses a true half split and includes configured variant data when wide", () => {
    const lines = renderIntroHeaderLines({ ...options, width: 120 }).map(stripAnsi);
    const top = lines.find((line) => line.includes("╭") && line.includes("┬"))!;
    const frame = top.trimStart();
    const divider = frame.indexOf("┬");
    const leftInner = divider - 1;
    const rightInner = frame.length - divider - 2;
    expect(Math.abs(leftInner - rightInner)).toBeLessThanOrEqual(1);
    expect(lines.some((line) => line.includes("effort") && line.includes("high"))).toBe(true);
  });

  it("keeps the narrow fallback inside its width with equal outer borders", () => {
    const width = 44;
    const lines = renderIntroHeaderLines({ ...options, width }).map(stripAnsi);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    const top = lines.find((line) => line.includes("╭"))!;
    const bottom = lines.find((line) => line.includes("╰"))!;
    expect(stringWidth(top)).toBe(stringWidth(bottom));
expect(lines.some((line) => line.includes("effo") && line.includes("high"))).toBe(true);
  });
});
