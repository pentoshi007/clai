import { describe, expect, it } from "vitest";
import { DEFAULT_PERMISSION_MODE, configuredPermissionMode, parsePermissionMode, permissionModeLabel } from "../src/safety/permission-mode.js";
import { formatComposerMeta } from "../src/ui-core/composer/composer-meta.js";
import { renderIntroHeaderLines } from "../src/ui-core/rendering/intro-header.js";

describe("permission mode presentation", () => {
  it("uses auto-allow when no mode has been stored", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("allow-all");
    expect(permissionModeLabel(undefined)).toBe("auto-allow");
    expect(formatComposerMeta("codex", "gpt-6.1-sol", undefined)).toBe("codex · gpt-6.1-sol · auto-allow");
  });

  it.each([
    ["default", "default"],
    ["allow-all", "allow-all"],
    [" AUTO-ALLOW ", "allow-all"],
    ["full-access", "full-access"],
    ["invalid", undefined],
  ])("parses %s without widening permissions", (input, expected) => {
    expect(parsePermissionMode(input)).toBe(expected);
  });

  it.each(["invalid", null, false, 1, {}])("fails closed on malformed stored permissions: %s", (value) => {
    expect(configuredPermissionMode(value)).toBe("default");
  });

  it("normalizes stored aliases and missing values", () => {
    expect(configuredPermissionMode("auto-allow")).toBe("allow-all");
    expect(configuredPermissionMode(undefined)).toBe("allow-all");
    expect(configuredPermissionMode("full-access")).toBe("full-access");
  });

  it.each([32, 60, 100])("renders full-access without breaking a %s-column header", (width) => {
    const lines = renderIntroHeaderLines({
      width, version: "4.12.0", mode: "agent", provider: "codex", model: "gpt-6.1-sol",
      permissions: "full-access", workdir: "/project",
    }).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(lines.every((line) => line.length <= width)).toBe(true);
    expect(lines.join("\n")).toContain("FULL-ACCESS");
    expect(formatComposerMeta("codex", "gpt-6.1-sol", "full-access")).toContain("full-access");
  });
});
