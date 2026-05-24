import { describe, expect, it } from "vitest";
import { ffufReducer } from "../src/tools/reducers/ffuf.js";
import { genericReducer } from "../src/tools/reducers/generic.js";
import { gobusterReducer } from "../src/tools/reducers/gobuster.js";
import { httpxReducer } from "../src/tools/reducers/httpx.js";
import { nmapReducer } from "../src/tools/reducers/nmap.js";
import { nucleiReducer } from "../src/tools/reducers/nuclei.js";
import { sqlmapReducer } from "../src/tools/reducers/sqlmap.js";
import { subdomainsReducer } from "../src/tools/reducers/subdomains.js";
import { pickReducer, reduceToolOutput } from "../src/tools/policies/output-policy.js";

const ctx = { command: "test" } as const;

describe("phase 5 — nmap reducer", () => {
  it("parses ports + service + version", () => {
    const raw = `Starting Nmap 7.94
Nmap scan report for scanme.nmap.org (45.33.32.156)
Host is up (0.014s latency).
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 6.6.1p1 Ubuntu 2ubuntu2.13
80/tcp   open  http    Apache httpd 2.4.7
443/tcp  closed https
9929/tcp open  nping-echo Nping echo
Nmap done: 1 IP address (1 host up) scanned in 14.30 seconds`;
    const out = nmapReducer(raw, ctx);
    expect(out.summary).toMatch(/3 open port/);
    expect(out.summary).toMatch(/22\/tcp/);
    expect(out.summary).toMatch(/OpenSSH/);
    expect(out.summary).toMatch(/Nmap done/);
  });
});

describe("phase 5 — ffuf reducer", () => {
  it("groups text output by (status,length)", () => {
    const raw = `
/admin                  [Status: 301, Size: 169, Words: 4, Lines: 9, Duration: 12ms]
/login                  [Status: 200, Size: 1024, Words: 100, Lines: 50, Duration: 18ms]
/about                  [Status: 200, Size: 1024, Words: 100, Lines: 50, Duration: 18ms]
/contact                [Status: 200, Size: 1024, Words: 100, Lines: 50, Duration: 18ms]
`;
    const out = ffufReducer(raw, ctx);
    expect(out.summary).toMatch(/4 result/);
    expect(out.summary).toMatch(/status=200 length=1024/);
    expect(out.summary).toMatch(/status=301 length=169/);
  });
});

describe("phase 5 — gobuster reducer", () => {
  it("groups paths by status", () => {
    const raw = `
/admin                (Status: 301) [Size: 169]
/login                (Status: 200) [Size: 1024]
/secret               (Status: 403) [Size: 512]
`;
    const out = gobusterReducer(raw, ctx);
    expect(out.summary).toMatch(/3 status code/);
    expect(out.summary).toMatch(/Status 200/);
    expect(out.summary).toMatch(/Status 403/);
  });
});

describe("phase 5 — subdomains reducer", () => {
  it("dedups and sorts", () => {
    const raw = `
api.example.com
www.example.com
api.example.com
mail.example.com
not-a-domain
`;
    const out = subdomainsReducer(raw, ctx);
    expect(out.summary).toMatch(/3 unique domain/);
    expect(out.summary).toMatch(/api\.example\.com/);
    expect(out.summary).not.toMatch(/not-a-domain/);
  });
});

describe("phase 5 — httpx reducer", () => {
  it("parses JSONL rows", () => {
    const raw = [
      JSON.stringify({ url: "https://a.com", status_code: 200, title: "A", content_length: 1234 }),
      JSON.stringify({ url: "https://b.com", status_code: 301, tech: ["nginx"] }),
    ].join("\n");
    const out = httpxReducer(raw, ctx);
    expect(out.summary).toMatch(/2 URL/);
    expect(out.summary).toMatch(/https:\/\/a\.com \[200\]/);
    expect(out.summary).toMatch(/tech=\[nginx\]/);
  });
});

describe("phase 5 — nuclei reducer", () => {
  it("groups by severity", () => {
    const raw = [
      JSON.stringify({ "template-id": "exposed-config", info: { severity: "high", name: "Exposed Config" }, "matched-at": "https://a.com/.env" }),
      JSON.stringify({ "template-id": "default-creds", info: { severity: "critical", name: "Default creds" }, "matched-at": "https://b.com/admin" }),
      JSON.stringify({ "template-id": "tech-detect", info: { severity: "info", name: "Tech" }, "matched-at": "https://c.com/" }),
    ].join("\n");
    const out = nucleiReducer(raw, ctx);
    expect(out.summary).toMatch(/3 hit/);
    expect(out.summary).toMatch(/critical=1/);
    expect(out.summary).toMatch(/high=1/);
    expect(out.summary).toMatch(/CRITICAL/);
  });
});

describe("phase 5 — sqlmap reducer", () => {
  it("extracts injectable params and DBMS", () => {
    const raw = `
[12:00:00] [INFO] testing 'id' parameter
Parameter: id (GET)
    Type: boolean-based blind
    Payload: id=1 AND 1=1
[12:00:01] [INFO] the back-end DBMS is MySQL
back-end DBMS: MySQL 5.7
`;
    const out = sqlmapReducer(raw, ctx);
    expect(out.summary).toMatch(/1 injectable/);
    expect(out.summary).toMatch(/id \(GET\)/);
    expect(out.summary).toMatch(/MySQL/);
  });
});

describe("phase 5 — generic reducer ranks lines by signal", () => {
  it("keeps lines mentioning vulnerable / CVE / found", () => {
    const raw = Array.from({ length: 200 }, (_, i) => `boring line ${i}`)
      .concat([
        "WARNING: target may be vulnerable to CVE-2024-1234",
        "[+] found admin credentials",
        "scan complete: 1 host up",
      ])
      .join("\n");
    const out = genericReducer(raw, ctx);
    expect(out.summary).toMatch(/CVE-2024-1234/);
    expect(out.summary).toMatch(/found admin credentials/);
    expect(out.summary).toMatch(/scan complete/);
    expect(out.summary.length).toBeLessThan(raw.length);
  });
});

describe("phase 5 — output policy dispatcher", () => {
  it("picks nmap reducer for net.scan", () => {
    const reducer = pickReducer({ toolName: "net.scan" });
    expect(reducer).toBe(nmapReducer);
  });
  it("picks ffuf reducer for shell.exec running ffuf", () => {
    const reducer = pickReducer({ toolName: "shell.exec", command: "ffuf -u https://x/FUZZ -w list" });
    expect(reducer).toBe(ffufReducer);
  });
  it("picks generic reducer for unknown commands", () => {
    const reducer = pickReducer({ toolName: "shell.exec", command: "whoami" });
    expect(reducer).toBe(genericReducer);
  });
  it("reduceToolOutput passes through a useful summary", () => {
    const result = reduceToolOutput("Nmap scan report for example.com (1.2.3.4)\n22/tcp open ssh\n", { toolName: "net.scan", command: "nmap" });
    expect(result.summary).toMatch(/nmap reduced summary/);
  });
});
