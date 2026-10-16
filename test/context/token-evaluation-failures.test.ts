import { expect, it } from "vitest";
import { evaluationFailure } from "../../scripts/token-evaluation-failures.js";

it("retains bounded actionable provider errors without retaining reflected secrets or whole response bodies", async () => {
  const response = new Response(JSON.stringify({ error: { message: "Invalid max_tokens; credential=synthetic-sensitive-value sk-secret-value", unrelated: "do not retain" }, other: "do not retain" }), { status: 400 });
  const result = await evaluationFailure(response, ["synthetic-sensitive-value"]);
  expect(result.message).toContain("Invalid max_tokens");
  expect(result.bodySha256).toHaveLength(64);
  expect(JSON.stringify(result)).not.toContain("synthetic-sensitive-value");
  expect(JSON.stringify(result)).not.toContain("sk-secret-value");
  expect(JSON.stringify(result)).not.toContain("do not retain");
  expect(await response.json()).toHaveProperty("error");
});
it("keeps non-JSON, giant and absent failure detail explicitly unknown", async () => {
  expect((await evaluationFailure(new Response("not JSON"), [])).message).toBeNull();
  expect((await evaluationFailure(new Response("x".repeat(100_000)), [])).message).toBeNull();
  const result = await evaluationFailure(new Response(JSON.stringify({ error: { message: "x".repeat(1000) } })), []);
  expect(result.message).toHaveLength(512);
});
