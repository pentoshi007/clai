import { describe, expect, it } from "vitest";
import {
  emptyCarry,
  highlightLineForPath,
  languageFromPath,
  supportedExtensions,
} from "../../../src/ui-core/rendering/syntax-highlight.js";

describe("languageFromPath — broad coverage", () => {
  it("maps common web/source extensions", () => {
    expect(languageFromPath("App.jsx")).toBe("js");
    expect(languageFromPath("a.ts")).toBe("js");
    expect(languageFromPath("x.py")).toBe("py");
    expect(languageFromPath("Main.java")).toBe("clike");
    expect(languageFromPath("lib.rs")).toBe("clike");
    expect(languageFromPath("main.go")).toBe("clike");
    expect(languageFromPath("styles.css")).toBe("css");
    expect(languageFromPath("data.json")).toBe("json");
    expect(languageFromPath("index.html")).toBe("html");
    expect(languageFromPath("README.md")).toBe("md");
    expect(languageFromPath("script.sh")).toBe("sh");
    expect(languageFromPath("query.sql")).toBe("sql");
    expect(languageFromPath("app.rb")).toBe("ruby");
    expect(languageFromPath("index.php")).toBe("php");
    expect(languageFromPath("mod.ex")).toBe("ruby");
    expect(languageFromPath("a.hs")).toBe("haskell");
    expect(languageFromPath("a.lisp")).toBe("lisp");
    expect(languageFromPath("a.r")).toBe("r");
    expect(languageFromPath("a.pl")).toBe("perl");
    expect(languageFromPath("a.lua")).toBe("lua");
    expect(languageFromPath("a.yaml")).toBe("yaml");
    expect(languageFromPath("a.toml")).toBe("toml");
    expect(languageFromPath("a.diff")).toBe("diff");
  });

  it("maps basenames without extensions", () => {
    expect(languageFromPath("Dockerfile")).toBe("sh");
    expect(languageFromPath("Makefile")).toBe("sh");
    expect(languageFromPath("Gemfile")).toBe("ruby");
    expect(languageFromPath("package.json")).toBe("json");
  });

  it("falls back to generic for unknown extensions", () => {
    expect(languageFromPath("weird.zzzzunknown")).toBe("generic");
    expect(languageFromPath("noext")).toBe("generic");
  });

  it("registers many extensions", () => {
    expect(supportedExtensions().length).toBeGreaterThan(50);
  });
});

describe("highlightLineForPath", () => {
  it("colors JS keywords and strings", () => {
    const spans = highlightLineForPath(
      `const x = "hi"; // note`,
      "src/App.js",
      emptyCarry(),
    );
    const kinds = spans.map((s) => s.kind);
    expect(kinds).toContain("keyword");
    expect(kinds).toContain("string");
    expect(kinds).toContain("comment");
  });

  it("colors Python keywords", () => {
    const spans = highlightLineForPath("def foo():", "a.py", emptyCarry());
    expect(spans.some((s) => s.kind === "keyword" && s.text === "def")).toBe(
      true,
    );
    expect(spans.some((s) => s.kind === "function" && s.text === "foo")).toBe(
      true,
    );
  });

  it("colors CSS properties-ish and hex", () => {
    const spans = highlightLineForPath(
      "  color: #ff00aa;",
      "a.css",
      emptyCarry(),
    );
    expect(spans.some((s) => s.kind === "number" && s.text.includes("#"))).toBe(
      true,
    );
  });

  it("still highlights unknown languages generically", () => {
    const spans = highlightLineForPath(
      `foo = "bar" // cmt`,
      "file.zzzzunknown",
      emptyCarry(),
    );
    expect(spans.some((s) => s.kind === "string")).toBe(true);
    expect(spans.some((s) => s.kind === "comment")).toBe(true);
  });

  it("handles # comments in generic / shell", () => {
    const spans = highlightLineForPath("# install deps", "setup.sh", emptyCarry());
    expect(spans.every((s) => s.kind === "comment")).toBe(true);
  });

  it("handles SQL case-insensitive keywords", () => {
    const spans = highlightLineForPath(
      "SELECT * FROM users WHERE id = 1",
      "q.sql",
      emptyCarry(),
    );
    expect(spans.some((s) => s.kind === "keyword")).toBe(true);
    expect(spans.some((s) => s.kind === "number")).toBe(true);
  });
});
