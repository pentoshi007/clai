import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { registerKnownSecret, resetKnownSecrets } from "../src/security/known-secrets.js";
import { RotatingRedactedWriter } from "../src/tools/jobs/redacted-writer.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "clai-job-preview-"));
  const receipt = { path: join(dir, "output.log"), chunks: [], bytes: 0, droppedBytes: 0, redacted: false, sha256: "" };
  const writer = new RotatingRedactedWriter(receipt);
  return { dir, receipt, writer };
}

it("previews complete UTF-8 across chunks without advancing the artifact cursor", async () => {
  const { dir, receipt, writer } = await fixture();
  try {
    const bytes = Buffer.from("progress 🌱\rphase two");
    writer.append(bytes.subarray(0, 11));
    expect(writer.preview()).toBe("progress ");
    writer.append(bytes.subarray(11));
    expect(writer.preview()).toBe("progress 🌱\rphase two");
    expect(receipt.bytes).toBe(0);
    await writer.close();
    expect(writer.preview()).toBe("");
    expect(receipt.bytes).toBe(bytes.length);
    expect(await readFile(receipt.path)).toEqual(bytes);
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not disclose split or incomplete secret material in the live preview", async () => {
  const { dir, receipt, writer } = await fixture();
  registerKnownSecret("opaque-fixture-value");
  try {
    writer.append("progress opaque-fixture");
    expect(writer.preview()).toBe("");
    writer.append("-value");
    expect(writer.preview()).toBe("progress [redacted]");
    writer.append("\nprogress wk-1234");
    expect(writer.preview()).toBe("progress wk-••••••");
    writer.append("567890abcdef\n");
    expect(writer.preview()).toBe("");
    await writer.close();
    expect(await readFile(receipt.path, "utf8")).toBe("progress [redacted]\nprogress wk-••••••\n");
    expect(receipt.redacted).toBe(true);
  } finally {
    resetKnownSecrets();
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("suppresses a preview when its redaction context was split off a long line", async () => {
  const { dir, receipt, writer } = await fixture();
  try {
    writer.append("x".repeat(4097));
    expect(receipt.bytes).toBe(1);
    expect(writer.preview()).toBe("");
    writer.append("\nnext update");
    expect(writer.preview()).toBe("next update");
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
