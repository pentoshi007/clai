import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { setProviderSecret } from "../../src/store/keys.js";
import { keysFile } from "../../src/store/keys/secret-store.js";

describe("test sandbox", () => {
  it("runs with a home directory outside the developer's real home", () => {
    expect(homedir().startsWith(tmpdir())).toBe(true);
    expect(process.env.USERPROFILE).toBe(homedir());
  });

  it("keeps the operating system keychain out of the run", () => {
    expect(process.env.CLAI_DISABLE_KEYCHAIN).toBe("1");
  });

  it("stores provider keys inside the sandbox", async () => {
    expect(keysFile.startsWith(homedir())).toBe(true);
    await setProviderSecret("openai", "sk-sandbox-check");
    expect(await readFile(keysFile, "utf8")).toContain("sk-sandbox-check");
  });
});
