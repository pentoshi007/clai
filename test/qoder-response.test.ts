import { describe, expect, it } from "vitest";
import { extractQoderStreamBody, parseQoderQueueStatus, qoderModelQueuedError, qoderResponseError } from "../src/llm/qoder/qoder-response.js";
import { isAuthKeyError } from "../src/llm/key-rotation.js";

const queue = { isQueued: true, serviceAvailable: false, modelKey: "qfmodel", queueType: "p3", retryAfterSeconds: 30 };

describe("Qoder response decoding", () => {
  it.each(["message", "body", "data", "result", "error"])("decodes nested stringified queue metadata in %s", (field) => {
    const raw = JSON.stringify({ code: "403", [field]: JSON.stringify({ code: "10605", [field]: JSON.stringify(queue) }) });
    expect(parseQoderQueueStatus(raw)).toEqual(expect.objectContaining(queue));
    const error = qoderResponseError(403, raw);
    expect(error).toMatchObject({ status: 503, wireStatus: 403, body: raw, retryAfterSeconds: 30 });
    expect(isAuthKeyError(error)).toBe(false);
  });

  it("recognizes numeric queue codes and stringified numeric hints", () => {
    const raw = JSON.stringify({ code: 10605, data: { ...queue, retryAfterSeconds: "2.5", queueCount: "0" } });
    expect(qoderModelQueuedError(403, raw)?.queue).toMatchObject({ retryAfterSeconds: 2.5, queueCount: 0 });
  });

  it.each([-1, "Infinity", "bad", null, true])("rejects invalid retry hints: %s", (retryAfterSeconds) => {
    expect(parseQoderQueueStatus(JSON.stringify({ ...queue, retryAfterSeconds }))?.retryAfterSeconds).toBeUndefined();
  });

  it("does not mistake a ready queue or text mentioning a queue code for a queue failure", () => {
    expect(qoderModelQueuedError(200, '{"isQueued":false,"serviceAvailable":true}')).toBeUndefined();
    const raw = JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ code: "10605", message: queue }) } }] });
    expect(extractQoderStreamBody(raw)).toBe(raw);
    expect(qoderModelQueuedError(200, raw)).toBeUndefined();
  });

  it("handles queue admission failures carried inside successful stream wrappers", () => {
    const raw = JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ code: "10605", message: JSON.stringify(queue) }) });
    expect(() => extractQoderStreamBody(raw)).toThrow(/queued/);
  });

  it("preserves genuine authentication failure detail through nested response bodies", () => {
    const raw = JSON.stringify({ code: "403", message: JSON.stringify({ message: "access token expired" }) });
    const error = qoderResponseError(403, raw);
    expect(error).toMatchObject({ status: 403, body: raw });
    expect(error.message).toContain("access token expired");
    expect(isAuthKeyError(error)).toBe(true);
  });

  it.each(["not json", "null", "[]", "42"])("handles malformed or irrelevant payloads: %s", (raw) => {
    expect(parseQoderQueueStatus(raw)).toBeUndefined();
    expect(extractQoderStreamBody(raw)).toBeUndefined();
    expect(qoderResponseError(403, raw).status).toBe(403);
  });

  it("extracts direct usage-only stream frames", () => {
    const raw = '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}';
    expect(extractQoderStreamBody(raw)).toBe(raw);
  });
});
