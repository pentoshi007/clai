import { describe, expect, it } from "vitest";
import { looksLongRunning } from "../src/tools/command-intent.js";

describe("command-intent — looksLongRunning", () => {
  it("detects nc listener", () => {
    expect(looksLongRunning("nc -l 4444")).toBe(true);
    expect(looksLongRunning("ncat -l -p 8080")).toBe(true);
  });

  it("detects python http server", () => {
    expect(looksLongRunning("python3 -m http.server 8000")).toBe(true);
    expect(looksLongRunning("python -m http.server")).toBe(true);
  });

  it("detects npm/yarn/pnpm dev servers", () => {
    expect(looksLongRunning("npm run dev")).toBe(true);
    expect(looksLongRunning("yarn dev")).toBe(true);
    expect(looksLongRunning("pnpm dev")).toBe(true);
    expect(looksLongRunning("bun dev")).toBe(true);
  });

  it("detects tail -f", () => {
    expect(looksLongRunning("tail -f /var/log/syslog")).toBe(true);
    expect(looksLongRunning("journalctl -f")).toBe(true);
  });

  it("detects docker compose up", () => {
    expect(looksLongRunning("docker compose up")).toBe(true);
    expect(looksLongRunning("docker-compose up")).toBe(true);
  });

  it("detects flask/uvicorn/rails", () => {
    expect(looksLongRunning("flask run --port 5000")).toBe(true);
    expect(looksLongRunning("uvicorn app:main")).toBe(true);
    expect(looksLongRunning("rails server")).toBe(true);
    expect(looksLongRunning("rails s")).toBe(true);
  });

  it("does NOT flag simple commands", () => {
    expect(looksLongRunning("ls -la")).toBe(false);
    expect(looksLongRunning("cat file.txt")).toBe(false);
    expect(looksLongRunning("grep -r pattern .")).toBe(false);
    expect(looksLongRunning("nmap -sn 192.168.1.0/24")).toBe(false);
  });

  it("does NOT flag short-lived commands", () => {
    expect(looksLongRunning("echo hello")).toBe(false);
    expect(looksLongRunning("whoami")).toBe(false);
    expect(looksLongRunning("curl -s ifconfig.me")).toBe(false);
  });

  it("detects vite but not vite build", () => {
    expect(looksLongRunning("vite")).toBe(true);
    expect(looksLongRunning("vite build")).toBe(false);
  });
});
