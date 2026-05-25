import { describe, expect, it } from "vitest";
import {
  parseHost,
  parsePortSpec,
  parseLegacyFlags,
  profileToNmapArgs,
} from "../src/tools/validate.js";
import { assertSafePackageName } from "../src/os/pkgmgr.js";
import { toolRegistry } from "../src/tools/registry.js";

describe("phase 4 — parseHost", () => {
  it("accepts ipv4, ipv6, CIDR, hostnames", () => {
    expect(parseHost("192.168.1.1")).toEqual({ kind: "ip", value: "192.168.1.1" });
    expect(parseHost("10.0.0.0/8")).toEqual({ kind: "cidr", value: "10.0.0.0/8" });
    expect(parseHost("2001:db8::1")).toEqual({ kind: "ip", value: "2001:db8::1" });
    expect(parseHost("example.com")).toEqual({ kind: "hostname", value: "example.com" });
    expect(parseHost("scanme.nmap.org")).toEqual({ kind: "hostname", value: "scanme.nmap.org" });
  });

  it("rejects shell metacharacters", () => {
    expect(() => parseHost("example.com; rm -rf /")).toThrow(/metacharacters/);
    expect(() => parseHost("example.com && curl evil")).toThrow(/metacharacters/);
    expect(() => parseHost("`whoami`")).toThrow(/metacharacters/);
    expect(() => parseHost("$(id)")).toThrow(/metacharacters/);
    expect(() => parseHost("a|b")).toThrow(/metacharacters/);
  });

  it("rejects empty / blank input", () => {
    expect(() => parseHost("")).toThrow(/empty/);
    expect(() => parseHost("   ")).toThrow(/empty/);
  });

  it("rejects malformed CIDR", () => {
    expect(() => parseHost("10.0.0.0/abc")).toThrow(/CIDR/);
    expect(() => parseHost("10.0.0.0/99")).toThrow(/CIDR/);
    expect(() => parseHost("notanip/24")).toThrow(/CIDR/);
  });
});

describe("phase 4 — parsePortSpec", () => {
  it("accepts single, csv, ranges, mixed", () => {
    expect(parsePortSpec("80")).toBe("80");
    expect(parsePortSpec("80,443,8080")).toBe("80,443,8080");
    expect(parsePortSpec("1-1000")).toBe("1-1000");
    expect(parsePortSpec("22,80,443,8000-9000")).toBe("22,80,443,8000-9000");
  });

  it("rejects shell metacharacters", () => {
    expect(() => parsePortSpec("80; rm -rf /")).toThrow();
    expect(() => parsePortSpec("80|cat")).toThrow();
    expect(() => parsePortSpec("$(id)")).toThrow();
  });

  it("rejects invalid port numbers and reversed ranges", () => {
    expect(() => parsePortSpec("0")).toThrow();
    expect(() => parsePortSpec("65536")).toThrow();
    expect(() => parsePortSpec("100-50")).toThrow();
    expect(() => parsePortSpec("abc")).toThrow();
  });
});

describe("phase 4 — parseLegacyFlags", () => {
  it("accepts safe flag tokens", () => {
    expect(parseLegacyFlags("-A -T4")).toEqual(["-A", "-T4"]);
    expect(parseLegacyFlags("--script=banner")).toEqual(["--script=banner"]);
  });

  it("rejects shell metacharacters", () => {
    expect(() => parseLegacyFlags("-A; rm")).toThrow();
    expect(() => parseLegacyFlags("`id`")).toThrow();
    expect(() => parseLegacyFlags("$(curl evil)")).toThrow();
  });
});

describe("phase 4 — profileToNmapArgs", () => {
  it("maps structured fields to safe nmap argv", () => {
    expect(
      profileToNmapArgs({ scanType: "syn", serviceDetect: true, topPorts: 100, timing: "T3" }),
    ).toEqual(["-sS", "-sV", "-T3", "--top-ports", "100"]);
  });

  it("rejects invalid timing template", () => {
    expect(() => profileToNmapArgs({ timing: "T9" as any })).toThrow();
  });

  it("rejects invalid script names", () => {
    expect(() => profileToNmapArgs({ scripts: ["safe;evil"] })).toThrow();
  });

  it("rejects invalid topPorts", () => {
    // topPorts <= 0 is silently ignored (treated as "not specified"), not an error
    expect(profileToNmapArgs({ topPorts: 0 })).toEqual([]);
    expect(profileToNmapArgs({ topPorts: -1 })).toEqual([]);
    // Out-of-range positive values still throw
    expect(() => profileToNmapArgs({ topPorts: 100000 })).toThrow();
  });
});

describe("phase 4 — assertSafePackageName", () => {
  it("accepts common identifiers", () => {
    expect(assertSafePackageName("nmap")).toBe("nmap");
    expect(assertSafePackageName("python3.11")).toBe("python3.11");
    expect(assertSafePackageName("@scope/pkg")).toBe("@scope/pkg");
    expect(assertSafePackageName("Microsoft.PowerShell")).toBe("Microsoft.PowerShell");
  });

  it("rejects shell metacharacters", () => {
    expect(() => assertSafePackageName("nmap; rm -rf /")).toThrow();
    expect(() => assertSafePackageName("$(curl evil)")).toThrow();
    expect(() => assertSafePackageName("nmap|cat")).toThrow();
  });
});

describe("phase 4 — registry validation rejects injection at the tool boundary", () => {
  it("net.scan rejects shell metacharacters in target", async () => {
    await expect(
      toolRegistry["net.scan"]!({ target: "example.com; curl evil" }),
    ).rejects.toThrow(/metacharacters/);
  });

  it("net.scan rejects bad ports", async () => {
    await expect(
      toolRegistry["net.scan"]!({ target: "example.com", ports: "80; rm -rf /" }),
    ).rejects.toThrow();
  });

  it("net.scan rejects metacharacters in legacy flags", async () => {
    await expect(
      toolRegistry["net.scan"]!({ target: "example.com", flags: "`id`" }),
    ).rejects.toThrow();
  });

  it("pentest.recon rejects shell injection in target", async () => {
    await expect(
      toolRegistry["pentest.recon"]!({ target: "`whoami`" }),
    ).rejects.toThrow(/metacharacters/);
  });

  it("pkg.install rejects shell metacharacters in tool name", async () => {
    await expect(
      toolRegistry["pkg.install"]!({ tool: "nmap; rm -rf /" }),
    ).rejects.toThrow(/Invalid package name/);
  });
});
