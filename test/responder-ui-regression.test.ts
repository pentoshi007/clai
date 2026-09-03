import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("responder UI placement", () => {
  it("keeps responder lifecycle text out of the composer StatusLine", async () => {
    const text = await source("../src/tui-v2/components/status/status-line.tsx");
    const statusLine = text.slice(text.indexOf("function StatusLine("));

    expect(statusLine).not.toContain("responderStatusText(");
    expect(statusLine).not.toContain("state.responder");
  });

  it("initializes the dedicated responder panel collapsed", async () => {
    const text = await source("../src/tui-v2/components/jobs/jobs-panel.tsx");
    const panel = text.slice(text.indexOf("function ResponderPanel("));

    expect(panel).toMatch(/const \[collapsed, setCollapsed\] = useState\(true\)/);
    expect(panel).toContain('const header = `${collapsed ? "▸" : "▾"} Responder:');
  });

  it("hides the responder panel when nothing is running, ready, or unread", async () => {
    const text = await source("../src/tui-v2/components/jobs/jobs-panel.tsx");
    const panel = text.slice(text.indexOf("function ResponderPanel("));

    expect(panel).toContain("const hasActiveWork =");
    expect(panel).toMatch(/responderState\.running > 0/);
    expect(panel).toMatch(/responderState\.ready > 0/);
    expect(panel).toMatch(/responderState\.delivered > 0/);
    expect(panel).toContain("!hasActiveWork");
  });
});
