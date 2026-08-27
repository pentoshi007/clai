import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = message;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-stdio", version: "1.2.3" },
      },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    if (!params?.cursor) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo the provided text back",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
              annotations: { readOnlyHint: true },
            },
          ],
          nextCursor: "page-2",
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "write_file",
              description: "Write a file",
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
              },
              annotations: { destructiveHint: true },
            },
          ],
        },
      });
    }
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `echo: ${args.text ?? ""}` }] },
      });
    } else if (name === "read_token") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `token=${process.env.MCP_TEST_TOKEN ?? ""}` }],
        },
      });
    } else if (name === "image") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] },
      });
    } else if (name === "boom") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "tool failed" }], isError: true },
      });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } });
    }
    return;
  }

  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
