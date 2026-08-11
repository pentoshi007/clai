import { describe, expect, it } from "vitest";
import {
  buildBatchCardsFromSpool,
  parseBatchLiveProgress,
} from "../../../src/ui-core/rendering/batch-sections.js";

describe("buildBatchCardsFromSpool (live nested cards)", () => {
  it("shows running placeholders as soon as children start", () => {
    const raw = [
      "[batch] starting 3 call(s), concurrency=3",
      "[batch] #1 whois.lookup starting",
      "[batch] #2 dns.lookup starting",
    ].join("\n");
    const cards = buildBatchCardsFromSpool(raw);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      index: 1,
      name: "whois.lookup",
      status: "running",
    });
    expect(cards[1]).toMatchObject({
      index: 2,
      name: "dns.lookup",
      status: "running",
    });
  });

  it("merges streamed section bodies with still-running siblings", () => {
    const raw = [
      "[batch] starting 3 call(s), concurrency=3",
      "[batch] #1 whois.lookup starting",
      "[batch] #2 dns.lookup starting",
      "[batch] #3 sysinfo starting",
      "── #1 whois.lookup [fail exit=130]",
      "Cancelled by user",
      "",
      "[batch] #1 whois.lookup fail exit=130",
      "[batch] #2 dns.lookup ok exit=0",
      "── #2 dns.lookup [ok exit=0]",
      "A 1.2.3.4",
      "TTL 300",
      "",
      "[batch] #3 sysinfo still running…",
      "[batch] still running — 2/3 finished",
    ].join("\n");
    const cards = buildBatchCardsFromSpool(raw);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({
      index: 1,
      name: "whois.lookup",
      status: "fail",
      body: "Cancelled by user",
    });
    expect(cards[1]).toMatchObject({
      index: 2,
      name: "dns.lookup",
      status: "ok",
      body: "A 1.2.3.4\nTTL 300",
    });
    expect(cards[2]).toMatchObject({
      index: 3,
      name: "sysinfo",
      status: "running",
    });
  });

  it("ignores [batch] ticks inside section bodies", () => {
    const raw = [
      "── #1 dns.lookup [ok exit=0]",
      "A 1.2.3.4",
      "[batch] #1 dns.lookup ok exit=0",
      "[batch] still running — 1/2 finished",
      "",
      "── #2 whois.lookup [ok exit=0]",
      "Registrar: example",
    ].join("\n");
    const cards = buildBatchCardsFromSpool(raw);
    expect(cards[0]!.body).toBe("A 1.2.3.4");
    expect(cards[0]!.body).not.toMatch(/\[batch\]/);
    expect(cards[1]!.body).toBe("Registrar: example");
  });
});

describe("parseBatchLiveProgress", () => {
  it("summarizes live cards without requiring final replace", () => {
    const raw = [
      "[batch] starting 3 call(s), concurrency=3",
      "[batch] #1 whois.lookup starting",
      "[batch] #2 dns.lookup starting",
      "[batch] #1 whois.lookup fail exit=130",
      "[batch] #2 dns.lookup ok exit=0",
      "[batch] still running — 2/3 finished",
    ].join("\n");
    const { lines, summary } = parseBatchLiveProgress(raw);
    expect(summary).toMatch(/1 failed|2 sub-tool/i);
    expect(lines.some((l) => l.text.includes("whois.lookup") && l.tone === "fail")).toBe(
      true,
    );
    expect(lines.some((l) => l.text.includes("dns.lookup") && l.tone === "ok")).toBe(true);
  });
});
