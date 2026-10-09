import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultOAuthTokenStore, oauthTokenKey } from "../../src/mcp/auth/token-store.js";

const worker = fileURLToPath(new URL("./fixtures/storage-worker.mjs", import.meta.url));
let directory: string;
let server: Server | undefined;
const priorDataDir = process.env.CLAI_DATA_DIR;
const priorKeychain = process.env.CLAI_DISABLE_KEYCHAIN;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "clai-mcp-process-store-"));
  process.env.CLAI_DATA_DIR = join(directory, "data");
  process.env.CLAI_DISABLE_KEYCHAIN = "1";
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  rmSync(directory, { recursive: true, force: true });
  if (priorDataDir === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = priorDataDir;
  if (priorKeychain === undefined) delete process.env.CLAI_DISABLE_KEYCHAIN;
  else process.env.CLAI_DISABLE_KEYCHAIN = priorKeychain;
});

function runWorker(mode: string, target: string, issuer: string): Promise<{ stdout: string }> {
  return execa(process.execPath, ["--import", "tsx", worker, mode, target, issuer], {
    timeout: 15_000,
  });
}

describe("MCP storage across processes", () => {
  it("retains every config entry written by separate terminals", async () => {
    await Promise.all(
      ["first", "second", "third"].map((prefix) => runWorker("config", directory, prefix)),
    );
    const config = JSON.parse(readFileSync(join(directory, ".clai", "mcp.json"), "utf8"));
    expect(Object.keys(config.servers).sort()).toEqual(
      ["first", "second", "third"].flatMap((prefix) =>
        Array.from({ length: 4 }, (_, index) => `${prefix}-${index}`),
      ),
    );
  }, 20_000);

  it("rotates a refresh token once while separate terminals authenticate together", async () => {
    let issuer = "";
    let rotations = 0;
    const metadataWaiters: ServerResponse[] = [];
    const metadata = (): string =>
      JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
      });
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.includes(".well-known")) {
        metadataWaiters.push(response);
        if (metadataWaiters.length === 3) {
          for (const waiter of metadataWaiters) waiter.end(metadata());
        }
        return;
      }
      if (request.url === "/token") {
        rotations++;
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const form = new URLSearchParams(body);
          if (form.get("refresh_token") !== "single-use" || rotations !== 1) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: "invalid_grant" }));
          } else {
            response.end(
              JSON.stringify({
                access_token: "rotated-access",
                refresh_token: "rotated-refresh",
                token_type: "Bearer",
                expires_in: 3600,
              }),
            );
          }
        });
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const resource = `${issuer}/mcp`;
    const key = oauthTokenKey(resource, issuer);
    await defaultOAuthTokenStore.save(key, {
      accessToken: "expired-access",
      refreshToken: "single-use",
      tokenType: "Bearer",
      clientId: "client",
      issuer,
      expiresAt: 1,
    });
    const results = await Promise.all(
      Array.from({ length: 3 }, () => runWorker("refresh", resource, issuer)),
    );
    expect(rotations).toBe(1);
    expect(results.map(({ stdout }) => JSON.parse(stdout))).toEqual(
      Array.from({ length: 3 }, () => ({
        authorization: "Bearer rotated-access",
      })),
    );
    expect((await defaultOAuthTokenStore.load(key))?.refreshToken).toBe("rotated-refresh");
  }, 20_000);
});
