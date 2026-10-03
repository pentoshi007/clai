import { describe, expect, it } from "vitest";
import {
  looksLikeLongFiniteCommand,
  longFiniteCommandCost,
  looksLongRunning,
} from "../src/tools/command-intent.js";

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
    expect(looksLongRunning("npx vite --host 0.0.0.0")).toBe(true);
    expect(looksLongRunning("cd app && vite --port 5173")).toBe(true);
    expect(looksLongRunning("vite build")).toBe(false);
  });

  it("keeps Vite package operations, file paths, and finite pipelines in the foreground", () => {
    expect(looksLongRunning("npm install vite")).toBe(false);
    expect(looksLongRunning("npm install -D @vitejs/plugin-react")).toBe(false);
    expect(looksLongRunning("npm view vite version")).toBe(false);
    expect(looksLongRunning("cat src/vite.config.ts")).toBe(false);
    expect(looksLongRunning("rm -rf .vite-tmp && ls -la")).toBe(false);
    expect(
      looksLongRunning("npm install vite 2>&1 | tail -20"),
    ).toBe(false);
  });

  it("does not confuse server-named dependency arguments with running servers", () => {
    expect(looksLongRunning("npm install nodemon postgres")).toBe(false);
    expect(looksLongRunning("pnpm add redis-server")).toBe(false);
    expect(looksLongRunning("yarn add uvicorn")).toBe(false);
    expect(looksLongRunning("bun add vite")).toBe(false);
  });

  it("keeps wrapped and option-prefixed package operations in the foreground", () => {
    expect(looksLongRunning("npm --silent install nodemon")).toBe(false);
    expect(looksLongRunning("npm --workspace web install postgres")).toBe(false);
    expect(looksLongRunning("env CI=1 npm install redis-server")).toBe(false);
    expect(looksLongRunning("sudo -u root npm install uvicorn")).toBe(false);
    expect(looksLongRunning("corepack pnpm add postgres")).toBe(false);
  });

  it("still recognizes a persistent segment after a finite install", () => {
    expect(looksLongRunning("npm install && npm run dev")).toBe(true);
    expect(looksLongRunning("npm install vite && npx vite")).toBe(true);
  });
});

describe("command-intent — finite cost classification", () => {
  it("identifies potentially long scanners and filesystem searches without scheduling them", () => {
    expect(looksLikeLongFiniteCommand("nmap -sV example.com")).toBe(true);
    expect(looksLikeLongFiniteCommand("ffuf -u https://x/FUZZ -w words.txt")).toBe(true);
    expect(looksLikeLongFiniteCommand("sudo find / -name '*.pem'")).toBe(true);
    expect(looksLikeLongFiniteCommand("npm install")).toBe(false);
    expect(looksLikeLongFiniteCommand("echo find me")).toBe(false);
  });
});


describe("command-intent — cost signals do not choose execution mode", () => {
  it("does not mark cheap scanner/search invocations as costly", () => {
    for (const command of [
      "nmap -p22 --top-ports 1 10.0.0.5",
      "nmap -p 22,80,443 10.0.0.5",
      "nmap --version",
      "sqlmap --version",
      "find . -name '*.ts'",
      "find src -name '*.tsx'",
      "gobuster --help",
    ]) {
      expect(longFiniteCommandCost(command).reason).toBeUndefined();
    }
  });

  it("identifies costly invocations without backgrounding them", () => {
    for (const command of [
      "nmap -p- 10.0.0.5",
      "nmap -sV example.com",
      "nmap --script default 10.0.0.5",
      "nmap -p22 10.0.0.0/24",
      "ffuf -u https://x/FUZZ -w words.txt",
      "gobuster dir -u https://x -w big.txt",
      "find / -name '*.pem'",
      "find . -exec grep TODO {} ;",
      "sqlmap -u https://x/?id=1",
    ]) {
      expect(longFiniteCommandCost(command).reason).toBeTruthy();
    }
  });
});
