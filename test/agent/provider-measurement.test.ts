import { describe, expect, it } from "vitest";
import {
  projectMeasuredTokens,
  providerContextMeasurement,
} from "../../src/agent/turn/provider-measurement.js";

describe("provider-grounded context measurement", () => {
  it("reproduces the provider count for the measured request", () => {
    const measurement = providerContextMeasurement(45_000, 40_000)!;
    expect(projectMeasuredTokens(measurement, 40_000)).toBe(45_000);
  });

  it("scales growth and compaction with the observed provider-to-estimate ratio", () => {
    const measurement = providerContextMeasurement(400_000, 320_000)!;
    expect(projectMeasuredTokens(measurement, 336_000)).toBe(420_000);
    expect(projectMeasuredTokens(measurement, 3_200)).toBe(4_000);
  });

  it("rejects unusable measurements", () => {
    expect(providerContextMeasurement(undefined, 1_000)).toBeUndefined();
    expect(providerContextMeasurement(0, 1_000)).toBeUndefined();
    expect(providerContextMeasurement(1_000, 0)).toBeUndefined();
    expect(providerContextMeasurement(Number.NaN, 1_000)).toBeUndefined();
  });

  it("projects nothing for an empty request", () => {
    const measurement = providerContextMeasurement(10_000, 8_000)!;
    expect(projectMeasuredTokens(measurement, 0)).toBe(0);
  });
});
