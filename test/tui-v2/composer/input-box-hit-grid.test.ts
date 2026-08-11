import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(fileURLToPath(new URL("../../..", import.meta.url)));

describe("composer input box hit grid", () => {
  it("keeps the last textarea row clickable by not clipping children with overflow hidden", () => {
    const source = readFileSync(
      join(root, "src", "tui-v2", "components", "composer", "composer-input-box.tsx"),
      "utf8",
    );
    expect(source).not.toContain('overflow: "hidden"');
  });
});