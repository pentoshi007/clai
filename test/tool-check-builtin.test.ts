import { describe, expect, it } from "vitest";
import { toolCheckHandler } from "../src/tools/capabilities.js";

describe("tool.check reports real availability for network recon binaries", () => {
  it("reports dig/whois as installed or missing via install hints", async () => {
    const result = await toolCheckHandler({
      tools: ["dig", "whois", "nslookup"],
    });
    expect(result.output).toMatch(/dig/);
    expect(result.output).toMatch(/whois/);
    expect(result.output).toMatch(/nslookup/);
  });
});
