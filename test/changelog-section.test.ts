import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { changelogSection } from "../scripts/changelog-section.mjs";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

describe("changelogSection", () => {
  it("returns the body of the matching version without its heading", () => {
    const section = changelogSection(changelog, "5.8.1");
    expect(section).toContain("### Memory");
    expect(section).toContain("clonePlain");
    expect(section).not.toContain("## v5.8.1");
    expect(section).not.toContain("## v5.8.0");
  });

  it("accepts a leading v and stops at the next release heading", () => {
    expect(changelogSection(changelog, "v5.8.0")).toBe(changelogSection(changelog, "5.8.0"));
    expect(changelogSection(changelog, "5.8.0")).toContain("### Decision questions");
    expect(changelogSection(changelog, "5.8.0")).not.toContain("### Memory");
  });

  it("returns null when the version has no section or the section is empty", () => {
    expect(changelogSection(changelog, "0.0.0")).toBeNull();
    expect(changelogSection("## v1.0.0 — 2026-01-01\n\n## v0.9.0 — 2025-12-01\n\n- Old.\n", "1.0.0")).toBeNull();
  });

  it("handles CRLF changelogs", () => {
    expect(changelogSection("## v1.0.0 — 2026-01-01\r\n\r\n### Fixed\r\n\r\n- Thing.\r\n", "1.0.0")).toBe(
      "### Fixed\n\n- Thing.",
    );
  });
});
