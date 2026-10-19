import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleCreds } from "../../src/ui-core/commands/credential-commands.js";
import { getCredential, getMachineSudoPassword, listCredentials } from "../../src/store/credentials.js";
import { resetKnownSecrets } from "../../src/security/known-secrets.js";
import { createHarness } from "../classic/panels/harness.js";

let root: string;
let harness: ReturnType<typeof createHarness>;
const original = process.env.CLAI_DATA_DIR;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-creds-ui-"));
  process.env.CLAI_DATA_DIR = root;
  harness = createHarness();
});
afterEach(async () => {
  harness.panels.dispose();
  harness.overlay.dispose();
  resetKnownSecrets();
  if (original === undefined) delete process.env.CLAI_DATA_DIR;
  else process.env.CLAI_DATA_DIR = original;
  await rm(root, { recursive: true, force: true });
});
const notice = vi.fn();
function services() { return { overlay: harness.overlay, session: { notice } }; }
async function editor() { await expect.poll(() => harness.overlay.getState().kind).toBe("text-editor"); }

describe("shared /creds command", () => {
  it("creates freeform entries using the same overlay in both UIs and preserves classic pasted tabs", async () => {
    await handleCreds(services());
    harness.overlay.selectPicker("add");
    await editor();
    harness.overlay.answerTextEditor("Cloud login");
    await editor();
    expect(harness.handlePasteThroughPanels("host: localhost\n\tuser: deploy\npassword: ui-private-fixture\n")).toBe(true);
    expect(harness.panels.getSnapshot().textEditor.editor.text).toContain("\tuser");
    harness.press("ctrl+s");
    await expect.poll(async () => (await listCredentials()).length).toBe(1);
    const entry = (await listCredentials())[0]!;
    expect((await getCredential(entry.id))?.content).toBe("host: localhost\n\tuser: deploy\npassword: ui-private-fixture\n");
    expect(JSON.stringify(notice.mock.calls)).not.toContain("ui-private-fixture");
  });

  it("cancels title or body without writing partial entries", async () => {
    await handleCreds(services());
    harness.overlay.selectPicker("add");
    await editor();
    harness.overlay.answerTextEditor(undefined);
    await Promise.resolve();
    expect(await listCredentials()).toEqual([]);
    await handleCreds(services());
    harness.overlay.selectPicker("add");
    await editor();
    harness.overlay.answerTextEditor("Cancelled body");
    await editor();
    harness.overlay.answerTextEditor(undefined);
    await Promise.resolve();
    expect(await listCredentials()).toEqual([]);
  });

  it("uses a masked machine-password form and supports confirmed removal", async () => {
    await handleCreds(services());
    harness.overlay.selectPicker("sudo");
    await expect.poll(() => harness.overlay.getState().kind).toBe("secret");
    harness.overlay.answerSecret("ui-sudo-fixture");
    await expect.poll(getMachineSudoPassword).toBe("ui-sudo-fixture");
    await handleCreds(services());
    harness.overlay.selectPicker("delete-sudo");
    await expect.poll(() => harness.overlay.getState().kind).toBe("confirm");
    harness.overlay.answerConfirm(true);
    await expect.poll(getMachineSudoPassword).toBeUndefined();
  });
});
