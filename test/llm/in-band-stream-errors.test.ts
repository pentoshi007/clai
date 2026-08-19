import { describe, expect, it } from "vitest";

import {
  inBandBadRequestStatus,
  isUnattributableRequestBodyError,
  mentionsReasoning,
} from "../../src/llm/reasoning-errors.js";
import { ProviderError } from "../../src/llm/http.js";

const REPORTED_FRAME = {
  type: "bad_request",
  message:
    "The model rejected this request. It may not support the input you sent (e.g. images on a text-only model) or a parameter is invalid.",
};

describe("an in-band error frame is graded like the status it stands for", () => {
  it("reads the reported bynara frame as a bad request", () => {
    expect(inBandBadRequestStatus(REPORTED_FRAME)).toBe(400);
  });

  it("leaves an unrelated in-band failure unclassified", () => {
    expect(
      inBandBadRequestStatus({ type: "server_error", message: "upstream overloaded" }),
    ).toBeUndefined();
  });

  it("names no reasoning field, so the cause is unattributable", () => {
    const error = new ProviderError(
      `Bynara stream error: ${REPORTED_FRAME.message}`,
      inBandBadRequestStatus(REPORTED_FRAME),
      JSON.stringify({ error: REPORTED_FRAME }),
    );
    expect(mentionsReasoning(error)).toBe(false);
    expect(isUnattributableRequestBodyError(error)).toBe(true);
  });

  it("stays unattributable-free when the frame does name a reasoning knob", () => {
    const error = new ProviderError(
      "stream error: Extra inputs are not permitted, field: 'enable_thinking'",
      inBandBadRequestStatus({
        type: "bad_request",
        message: "Extra inputs are not permitted, field: 'enable_thinking'",
      }),
      "",
    );
    expect(isUnattributableRequestBodyError(error)).toBe(false);
  });

  it("carries no status when the frame is only a plain message", () => {
    const error = new ProviderError("stream error: unknown error", undefined, "");
    expect(isUnattributableRequestBodyError(error)).toBe(false);
  });
});
