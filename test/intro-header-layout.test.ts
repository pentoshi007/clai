import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { displayWorkdir, renderIntroHeaderLines } from "../src/ui-core/rendering/intro-header.js";

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

  it("shows effort on its own row instead of repeating it after the model", () => {
    for (const width of [120, 60, 44]) {
      const text = renderIntroHeaderLines({ ...options, width }).map(stripAnsi).join("\n");
      expect(text).not.toContain("(high)");
    }
  });

  it("hides the effort row when reasoning is off", () => {
    for (const width of [120, 44]) {
      const text = renderIntroHeaderLines({ ...options, variant: "off", width }).map(stripAnsi).join("\n");
      expect(text).not.toMatch(/\beff(ort)?\b/);
    }
  });

  it("never labels the model row as mode in the narrow card", () => {
    const lines = renderIntroHeaderLines({ ...options, width: 44 }).map(stripAnsi);
    const modelRow = lines.find((line) => line.includes("example/model"))!;
    expect(modelRow).toMatch(/\bmodel\b/);
    expect(modelRow).not.toMatch(/\bmode\b/);
  });

  it.each([24, 32, 44, 60, 80, 120])("fits mode and permission badges within %s columns", (width) => {
    for (const mode of ["ask", "agent", "plan"]) {
      const lines = renderIntroHeaderLines({ ...options, mode, permissions: "full-access", width }).map(stripAnsi);
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      const text = lines.join("\n");
      expect(text).toContain(`${mode.toUpperCase()} MODE`);
      expect(text).toContain("FULL-ACCESS");
    }
  });

  it("colors the mode badge per mode", () => {
    const badgeColor = (mode: string): string => {
      const line = renderIntroHeaderLines({ ...options, mode, width: 120 }).find((l) => l.includes(`${mode.toUpperCase()} MODE`))!;
      const before = line.slice(0, line.indexOf(` ${mode.toUpperCase()} MODE`));
      return before.slice(before.lastIndexOf("\x1b[48;"));
    };
    const colors = new Set(["ask", "agent", "plan"].map(badgeColor));
    expect(colors.size).toBe(3);
  });
});

describe("displayWorkdir", () => {
  it("abbreviates the home directory but not sibling paths that share its prefix", () => {
    expect(displayWorkdir("/home/me", "/home/me")).toBe("~");
    expect(displayWorkdir("/home/me/project", "/home/me")).toBe("~/project");
    expect(displayWorkdir("/home/me2/project", "/home/me")).toBe("/home/me2/project");
  });
});
