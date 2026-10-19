import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLegacyFreebuffFingerprintId,
  freebuffFingerprintId,
  resetFreebuffFingerprint,
  type FreebuffFingerprintDeps,
} from "../src/llm/freebuff-fingerprint.js";

const MACHINE_ID = "0123456789abcdef0123456789abcdef";

const FILES: Record<string, string> = {
  "/etc/machine-id": `${MACHINE_ID}\n`,
  "/sys/class/dmi/id/sys_vendor": "ACME Corp\n",
  "/sys/class/dmi/id/product_name": "Lab Box\n",
  "/sys/class/dmi/id/product_serial": "SN-1\n",
  "/sys/class/dmi/id/product_uuid": "UUID-1\n",
  "/proc/cpuinfo": "vendor_id : GenuineIntel\nmodel name : Intel(R) Core(TM) i9\ncpu cores : 8\n",
  "/etc/os-release": 'PRETTY_NAME="Ubuntu 26.04"\n',
};

function deps(overrides: Partial<FreebuffFingerprintDeps> = {}): FreebuffFingerprintDeps {
  return {
    env: { SHELL: "/bin/bash" },
    platform: "linux",
    arch: "arm64",
    nodeVersion: "v24.0.0",
    readText: (path) => FILES[path] ?? null,
    hostname: () => "lab-host",
    cpuCount: () => 8,
    networkInterfaces: () => ({
      lo: [{ internal: true, mac: "00:00:00:00:00:00" }],
      eth0: [{ internal: false, mac: "AA:BB:CC:DD:EE:FF" }],
      eth1: [{ internal: false, mac: "11:22:33:44:55:66" }],
    }),
    ...overrides,
  };
}

afterEach(() => {
  resetFreebuffFingerprint();
});

describe("Freebuff fingerprint", () => {
  it("produces the enhanced hash over the exact machine profile", async () => {
    const expectedProfile = {
      system: { manufacturer: "ACME Corp", model: "Lab Box", serial: "SN-1", uuid: "UUID-1" },
      cpu: { manufacturer: "GenuineIntel", brand: "Intel(R) Core(TM) i9", cores: 8, physicalCores: 8 },
      os: { platform: "linux", distro: "Ubuntu 26.04", arch: "arm64", hostname: "lab-host" },
      runtime: { nodeVersion: "v24.0.0", platform: "linux", arch: "arm64", shell: "shell", cpuCount: 8 },
      network: { macAddresses: ["11:22:33:44:55:66", "AA:BB:CC:DD:EE:FF"], interfaceCount: 3 },
      machineId: MACHINE_ID,
      fingerprintVersion: "2.0",
    };
    const expected = `enhanced-${createHash("sha256").update(JSON.stringify(expectedProfile)).digest("base64url")}`;
    await expect(freebuffFingerprintId(deps())).resolves.toBe(expected);
  });

  it("falls back to the legacy codebuff-cli id when no machine id is readable", async () => {
    const id = await freebuffFingerprintId(deps({ readText: () => null }));
    expect(id).toMatch(/^codebuff-cli-[A-Za-z0-9_-]{8}$/);
  });

  it("falls back when the machine id is too short or unknown", async () => {
    await expect(freebuffFingerprintId(deps({ readText: (path) => (path === "/etc/machine-id" ? "abc\n" : FILES[path] ?? null) })))
      .resolves.toMatch(/^codebuff-cli-/);
    await expect(freebuffFingerprintId(deps({ readText: (path) => (path === "/etc/machine-id" ? "unknown\n" : FILES[path] ?? null) })))
      .resolves.toMatch(/^codebuff-cli-/);
  });

  it("caches the identity until reset and tolerates read failures", async () => {
    const first = await freebuffFingerprintId(deps());
    const second = await freebuffFingerprintId(deps({ readText: () => null }));
    expect(second).toBe(first);
    resetFreebuffFingerprint();
    const afterReset = await freebuffFingerprintId(deps({ readText: () => null }));
    expect(afterReset).toMatch(/^codebuff-cli-/);
  });

  it("generates deterministic legacy ids of the documented shape", () => {
    expect(createLegacyFreebuffFingerprintId()).toMatch(/^codebuff-cli-[A-Za-z0-9_-]{8}$/);
    expect(createLegacyFreebuffFingerprintId()).not.toBe(createLegacyFreebuffFingerprintId());
  });
});
