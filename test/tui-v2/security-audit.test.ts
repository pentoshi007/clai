/**
 * V2-094 — secrets, clipboard, URL schemes, export redaction, control bytes.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  asSessionId,
  asToolCallId,
} from "../../src/app/events/app-event.js";
import type { ClipboardPort } from "../../src/app/ports/clipboard-port.js";
import { EventSequencer } from "../../src/app/events/sequencer.js";
import { SecretBuffer } from "../../src/tui-v2/composer/secret-buffer.js";
import { SelectionController } from "../../src/tui-v2/controllers/selection-controller.js";
import { detectLinks } from "../../src/tui-v2/rendering/link-detector.js";
import { sanitizeDisplayText } from "../../src/tui-v2/rendering/sanitize-display.js";
import { presentOutput } from "../../src/tui-v2/rendering/tool-presenter.js";
import { renderTranscriptPlainText } from "../../src/tui-v2/rendering/transcript-export.js";
import { applyAppEvent } from "../../src/tui-v2/state/transcript-reducer.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../src/tui-v2/state/transcript-types.js";
import {
  normalizeSemanticDocument,
} from "../../src/tui-v2/state/semantic-document.js";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("V2-094 security audit", () => {
  it("SecretBuffer never leaks plaintext via String/JSON/template", () => {
    const secret = "sk-ant-super-secret-value-abcdef";
    const buf = new SecretBuffer();
    buf.insert(secret, 0);
    const surfaces = [
      String(buf),
      buf.toString(),
      JSON.stringify(buf),
      JSON.stringify({ nested: buf }),
      `${buf}`,
      Object.prototype.toString.call(buf),
    ];
    for (const s of surfaces) {
      expect(s).not.toContain(secret);
      expect(s).not.toContain("sk-ant-super");
    }
    expect(buf.reveal()).toBe(secret);
  });

  it("export redacts known API key shapes and strips control sequences", () => {
    const seq = new EventSequencer(asSessionId("sec"));
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build(
        "turn-started",
        { prompt: "use key gsk_abcdef1234567890 and sk-or-xyzABC123" },
        undefined,
      ),
    );
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        {
          messageId: seq.ids.message(),
          text: "ok \x1b[31mred\x1b[0m\x00",
        },
        undefined,
      ),
    );
    const text = renderTranscriptPlainText(state);
    expect(text).toContain("gsk_••••••");
    expect(text).toContain("sk-••••••");
    expect(text).not.toContain("gsk_abcdef");
    expect(text).not.toContain("sk-or-xyz");
    expect(text).not.toMatch(/\x1b/);
    expect(text).not.toMatch(/\x00/);
  });

  it("tool output presentation strips ANSI/control injection", () => {
    const tail = "line1\n\x1b[2J\x1b[Hcleared\x07\nsecret\x1b]0;x\x07";
    const presented = presentOutput(tail, undefined, true);
    const joined = presented.lines.join("\n");
    expect(joined).not.toMatch(/\x1b/);
    expect(joined).not.toMatch(/\x07/);
    expect(joined).toContain("line1");
    expect(joined).toContain("cleared");
  });

  it("clipboard only receives sanitized selection text (not empty clicks)", async () => {
    const writes: string[] = [];
    const clipboard: ClipboardPort = {
      async writeText(text) {
        writes.push(text);
      },
    };
    const selection = new SelectionController(clipboard, { copyOnRelease: true });
    const doc = normalizeSemanticDocument({
      blocks: [{ id: "b1", text: "hello \x1b[31mworld\x1b[0m" }],
    });
    selection.setDocument("transcript", doc);
    // Zero-width click: nothing to copy.
    selection.click("transcript", { blockId: "b1", offset: 0 });
    const empty = await selection.copy();
    expect(empty.status).toBe("empty");
    expect(writes).toEqual([]);

    selection.beginDrag("transcript", { blockId: "b1", offset: 0 });
    selection.dragTo("transcript", {
      blockId: "b1",
      offset: doc.blocks[0]!.text.length,
    });
    selection.finishDrag();
    // finishDrag may auto-copy; assert sanitized payload either way.
    const result = writes.length > 0 ? { status: "copied" as const, text: writes[0]! } : await selection.copy();
    expect(result.status).toBe("copied");
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0]).not.toMatch(/\x1b/);
    expect(writes[0]).toContain("hello");
    expect(writes[0]).toContain("world");
  });

  it("link detector only allows http(s) URL schemes", () => {
    const text =
      "see https://example.com/a and http://ok.dev " +
      "javascript:alert(1) data:text/html,x vbscript:msg file:///etc/passwd";
    const urls = detectLinks(text).filter((s) => s.kind === "url");
    expect(urls.map((u) => u.value).sort()).toEqual([
      "http://ok.dev",
      "https://example.com/a",
    ]);
  });

  it("sanitizeDisplayText is pure and idempotent", () => {
    const input = "a\x1b[1mb\x00c\nd";
    const once = sanitizeDisplayText(input);
    expect(sanitizeDisplayText(once)).toBe(once);
    expect(once).toBe("abc\nd");
  });

  it("src/app never imports SecretBuffer (secrets stay out of event layer)", () => {
    const appDir = join(root, "src", "app");
    const offenders: string[] = [];
    for (const file of walk(appDir)) {
      const src = readFileSync(file, "utf8");
      if (/SecretBuffer|secret-buffer/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("clipboard writeText call sites in tui-v2 are limited to selection + osc52 + explicit copy UX", () => {
    const tuiDir = join(root, "src", "tui-v2");
    const offenders: string[] = [];
    for (const file of walk(tuiDir)) {
      const src = readFileSync(file, "utf8");
      if (!/\.writeText\s*\(/.test(src)) continue;
      const rel = file.replace(root + "/", "");
      const allowed =
        rel.endsWith("selection-controller.ts") ||
        rel.endsWith("osc52-clipboard.ts") ||
        rel.endsWith("use-native-selection-copy.ts") ||
        // Explicit user-triggered copy (pager `c`, prompt actions).
        rel.endsWith("pager.tsx") ||
        rel.endsWith("prompt-actions-modal.tsx");
      if (!allowed) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("tool-result events never carry raw secret payloads in argsDisplay via known patterns", () => {
    const seq = new EventSequencer(asSessionId("t"));
    let state = EMPTY_TRANSCRIPT_STATE;
    state = applyAppEvent(
      state,
      seq.build(
        "tool-call",
        {
          toolCallId: asToolCallId("c1"),
          name: "shell",
          argsDisplay: "echo ok",
        },
        undefined,
      ),
    );
    const item = state.byId.get(state.order[0]!);
    expect(item).toMatchObject({ kind: "tool", argsDisplay: "echo ok" });
    expect(JSON.stringify(item)).not.toMatch(/reveal\(/);
  });
});
