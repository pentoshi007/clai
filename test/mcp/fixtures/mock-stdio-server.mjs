import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
let pendingServerRequests;
let lastCancelled;

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

  if (pendingServerRequests && typeof id === "string" && id.startsWith("server-")) {
    const label = {
      "server-ping": "ping",
      "server-roots": "roots",
      "server-sampling": "unsupported",
    }[id];
    if (label) pendingServerRequests.responses[label] = message;
    if (Object.keys(pendingServerRequests.responses).length === 3) {
      send({
        jsonrpc: "2.0",
        id: pendingServerRequests.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(pendingServerRequests.responses),
            },
          ],
        },
      });
      pendingServerRequests = undefined;
    }
    return;
  }

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
  if (method === "notifications/cancelled") {
    lastCancelled = params?.requestId;
    return;
  }

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
    if (name === "server_requests") {
      pendingServerRequests = { id, responses: {} };
      send({ jsonrpc: "2.0", id: "server-ping", method: "ping" });
      send({ jsonrpc: "2.0", id: "server-roots", method: "roots/list" });
      send({
        jsonrpc: "2.0",
        id: "server-sampling",
        method: "sampling/createMessage",
        params: {},
      });
      return;
    }
    if (name === "slow") return;
    if (name === "cancelled_request") {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(lastCancelled) }] },
      });
      return;
    }
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `echo: ${args.text ?? ""}` }],
        },
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
        result: {
          content: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
        },
      });
    } else if (name === "boom") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "tool failed" }],
          isError: true,
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `unknown tool ${name}` },
      });
    }
    return;
  }

  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "method not found" },
    });
  }
});
