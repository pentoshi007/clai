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

describe("highlightCss", () => {
  const kinds = (line: string, carry = emptyCarry(), path = "styles.css") =>
    highlightLineForPath(line, path, carry).map((s) => `${s.kind}:${s.text}`);

  it("keeps hyphenated property names in a single span", () => {
    const carry = emptyCarry();
    kinds(".a {", carry);
    expect(kinds("  background-color: #fafafa;", carry)).toEqual([
      "plain:  ",
      "property:background-color",
      "punctuation::",
      "plain: ",
      "number:#fafafa",
      "punctuation:;",
    ]);
  });

  it("highlights custom properties and numbers with units", () => {
    const carry = emptyCarry();
    kinds(".a {", carry);
    expect(kinds("  --main-padding: 1.5rem;", carry)).toEqual([
      "plain:  ",
      "property:--main-padding",
      "punctuation::",
      "plain: ",
      "number:1.5rem",
      "punctuation:;",
    ]);
  });

  it("highlights classes, pseudo-classes, at-rules, and !important", () => {
    const carry = emptyCarry();
    expect(kinds(".nav-item:hover {", carry)).toEqual([
      "punctuation:.",
      "type:nav-item",
      "punctuation::",
      "keyword:hover",
      "plain: ",
      "punctuation:{",
    ]);
    expect(kinds("  color: red !important;", carry)).toEqual([
      "plain:  ",
      "property:color",
      "punctuation::",
      "plain: red ",
      "keyword:!important",
      "punctuation:;",
    ]);
    expect(kinds("@media (max-width: 768px) {", carry)).toEqual([
      "keyword:@media",
      "plain: ",
      "punctuation:(",
      "property:max-width",
      "punctuation::",
      "plain: ",
      "number:768px",
      "punctuation:)",
      "plain: ",
      "punctuation:{",
    ]);
  });

  it("does not treat // inside strings or url() as comments", () => {
    const carry = emptyCarry();
    kinds(".a {", carry);
    expect(kinds('  content: "a // b";', carry)).toContain('string:"a // b"');
    expect(kinds("  background: url(//cdn.example.com/x.png);", carry)).toContain(
      "string://cdn.example.com/x.png",
    );
  });

  it("tracks block comments and brace depth across lines", () => {
    const carry = emptyCarry();
    expect(kinds("/* outer", carry)).toEqual(["comment:/* outer"]);
    expect(kinds("still comment */ .x {", carry)[0]).toBe("comment:still comment */");
    expect(kinds("  display: flex;", carry)).toContain("property:display");
  });

  it("supports scss line comments and variables", () => {
    expect(kinds("$primary: #333; // theme", emptyCarry(), "styles.scss")).toEqual([
      "property:$primary",
      "punctuation::",
      "plain: ",
      "number:#333",
      "punctuation:;",
      "plain: ",
      "comment:// theme",
    ]);
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
