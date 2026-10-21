import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDefaultCommandRegistry } from "../../src/app/commands/registry.js";
import { findReaMentions, hasReaMention, REA_TOKEN } from "../../src/rea/workflow.js";
import { resolveCompletionMenu } from "../../src/ui-core/composer/completion.js";
import { extractMentionTokens } from "../../src/ui/mentions/expand.js";

describe("@rea mention syntax", () => {
  it("is the token that /rea inserts", () => {
    expect(REA_TOKEN).toBe("@rea");
  });

  it.each([
    ["@rea", 1],
    ["@rea inspect this", 1],
    ["inspect @rea this", 1],
    ["use @rea.", 1],
    ["(@rea)", 1],
    ["see @rea, then", 1],
    ["@rea: go", 1],
    ["@rea @rea", 2],
    ["first line\n@rea second", 1],
    ["\"@rea\"", 1],
    ["`@rea`", 1],
    ["@mcp:docs and @rea", 1],
  ])("recognises %j", (text, count) => {
    expect(findReaMentions(text)).toHaveLength(count);
    expect(hasReaMention(text)).toBe(count > 0);
  });

  it.each([
    "@README.md",
    "@rea.md",
    "@rea/",
    "@rea/src/main.ts",
    "me@rea.com",
    "foo@rea",
    "@reason",
    "@rea-agents",
    "@rea_x",
    "@mcp:rea",
    "/rea",
    "rea",
    "https://example.test/@rea",
    "",
  ])("ignores %j", (text) => {
    expect(findReaMentions(text)).toEqual([]);
    expect(hasReaMention(text)).toBe(false);
  });

  it("reports ranges that cover exactly the token", () => {
    const text = "inspect @rea and @rea.";
    const spans = findReaMentions(text).map(({ start, end }) => text.slice(start, end));
    expect(spans).toEqual(["@rea", "@rea"]);
    expect(findReaMentions(text)[0]).toEqual({ start: 8, end: 12 });
  });
});

describe("@rea in the composer", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "clai-rea-mention-"));
    writeFileSync(join(dir, "README.md"), "x");
    writeFileSync(join(dir, "rea"), "x");
    writeFileSync(join(dir, "rea.md"), "x");
    mkdirSync(join(dir, "reader"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("never treats @rea as a file attachment", () => {
    expect(extractMentionTokens("@rea inspect it")).toEqual([]);
    expect(extractMentionTokens("look at @./rea and @rea")).toEqual(["@./rea"]);
    expect(extractMentionTokens("@rea, then @README.md")).toEqual(["@README.md"]);
    expect(extractMentionTokens("@rea.md")).toEqual(["@rea.md"]);
  });

  it("closes the file menu once @rea is typed so Enter submits instead of attaching a file", () => {
    const registry = buildDefaultCommandRegistry();
    expect(resolveCompletionMenu(registry, "@rea", 4, dir).kind).toBe("none");
    expect(resolveCompletionMenu(registry, "inspect @rea", 12, dir).kind).toBe("none");
    const partial = resolveCompletionMenu(registry, "@re", 3, dir);
    expect(partial.kind).toBe("mention");
    const dotted = resolveCompletionMenu(registry, "@rea.", 5, dir);
    expect(dotted.kind === "mention" && dotted.items.map((item) => item.value)).toEqual(["rea.md"]);
  });
});
