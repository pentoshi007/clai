import { describe, expect, it } from "vitest";

import { formatToolContext } from "../../src/agent/tool-output-formatting.js";
import type { ToolCall, ToolResult } from "../../src/types.js";

const BODY_MIDDLE_MARKER = "CLAI-BODY-MIDDLE-MARKER";
const BODY_HEAD_MARKER = "CLAI-BODY-HEAD-MARKER";
const BODY_TAIL_MARKER = "CLAI-BODY-TAIL-MARKER";
const MULTILINE_BODY_BASELINE_CHARS = 4_444;

function filler(length: number): string {
  return "x".repeat(Math.max(0, length));
}

function bodyFiller(length: number): string {
  return "b".repeat(Math.max(0, length));
}

function singleLineBody(totalChars: number): string {
  const markers = BODY_HEAD_MARKER.length + BODY_MIDDLE_MARKER.length + BODY_TAIL_MARKER.length;
  const gap = Math.floor((totalChars - markers) / 2);
  return `${BODY_HEAD_MARKER}${bodyFiller(gap)}${BODY_MIDDLE_MARKER}${bodyFiller(gap)}${BODY_TAIL_MARKER}`;
}

function multiLineBody(lineCount: number): string {
  const lines: string[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    if (index === 0) lines.push(`<p>${BODY_HEAD_MARKER}</p>`);
    else if (index === Math.floor(lineCount / 2)) lines.push(`<p>${BODY_MIDDLE_MARKER}</p>`);
    else if (index === lineCount - 1) lines.push(`<p>${BODY_TAIL_MARKER}</p>`);
    else lines.push(`<p>line ${index} ${bodyFiller(30)}</p>`);
  }
  return lines.join("\n");
}

function headerLines(count: number, prefix: string): string[] {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    lines.push(`${prefix}-header-${index}: ${filler(120)}`);
  }
  return lines;
}

function httpEvidence(input: {
  body: string;
  headerCount?: number;
  redirectHops?: number;
}): string {
  const lines: string[] = [];
  lines.push("200 OK GET https://example.com/");
  const hops = input.redirectHops ?? 0;
  if (hops > 0) {
    const chain: string[] = [];
    for (let hop = 0; hop < hops; hop += 1) {
      chain.push(`301 GET https://example.com/hop${hop} → https://example.com/hop${hop + 1}`);
    }
    lines.push(`redirects: ${chain.join(" → ")} → 200 GET https://example.com/`);
    lines.push("");
    lines.push("Redirect responses (headers runtime-normalized):");
    for (let hop = 0; hop < hops; hop += 1) {
      lines.push(`  301 Moved Permanently GET https://example.com/hop${hop}`);
      lines.push(`  location: https://example.com/hop${hop + 1}`);
      for (const line of headerLines(25, `hop${hop}`)) lines.push(`  ${line}`);
      lines.push("");
    }
  }
  lines.push(
    `attempts=1 bodyBytes=${input.body.length} bodySha256=${"a".repeat(64)} charset=utf-8(content-type)`,
  );
  lines.push(
    "capture: response-body bytes after Fetch transfer/content decoding; SHA-256 covers exactly the captured bytes",
  );
  lines.push(
    "TLS: leaf cert not captured by http.fetch — use web.fetch with includeTls=true for fingerprint/SAN.",
  );
  lines.push("");
  lines.push("Final response headers (runtime-normalized; Set-Cookie preserved separately):");
  lines.push("content-type: text/html; charset=utf-8");
  lines.push("server: nginx");
  for (const line of headerLines(input.headerCount ?? 22, "x")) lines.push(line);
  lines.push("");
  lines.push("Tech hints: server=nginx; content-type=text/html; marker=next.js");
  lines.push("");
  lines.push("Body:");
  lines.push(input.body);
  return lines.join("\n");
}

function webFetchOutput(body: string): string {
  return [
    "URL: https://example.com/",
    "Status: 200 (text/html; charset=utf-8)",
    `Bytes: ${body.length}`,
    "",
    "Content:",
    body,
  ].join("\n");
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { name, args };
}

function result(output: string, overrides?: Partial<ToolResult>): ToolResult {
  return { ok: true, output, exitCode: 0, ...overrides };
}

function visible(name: string, output: string, overrides?: Partial<ToolResult>): string {
  return formatToolContext(call(name), result(output, overrides));
}

function bodyFillerChars(rendered: string): number {
  return (rendered.match(/b/g) ?? []).length;
}

describe("formatToolContext delivers fetch body content to the model", () => {
  it("keeps body content from a single-line 200 KB http.fetch body", () => {
    const rendered = visible("http.fetch", httpEvidence({ body: singleLineBody(200_000) }));
    expect(rendered).toContain(BODY_HEAD_MARKER);
    expect(rendered).toContain(BODY_TAIL_MARKER);
    expect(bodyFillerChars(rendered)).toBeGreaterThan(4_000);
  });

  it("keeps body content from a single-line 200 KB web.fetch body", () => {
    const rendered = visible("web.fetch", webFetchOutput(singleLineBody(200_000)));
    expect(rendered).toContain(BODY_HEAD_MARKER);
    expect(rendered).toContain(BODY_TAIL_MARKER);
    expect(bodyFillerChars(rendered)).toBeGreaterThan(10_000);
  });

  it("keeps body content behind three redirect hops of headers", () => {
    const rendered = visible(
      "http.fetch",
      httpEvidence({ body: multiLineBody(4_000), headerCount: 25, redirectHops: 3 }),
    );
    expect(rendered).toContain(BODY_HEAD_MARKER);
  });

  it("marks omission when the model asked for topLines only", async () => {
    const { selectOutput } = await import("../../src/tools/output-selection.js");
    const selected = selectOutput(
      httpEvidence({ body: multiLineBody(4_000) }),
      { topLines: 40 },
    );
    expect(selected).toMatch(/lines omitted/);
  });

  it("keeps delivering a multi-line body at least as well as the recorded baseline", () => {
    const rendered = visible("http.fetch", httpEvidence({ body: multiLineBody(4_000) }));
    const bodyChars = rendered
      .split("\n")
      .filter((line) => line.includes("<p>"))
      .join("\n").length;
    expect(bodyChars).toBeGreaterThanOrEqual(MULTILINE_BODY_BASELINE_CHARS);
    expect(rendered).toContain(BODY_HEAD_MARKER);
    expect(rendered).toContain(BODY_TAIL_MARKER);
  });

  it("keeps the error preview on a 4xx http.fetch response", () => {
    const rendered = visible(
      "http.fetch",
      httpEvidence({ body: multiLineBody(2_000) }).replace(
        "200 OK GET",
        "404 Not Found GET",
      ),
      { ok: false, exitCode: 1 },
    );
    expect(rendered).toContain("FAILURE SUMMARY");
    expect(rendered).toContain(BODY_TAIL_MARKER);
  });
});
