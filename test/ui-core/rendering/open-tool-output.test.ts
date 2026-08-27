import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileChange } from "../../../src/tools/file-diff.js";
import {
  cleanArgsLabel,
  formatToolPagerBody,
  openToolOutputPager,
  pathFromArgsDisplay,
  toolPagerTitle,
} from "../../../src/ui-core/rendering/open-tool-output.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("formatToolPagerBody", () => {
  it("renders web.search payloads as a numbered hit list", () => {
    const raw = [
      "duckduckgo: 2 results",
      JSON.stringify({
        results: [
          {
            title: "Keir Starmer",
            url: "https://example.com/a",
            snippet: "Current PM since 2024.",
          },
          {
            title: "GOV.UK",
            url: "https://www.gov.uk/pm",
            snippet: "Official page.",
          },
        ],
      }),
    ].join("\n");
    const out = formatToolPagerBody(raw);
    expect(out).toContain("duckduckgo: 2 results");
    expect(out).toContain("1. Keir Starmer");
    expect(out).toContain("   https://example.com/a");
    expect(out).toContain("2. GOV.UK");
    expect(out).not.toContain('"results"');
  });

  it("pretty-prints generic JSON objects", () => {
    const raw = '{"ok":true,"count":1}';
    const out = formatToolPagerBody(raw);
    expect(out).toContain('"ok": true');
    expect(out).toContain('"count": 1');
  });

  it("leaves non-JSON text alone", () => {
    const raw = "duckduckgo: 5 results\nhello";
    expect(formatToolPagerBody(raw)).toBe(raw);
  });

  it("leaves invalid JSON alone", () => {
    const raw = "{not json";
    expect(formatToolPagerBody(raw)).toBe(raw);
  });
});

describe("toolPagerTitle", () => {
  it("keeps a short stable title", () => {
    expect(toolPagerTitle("web.search", "who is uk pm")).toBe(
      "web.search · who is uk pm",
    );
  });

  it("clips very long args in the title", () => {
    const long = "x".repeat(80);
    const title = toolPagerTitle("web.search", long);
    expect(title.length).toBeLessThan(70);
    expect(title.startsWith("web.search · ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
  });

  it("extracts path from JSON args instead of dumping JSON", () => {
    const title = toolPagerTitle(
      "fs.read",
      JSON.stringify({
        path: "/Users/me/todo-app/src/components/TodoForm.tsx",
        offset: 55,
      }),
    );
    expect(title).toContain("TodoForm.tsx");
    expect(title).not.toContain("{");
  });
});

describe("cleanArgsLabel / pathFromArgsDisplay", () => {
  it("recovers path from truncated JSON history dumps", () => {
    const truncated =
      '{"path":"/Users/aniketpandey/Desktop/todo-app/src/components/TodoForm.tsx","o…';
    expect(cleanArgsLabel("fs.read", truncated)).toContain("TodoForm.tsx");
    expect(pathFromArgsDisplay(truncated)).toContain("TodoForm.tsx");
  });

  it("resolves relative source paths and rejects command text", () => {
    expect(pathFromArgsDisplay("src/index.ts")).toBe(
      join(process.cwd(), "src/index.ts"),
    );
    expect(pathFromArgsDisplay("npm test && echo done")).toBeUndefined();
  });

  it("keeps the full shell command for pager body headers (no ellipsis)", () => {
    const cmd = [
      'echo "=== localhost ===" && curl -s -o /dev/null -w "HTTP %{http_code}\\n"',
      "--max-time 5 http://localhost:5173/",
      '&& echo "=== title ===" && curl -s http://localhost:5173/ | grep -i title',
    ].join(" ");
    expect(cleanArgsLabel("shell.exec", cmd)).toBe(cmd);
    expect(cleanArgsLabel("shell.exec", cmd)).not.toContain("…");
    // Short form only when maxLen is requested (border title).
    const short = cleanArgsLabel("shell.exec", cmd, { maxLen: 48 });
    expect(short.endsWith("…")).toBe(true);
    expect(short.length).toBeLessThanOrEqual(48);
  });
});


describe("large file-change pager", () => {
  it("opens omitted after-content through a bounded full-file source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clai-large-diff-"));
    tempDirs.push(dir);
    const path = join(dir, "large.ts");
    const content = Array.from(
      { length: 6_000 },
      (_, index) => `export const line${index} = "${"x".repeat(24)}";`,
    ).join("\n");
    await writeFile(path, content);
    const change = buildFileChange({
      path,
      before: "",
      after: content,
      kind: "create",
    });
    expect(change.afterText).toBeUndefined();

    let opened:
      | {
          body: string;
          source: { readAll(): Promise<string>; dispose(): void } | undefined;
        }
      | undefined;
    const services = {
      overlay: {
        openPager(
          _title: string,
          body: string,
          source: { readAll(): Promise<string>; dispose(): void } | undefined,
        ) {
          opened = { body, source };
          return true;
        },
      },
      session: {
        notice() {},
        spool: { tail: () => "" },
      },
    } as never;

    await openToolOutputPager(
      services,
      {
        toolCallId: "large-diff",
        name: "fs.write",
        argsDisplay: path,
        artifactPath: undefined,
        fileChanges: [change],
      } as never,
      { fileChange: change },
    );

    expect(opened?.source).toBeDefined();
    expect(opened?.body).toContain("export const line0");
    expect(await opened!.source!.readAll()).toBe(content);
    opened?.source?.dispose();
  });
});


describe("large output pager", () => {
  it("keeps the complete body behind a bounded source", async () => {
    const body = `${"output-line\n".repeat(20_000)}LAST-LINE`;
    let opened:
      | {
          body: string;
          source: { readAll(): Promise<string>; dispose(): void } | undefined;
        }
      | undefined;
    const services = {
      overlay: {
        openPager(
          _title: string,
          pagerBody: string,
          source: { readAll(): Promise<string>; dispose(): void } | undefined,
        ) {
          opened = { body: pagerBody, source };
          return true;
        },
      },
      session: {
        notice() {},
        spool: { tail: () => "" },
      },
    } as never;

    await openToolOutputPager(
      services,
      {
        toolCallId: "large-output",
        name: "shell.exec",
        argsDisplay: "generate output",
        artifactPath: undefined,
      } as never,
      { bodyOverride: body },
    );

    expect(opened?.source).toBeDefined();
    expect(Buffer.byteLength(opened?.body ?? "", "utf8")).toBeLessThan(
      Buffer.byteLength(body, "utf8"),
    );
    expect(await opened!.source!.readAll()).toBe(body);
    opened?.source?.dispose();
  });
});
