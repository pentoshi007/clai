import { describe, expect, it } from "vitest";
import { netmaskToCidr } from "../src/tools/network-context.js";
import { parseNmapPingSweep, parseArpTable } from "../src/tools/net-ping-sweep.js";

describe("network-context", () => {
  describe("netmaskToCidr", () => {
    it("converts 255.255.255.0 to 24", () => {
      expect(netmaskToCidr("255.255.255.0")).toBe(24);
    });

    it("converts 255.255.0.0 to 16", () => {
      expect(netmaskToCidr("255.255.0.0")).toBe(16);
    });

    it("converts 255.0.0.0 to 8", () => {
      expect(netmaskToCidr("255.0.0.0")).toBe(8);
    });

    it("converts 255.255.255.128 to 25", () => {
      expect(netmaskToCidr("255.255.255.128")).toBe(25);
    });

    it("returns undefined for invalid masks", () => {
      expect(netmaskToCidr("not.a.mask")).toBe(undefined);
      expect(netmaskToCidr("")).toBe(undefined);
    });
  });
});

describe("net-ping-sweep parsers", () => {
  it("parseNmapPingSweep extracts hosts from nmap -sn output", () => {
    const output = `Starting Nmap 7.94 ( https://nmap.org )
Nmap scan report for _gateway (192.168.1.1)
Host is up (0.0030s latency).
MAC Address: AA:BB:CC:DD:EE:FF (Vendor Corp)
Nmap scan report for 192.168.1.100
Host is up (0.0010s latency).
Nmap done: 256 IP addresses (2 hosts up) scanned in 2.5 seconds`;

    const devices = parseNmapPingSweep(output);
    expect(devices).toHaveLength(2);
    expect(devices[0]!.ip).toBe("192.168.1.1");
    expect(devices[0]!.hostname).toBe("_gateway");
    expect(devices[0]!.mac).toBe("AA:BB:CC:DD:EE:FF");
    expect(devices[0]!.vendor).toBe("Vendor Corp");
    expect(devices[0]!.source).toBe("nmap");
    expect(devices[1]!.ip).toBe("192.168.1.100");
    expect(devices[1]!.hostname).toBe(undefined);
  });

  it("parseArpTable extracts devices from arp -a output", () => {
    const output = `? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]
? (192.168.1.100) at 11:22:33:44:55:66 on en0 ifscope [ethernet]
? (192.168.1.200) at (incomplete) on en0 ifscope [ethernet]`;

    const devices = parseArpTable(output);
    expect(devices).toHaveLength(2); // incomplete should be skipped
    expect(devices[0]!.ip).toBe("192.168.1.1");
    expect(devices[0]!.mac).toBe("aa:bb:cc:dd:ee:ff");
    expect(devices[0]!.source).toBe("arp");
    expect(devices[1]!.ip).toBe("192.168.1.100");
  });

  it("parseNmapPingSweep returns empty for no hosts", () => {
    const output = `Starting Nmap 7.94 ( https://nmap.org )
Nmap done: 256 IP addresses (0 hosts up) scanned in 3.0 seconds`;
    expect(parseNmapPingSweep(output)).toHaveLength(0);
  });
});
