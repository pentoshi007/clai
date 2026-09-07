import { describe, expect, it } from "vitest";
import { ffufReducer } from "../src/tools/reducers/ffuf.js";
import { gobusterReducer } from "../src/tools/reducers/gobuster.js";
import { httpxReducer } from "../src/tools/reducers/httpx.js";
import { nmapReducer } from "../src/tools/reducers/nmap.js";
import { nucleiReducer } from "../src/tools/reducers/nuclei.js";
import { sqlmapReducer } from "../src/tools/reducers/sqlmap.js";
import { subdomainsReducer } from "../src/tools/reducers/subdomains.js";
import {
  hasStructuredReducer,
  pickReducer,
  reduceToolOutput,
} from "../src/tools/policies/output-policy.js";
import {
  failureSummaryLine,
  formatToolContext,
} from "../src/agent/tool-output-formatting.js";

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
  it("groups hits and prefers non-404 when mixed", () => {
    const raw = `
/missing                [Status: 404, Size: 10, Words: 1, Lines: 1, Duration: 1ms]
/missing2               [Status: 404, Size: 10, Words: 1, Lines: 1, Duration: 1ms]
/admin                  [Status: 301, Size: 169, Words: 4, Lines: 9, Duration: 12ms]
/login                  [Status: 200, Size: 1024, Words: 100, Lines: 50, Duration: 18ms]
/about                  [Status: 200, Size: 1024, Words: 100, Lines: 50, Duration: 18ms]
`;
    const out = ffufReducer(raw, ctx);
    expect(out.summary).toMatch(/interesting result/);
    expect(out.summary).toMatch(/status=200 length=1024/);
    expect(out.summary).toMatch(/status=301 length=169/);
    expect(out.summary).toMatch(/404/);
    expect(out.summary).not.toMatch(/\/missing /);
  });
});

describe("phase 5 — gobuster reducer", () => {
  it("groups paths by status and can omit 404 noise", () => {
    const raw = `
/admin                (Status: 301) [Size: 169]
/login                (Status: 200) [Size: 1024]
/secret               (Status: 403) [Size: 512]
/nope                 (Status: 404) [Size: 19]
`;
    const out = gobusterReducer(raw, ctx);
    expect(out.summary).toMatch(/Status 200/);
    expect(out.summary).toMatch(/Status 403/);
    expect(out.summary).toMatch(/404 omitted|Status 404/);
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
      JSON.stringify({
        url: "https://a.com",
        status_code: 200,
        title: "A",
        content_length: 1234,
      }),
      JSON.stringify({
        url: "https://b.com",
        status_code: 301,
        tech: ["nginx"],
      }),
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
      JSON.stringify({
        "template-id": "exposed-config",
        info: { severity: "high", name: "Exposed Config" },
        "matched-at": "https://a.com/.env",
      }),
      JSON.stringify({
        "template-id": "default-creds",
        info: { severity: "critical", name: "Default creds" },
        "matched-at": "https://b.com/admin",
      }),
      JSON.stringify({
        "template-id": "tech-detect",
        info: { severity: "info", name: "Tech" },
        "matched-at": "https://c.com/",
      }),
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

describe("output policy — no generic keyword reducer", () => {
  it("picks nmap reducer for shell.exec running nmap", () => {
    expect(
      pickReducer({ toolName: "shell.exec", command: "nmap -sV example.com" }),
    ).toBe(nmapReducer);
  });
  it("picks ffuf reducer for shell.exec running ffuf", () => {
    expect(
      pickReducer({
        toolName: "shell.exec",
        command: "ffuf -u https://x/FUZZ -w list",
      }),
    ).toBe(ffufReducer);
  });
  it("returns null for ordinary shell (no keyword ranker)", () => {
    expect(
      pickReducer({ toolName: "shell.exec", command: "whoami" }),
    ).toBeNull();
    expect(
      hasStructuredReducer({ toolName: "shell.exec", command: "ls -la" }),
    ).toBe(false);
  });
  it("reduceToolOutput identity for unknown commands", () => {
    const raw = "hello world\nline 2";
    const result = reduceToolOutput(raw, {
      toolName: "shell.exec",
      command: "echo hello",
    });
    expect(result.summary).toBe(raw);
  });
  it("reduceToolOutput nmap summary still works", () => {
    const result = reduceToolOutput(
      "Nmap scan report for example.com (1.2.3.4)\n22/tcp open ssh\n",
      { toolName: "shell.exec", command: "nmap" },
    );
    expect(result.summary).toMatch(/nmap reduced summary/);
  });
  it("failureSummaryLine prefers command-not-found over echo banners", () => {
    const line = failureSummaryLine({
      ok: false,
      exitCode: 127,
      output: [
        "=== cwd contents ===",
        "total 32",
        "=== yarn ===",
        "/bin/sh: yarn: command not found",
      ].join("\n"),
    });
    expect(line).toMatch(/exit=127/);
    expect(line).toMatch(/command not found/i);
    expect(line).toMatch(/yarn/);
    expect(line).not.toMatch(/=== cwd contents ===/);
  });

  it("formatToolContext keeps ordinary shell bodies without omit headers", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const ctxOut = formatToolContext(
      { name: "shell.exec", args: { command: "seq 40" } },
      { ok: true, output: body, exitCode: 0 },
    );
    expect(ctxOut).toContain("line 0");
    expect(ctxOut).not.toMatch(/Reduced output/i);
    expect(ctxOut).not.toMatch(/lines omitted/i);
  });
  it("formatToolContext keeps fs.list verbatim", () => {
    const ctxOut = formatToolContext(
      { name: "fs.list", args: { path: "/tmp" } },
      {
        ok: true,
        output: "file a\nfile b\nfile c",
        exitCode: 0,
      },
    );
    expect(ctxOut).toContain("file a");
    expect(ctxOut).toContain("file c");
  });
});
