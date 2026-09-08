import { describe, expect, it } from "vitest";

import { ProviderError } from "../../src/llm/http.js";
import {
  classifyResponsesFailure,
} from "../../src/llm/wire/responses-failure.js";

function gatewayError(status: number, message: string): ProviderError {
  return new ProviderError(
    `Provider request failed with HTTP ${status} — full response: ${message}`,
    status,
    JSON.stringify({ error: { message } }),
  );
}

describe("classifyResponsesFailure", () => {
  it("classifies a pinned-temperature rejection as unsupported extras", () => {
    const error = gatewayError(
      400,
      "The value 0.2 for 'temperature' is not supported by this model route. Supported values are between 1.0 and 1.0.",
    );
    expect(classifyResponsesFailure(error, "full")).toBe("unsupported-extras");
  });

  it("classifies a top_p rejection as unsupported extras", () => {
    const error = gatewayError(
      400,
      "The value 0.9 for 'top_p' is not supported by this model route.",
    );
    expect(classifyResponsesFailure(error, "full")).toBe("unsupported-extras");
  });

  it("does not downgrade again once the request is already bare", () => {
    const error = gatewayError(
      400,
      "The value 0.2 for 'temperature' is not supported by this model route.",
    );
    expect(classifyResponsesFailure(error, "bare")).toBe("other");
  });

  it("still classifies include and store rejections as unsupported extras", () => {
    const include = gatewayError(
      400,
      "Invalid parameter: 'include' requires one homogeneous native Responses reasoning-carrier route.",
    );
    expect(classifyResponsesFailure(include, "full")).toBe("unsupported-extras");
    const store = gatewayError(400, "Unsupported parameter: 'store'.");
    expect(classifyResponsesFailure(store, "full")).toBe("unsupported-extras");
  });

  it("leaves the output-identity rejection unclassified", () => {
    const error = gatewayError(
      400,
      "Invalid value for 'input.4': Responses output message phase requires output identity.",
    );
    expect(classifyResponsesFailure(error, "full")).toBe("other");
  });

  it("classifies missing endpoints as unsupported", () => {
    const error = gatewayError(404, "Unknown request URL.");
    expect(classifyResponsesFailure(error, "full")).toBe("unsupported-endpoint");
  });
});
