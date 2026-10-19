import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteCredential, getCredential, getMachineSudoPassword, listCredentials, machineSudoId, saveCredential, setMachineSudoPassword } from "../src/store/credentials.js";
import { resetKnownSecrets } from "../src/security/known-secrets.js";
import { redactSecretsCached, resetRedactionCache } from "../src/store/redaction-cache.js";
import { credentialTools } from "../src/tools/credentials.js";
import { getToolDefinitions } from "../src/tools/definitions/selection.js";

let root: string;
const original = process.env.CLAI_DATA_DIR;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-credentials-"));
  process.env.CLAI_DATA_DIR = root;
  resetKnownSecrets();
  resetRedactionCache();
});
afterEach(async () => {
  if (original === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = original;
  resetKnownSecrets();
  await rm(root, { recursive: true, force: true });
});

const body = "user: deploy\npassword: quoted-\"fixture\"-🙂\n\tHost cloud\n  HostName 127.0.0.1\n-----BEGIN OPENSSH PRIVATE KEY-----\nYWJjZGVmZw==\n-----END OPENSSH PRIVATE KEY-----\n";

describe("encrypted credential vault", () => {
  it("reads an absent store without creating files", async () => {
    expect(await listCredentials()).toEqual([]);
    expect(await getMachineSudoPassword()).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  it("preserves arbitrary multiline and tabbed text through CRUD and reload", async () => {
    const id = await saveCredential({ title: "Cloud access", content: body });
    expect(await getCredential(id)).toMatchObject({ id, title: "Cloud access", content: body, kind: "freeform" });
    expect(await listCredentials()).toEqual([expect.objectContaining({ id, title: "Cloud access" })]);
    expect(JSON.stringify(await listCredentials())).not.toContain("quoted-");
    const files = await readdir(join(root, "credentials"));
    expect(files.sort()).toEqual(["master.key", "vault.json"]);
    const encrypted = await readFile(join(root, "credentials", "vault.json"), "utf8");
    expect(encrypted).not.toContain("Cloud access");
    expect(encrypted).not.toContain("deploy");
    expect(encrypted).not.toContain("PRIVATE KEY");
    if (process.platform !== "win32") {
      expect((await stat(join(root, "credentials", "master.key"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "credentials", "vault.json"))).mode & 0o777).toBe(0o600);
    }
    await saveCredential({ id, title: "Renamed", content: `${body}extra` });
    expect(await getCredential(id)).toMatchObject({ title: "Renamed", content: `${body}extra` });
    await deleteCredential(id);
    expect(await listCredentials()).toEqual([]);
  });

  it("serializes competing writes without lost entries or history-lock coupling", async () => {
    await writeFile(join(root, "history.jsonl.lock"), `${process.pid}-busy`);
    const ids = await Promise.all(Array.from({ length: 12 }, (_, index) => saveCredential({ title: `Entry ${index}`, content: `private-fixture-${index}` })));
    expect(await listCredentials()).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    await Promise.all(ids.slice(0, 6).map(deleteCredential));
    expect(await listCredentials()).toHaveLength(6);
  });

  it.each(["missing key", "wrong key", "damaged vault"])("fails closed for %s, without replacing existing data", async (scenario) => {
    await saveCredential({ title: "Keep me", content: body });
    const path = join(root, "credentials", "vault.json");
    const key = join(root, "credentials", "master.key");
    if (scenario === "missing key") await unlink(key);
    if (scenario === "wrong key") await writeFile(key, Buffer.alloc(32, 7).toString("base64"));
    if (scenario === "damaged vault") await writeFile(path, "{broken");
    const before = await readFile(path, "utf8");
    await expect(listCredentials()).rejects.toThrow(/vault|key/i);
    await expect(saveCredential({ title: "Do not overwrite", content: "unused" })).rejects.toThrow(/vault|key/i);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("reserves machine sudo from model retrieval and supports replacement/deletion", async () => {
    await setMachineSudoPassword(" sudo-fixture with spaces ");
    expect(await getMachineSudoPassword()).toBe(" sudo-fixture with spaces ");
    expect(await getCredential(machineSudoId())).toBeUndefined();
    expect((await credentialTools["creds.get"]!({ id: machineSudoId() })).ok).toBe(false);
    const listing = await credentialTools["creds.list"]!({});
    expect(listing.output).toContain('"machineSudoConfigured":true');
    expect(listing.output).not.toContain("sudo-fixture");
    await setMachineSudoPassword("replacement-fixture");
    expect(await getMachineSudoPassword()).toBe("replacement-fixture");
    await deleteCredential(machineSudoId());
    expect(await getMachineSudoPassword()).toBeUndefined();
  });

  it("invalidates redaction caches without changing the static tool prefix", async () => {
    const text = `This cached output contains quoted-\"fixture\"-🙂 and ${"padding ".repeat(10)}`;
    expect(redactSecretsCached(text)).toBe(text);
    const prefix = JSON.stringify(getToolDefinitions());
    const id = await saveCredential({ title: "Unique title", content: body });
    expect(redactSecretsCached(text)).not.toContain('quoted-"fixture"-🙂');
    const result = await credentialTools["creds.get"]!({ id });
    expect(result.sensitive).toBe(true);
    expect(result.output).toContain("OPENSSH PRIVATE KEY");
    expect(redactSecretsCached(result.output)).not.toContain("YWJjZGVmZw==");
    expect(JSON.stringify(getToolDefinitions())).toBe(prefix);
    expect(prefix).not.toContain("Unique title");
    expect(prefix).not.toContain("quoted-");
  });

  it("rejects invalid writes while retaining existing credentials", async () => {
    const id = await saveCredential({ title: "Retained", content: body });
    await expect(saveCredential({ id, title: "two\nlines", content: body })).rejects.toThrow(/title/);
    await expect(saveCredential({ title: "", content: body })).rejects.toThrow(/title/);
    await expect(saveCredential({ title: "empty", content: "" })).rejects.toThrow(/content/);
    await expect(setMachineSudoPassword("two\nlines")).rejects.toThrow(/single/);
    expect((await getCredential(id))?.content).toBe(body);
  });
});
