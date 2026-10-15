import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { clearModelCatalogFacts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { riverProvider } from "../../src/llm/river.js";
import { RIVER_DEFAULT_MODEL } from "../../src/llm/river-models.js";
import { REQUEST, USAGE } from "./river-fixtures.js";

afterEach(() => {
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});

it("runs River discovery, completion and SSE over a real HTTP transport", async () => {
  const captured: { path: string; authorization: string; body: string }[] = [];
  let generation = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      captured.push({ path: request.url ?? "", authorization: request.headers.authorization ?? "", body });
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{
          id: RIVER_DEFAULT_MODEL, context_length: 900_000,
          supported_reasoning_efforts: ["none", "high", "max"],
        }] }));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      generation += 1;
      if (generation === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "HTTP answer", reasoning_content: "HTTP thinking" }, finish_reason: "stop" }], usage: USAGE }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const payload of [
        { choices: [{ delta: { reasoning_content: "Stream thinking" } }] },
        { choices: [{ delta: { content: "Stream answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: USAGE },
      ]) response.write(`data: ${JSON.stringify(payload)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
    const auth = { apiKey: "rv_http_fixture", baseUrl: `http://127.0.0.1:${address.port}/v1` };
    expect(await riverProvider.listModels!(auth)).toEqual([RIVER_DEFAULT_MODEL]);
    expect(await riverProvider.complete(REQUEST, auth)).toMatchObject({
      text: "HTTP answer", reasoningBlock: { text: "HTTP thinking" }, usage: { cachedPromptTokens: 80, reasoningTokens: 10 },
    });
    const tokens: string[] = [];
    expect(await riverProvider.stream!({ ...REQUEST, thinking: { enabled: true, effort: "max" } }, auth, (token) => tokens.push(token))).toMatchObject({
      text: "Stream answer", reasoningBlock: { text: "Stream thinking" },
    });
    expect(tokens.join("")).toBe("Stream answer");
    expect(captured.map(({ path }) => path)).toEqual(["/v1/models", "/v1/chat/completions", "/v1/chat/completions"]);
    expect(captured.every(({ authorization }) => authorization === "Bearer rv_http_fixture")).toBe(true);
    expect(JSON.parse(captured[2]!.body)).toMatchObject({ stream: true, reasoning_effort: "max" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
