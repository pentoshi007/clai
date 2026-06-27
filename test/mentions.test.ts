import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getMentionQuery,
  findFileSuggestions,
  extractMentionTokens,
  normalizeDroppedPath,
  expandMentions,
  extractExistingPathsFs,
} from "../src/ui/mentions.js";

describe("getMentionQuery", () => {
  it("detects a mention at the cursor", () => {
    const q = getMentionQuery("read @src/App", 13);
    expect(q).toEqual({ query: "src/App", start: 5 });
  });

  it("detects a mention at line start", () => {
    const q = getMentionQuery("@foo", 4);
    expect(q).toEqual({ query: "foo", start: 0 });
  });

  it("returns null when not in a mention", () => {
    expect(getMentionQuery("hello world", 11)).toBeNull();
  });

  it("returns null when @ is mid-word (email-like)", () => {
    expect(getMentionQuery("mail me at a@b", 14)).toBeNull();
  });

  it("returns null once whitespace follows the @", () => {
    expect(getMentionQuery("@foo bar", 8)).toBeNull();
  });
});

describe("findFileSuggestions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clai-mentions-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "README.md"), "# hi");
    writeFileSync(join(dir, "src", "App.tsx"), "x");
    writeFileSync(join(dir, "src", "main.ts"), "y");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists top-level entries for an empty query", () => {
    const out = findFileSuggestions("", dir);
    const values = out.map((s) => s.value);
    expect(values).toContain("package.json");
    expect(values).toContain("README.md");
    expect(values).toContain("src/");
  });

  it("hides noise dirs like node_modules", () => {
    const out = findFileSuggestions("", dir);
    expect(out.map((s) => s.value)).not.toContain("node_modules/");
  });

  it("filters by prefix", () => {
    const out = findFileSuggestions("pack", dir);
    expect(out.map((s) => s.value)).toEqual(["package.json"]);
  });

  it("descends into a directory query", () => {
    const out = findFileSuggestions("src/", dir);
    const values = out.map((s) => s.value).sort();
    expect(values).toEqual(["src/App.tsx", "src/main.ts"]);
  });

  it("filters inside a directory", () => {
    const out = findFileSuggestions("src/App", dir);
    expect(out.map((s) => s.value)).toEqual(["src/App.tsx"]);
  });

  it("sorts directories before files", () => {
    const out = findFileSuggestions("", dir);
    expect(out[0]!.isDir).toBe(true);
  });
});

describe("normalizeDroppedPath", () => {
  it("strips single quotes", () => {
    expect(normalizeDroppedPath("'/a/b c.txt'")).toBe("/a/b c.txt");
  });
  it("strips double quotes", () => {
    expect(normalizeDroppedPath('"/a/b.txt"')).toBe("/a/b.txt");
  });
  it("unescapes backslash-escaped spaces", () => {
    expect(normalizeDroppedPath("/a/b\\ c.txt")).toBe("/a/b c.txt");
  });
});

describe("extractMentionTokens", () => {
  it("extracts @ mentions", () => {
    expect(extractMentionTokens("look at @src/App.tsx please")).toEqual([
      "@src/App.tsx",
    ]);
  });

  it("extracts multiple mentions", () => {
    expect(extractMentionTokens("@a.txt and @b.txt")).toEqual([
      "@a.txt",
      "@b.txt",
    ]);
  });

  it("extracts quoted dropped paths", () => {
    expect(extractMentionTokens("'/Users/me/foo bar.png'")).toEqual([
      "'/Users/me/foo bar.png'",
    ]);
  });

  it("extracts bare absolute paths", () => {
    expect(extractMentionTokens("check /etc/hosts now")).toEqual([
      "/etc/hosts",
    ]);
  });

  it("ignores a bare @ inside an email", () => {
    expect(extractMentionTokens("a@b.com")).toEqual([]);
  });
});

describe("expandMentions", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clai-expand-"));
    writeFileSync(join(dir, "notes.txt"), "hello notes");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("inlines a referenced text file", () => {
    const out = expandMentions("read @notes.txt", dir);
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0]!.kind).toBe("text");
    expect(out.attachments[0]!.content).toBe("hello notes");
    expect(out.contextBlock).toContain("hello notes");
    expect(out.contextBlock).toContain("attached-files");
  });

  it("notes a missing @ mention", () => {
    const out = expandMentions("read @nope.txt", dir);
    expect(out.attachments[0]!.kind).toBe("missing");
  });

  it("classifies images as non-inlined", () => {
    writeFileSync(join(dir, "pic.png"), Buffer.from([0x89, 0x50]));
    const out = expandMentions("describe @pic.png", dir);
    expect(out.attachments[0]!.kind).toBe("image");
    expect(out.attachments[0]!.content).toBeUndefined();
  });

  it("returns an empty context block when there are no mentions", () => {
    const out = expandMentions("just a normal prompt", dir);
    expect(out.attachments).toHaveLength(0);
    expect(out.contextBlock).toBe("");
  });

  it("preserves the original text", () => {
    const out = expandMentions("read @notes.txt please", dir);
    expect(out.text).toBe("read @notes.txt please");
  });

  it("resolves a dropped absolute path with spaces before trailing prompt text", () => {
    const image = join(dir, "Screenshot 2026-06-27 at 10.44.32 AM.png");
    writeFileSync(image, Buffer.from([0x89, 0x50]));
    const line = `${image.replaceAll(" ", "\\ ")} what is it`;
    expect(extractExistingPathsFs(line, dir)).toEqual([image]);
    expect(expandMentions(line, dir, true).attachments[0]).toMatchObject({
      path: image,
      kind: "image",
    });
  });
});
