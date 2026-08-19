#!/usr/bin/env node
/**
 * leo-figma — a Model Context Protocol server exposing read-only Figma tools.
 *
 * Speaks MCP's JSON-RPC 2.0 over stdio directly rather than through the SDK,
 * so the package has **no dependencies at all**. That is a deliberate choice
 * for something distributed through a package catalog: the pinned commit covers
 * every byte that executes, there is no transitive resolution at install time,
 * and a reviewer reads the code that actually runs instead of a build artifact.
 *
 * The token arrives as FIGMA_TOKEN, which Leo puts in the environment because
 * the catalog entry declares `settings_read: ["FIGMA_TOKEN"]` — a package is
 * handed exactly the settings keys it declared and nothing else. Nothing here
 * depends on that: this reads an environment variable, as it would if it were
 * run by hand.
 */

import { FigmaError } from "./figma.js";
import { TOOLS } from "./tools.js";

const NAME = "leo-figma";
const VERSION = "0.1.0";

/**
 * Protocol versions this server knows how to speak, newest first.
 *
 * The handshake echoes the client's version when it is one of these and
 * otherwise answers with the newest — which is what lets one build serve both
 * an older hub and a newer one.
 */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** stdout is the protocol. Anything else written there corrupts the stream. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * A tool failure is a *result*, not a JSON-RPC error.
 *
 * `isError` hands the text to the model, which can then correct itself — a
 * protocol-level error is a transport fault the model never sees, so reporting
 * "that file key doesn't exist" that way loses the one party able to act on it.
 */
function toolFailure(id, message, hint) {
  result(id, {
    isError: true,
    content: [{ type: "text", text: hint ? `${message}\n\n${hint}` : message }],
  });
}

async function callTool(id, params) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) {
    return failure(id, -32602, `Unknown tool: ${params?.name}`);
  }

  try {
    const value = await tool.run(process.env.FIGMA_TOKEN, params.arguments ?? {});
    result(id, {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    });
  } catch (e) {
    if (e instanceof FigmaError) return toolFailure(id, e.message, e.hint);
    // An unexpected throw is this server's bug. Say so plainly rather than
    // letting it read as something the user did wrong.
    toolFailure(id, `leo-figma failed unexpectedly: ${e?.message ?? e}`);
  }
}

async function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      });

    case "tools/list":
      return result(
        id,
        { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      );

    case "tools/call":
      return callTool(id, params);

    case "ping":
      return result(id, {});

    default:
      // Notifications carry no id and per JSON-RPC must never be answered —
      // replying to `notifications/initialized` is a protocol violation some
      // clients treat as fatal.
      if (id === undefined || id === null) return;
      failure(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Read newline-delimited JSON off stdin.
 *
 * Buffered explicitly because a stdin chunk is not a message: a large
 * `tools/call` can arrive split across chunks, and two small ones can arrive
 * in a single chunk.
 */
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      failure(null, -32700, "Parse error");
      continue;
    }
    // Not awaited: tool calls are independent, and serialising them would make
    // one slow Figma request block every other in-flight call.
    handle(msg).catch((e) => failure(msg?.id ?? null, -32603, String(e?.message ?? e)));
  }
});

process.stdin.on("end", () => process.exit(0));
