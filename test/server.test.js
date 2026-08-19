/**
 * Tests for the parts that fail silently.
 *
 * The Figma calls themselves are not mocked — a fake that returns whatever the
 * code expects proves only that the code agrees with itself. What is tested is
 * everything between the caller and that request: the input forms people
 * actually paste, and the protocol handshake, which either works or leaves the
 * server invisible with no error anywhere.
 */

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FigmaError, fileKey, nodeId, nodeIds } from "../src/figma.js";
import { TOOLS } from "../src/tools.js";

const SERVER = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("a file key is read from any form of Figma URL", () => {
  const key = "abc123XYZ";
  for (const input of [
    key,
    `https://www.figma.com/design/${key}/My-File`,
    `https://www.figma.com/file/${key}/Old-Style-Link`,
    `https://www.figma.com/proto/${key}/Prototype?node-id=1-2`,
    `  https://www.figma.com/design/${key}/Spaced?t=abc  `,
  ]) {
    assert.equal(fileKey(input), key, `failed for ${input}`);
  }
});

test("a file key that is neither a key nor a URL is refused with a hint", () => {
  assert.throws(
    () => fileKey("not a key!"),
    (e) => {
      assert.ok(e instanceof FigmaError);
      // The hint is the whole value of the refusal — "invalid input" leaves the
      // user guessing which of the URL's several path segments is the key.
      assert.match(e.hint, /Figma file URL/);
      return true;
    },
  );
  assert.throws(() => fileKey(""), FigmaError);
});

test("node ids from a URL are converted to the API's form", () => {
  // The bug this prevents: `1-23` is what the address bar gives you, and the
  // API answers it with an empty result rather than an error.
  assert.equal(nodeId("1-23"), "1:23");
  assert.equal(nodeId("1:23"), "1:23");
  assert.equal(nodeId("0-1"), "0:1");
  assert.deepEqual(nodeIds("1-2, 3:4 ,5-6"), ["1:2", "3:4", "5:6"]);
  assert.deepEqual(nodeIds(["1-2", "3-4"]), ["1:2", "3:4"]);
});

test("every tool declares a schema the model can fill in", () => {
  assert.equal(TOOLS.length, 3);
  for (const tool of TOOLS) {
    assert.ok(tool.name.startsWith("figma_"), `${tool.name} should be namespaced`);
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object");
    // Every tool needs a file, and a required field absent from properties is
    // a schema that can never validate.
    for (const req of tool.inputSchema.required) {
      assert.ok(tool.inputSchema.properties[req], `${tool.name}.${req} required but not declared`);
    }
  }
});

/** Drive the real server over stdio, the way Leo's MCP client does. */
async function rpc(requests, env = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, FIGMA_TOKEN: "", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const replies = [];
  let buffer = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) replies.push(JSON.parse(line));
    }
  });

  // A raw string is written verbatim, so a malformed-input test sends genuinely
  // malformed bytes rather than a valid JSON string containing them.
  for (const req of requests) {
    proc.stdin.write(`${typeof req === "string" ? req : JSON.stringify(req)}\n`);
  }
  proc.stdin.end();
  await new Promise((resolve) => proc.on("exit", resolve));
  return replies;
}

test("the server completes an MCP handshake and lists its tools", async () => {
  const [init, list] = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);

  assert.equal(init.id, 1);
  // Echoing the client's version is what lets one build serve an older hub.
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.equal(init.result.serverInfo.name, "leo-figma");
  assert.ok(init.result.capabilities.tools);

  assert.equal(list.id, 2);
  assert.deepEqual(
    list.result.tools.map((t) => t.name).sort(),
    ["figma_export", "figma_file", "figma_tokens"],
  );
});

test("a notification is never answered", async () => {
  // Replying to a message with no id is a protocol violation that some clients
  // treat as fatal — and it would look like the server merely being chatty.
  const replies = await rpc([
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: {} },
    { jsonrpc: "2.0", id: 9, method: "ping" },
  ]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 9);
});

test("an unconfigured token is a tool result the model can read, not a crash", async () => {
  const [reply] = await rpc([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "figma_file", arguments: { file: "abc123" } },
    },
  ]);

  // isError (not a JSON-RPC error) is what puts the text in front of the model
  // instead of surfacing it as a transport fault it never sees.
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /No Figma token configured/);
  assert.match(reply.result.content[0].text, /Settings → Packages → Figma/);
});

test("a bad file key is reported without spending a Figma request", async () => {
  const [reply] = await rpc(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "figma_file", arguments: { file: "definitely not a key!!" } },
      },
    ],
    { FIGMA_TOKEN: "figd_fake" },
  );
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /Could not read a file key/);
});

test("an unknown tool is a protocol error", async () => {
  const [reply] = await rpc([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "figma_delete_everything" } },
  ]);
  assert.equal(reply.error.code, -32602);
});

test("malformed input is reported and the server keeps serving", async () => {
  const replies = await rpc(["{ not json", { jsonrpc: "2.0", id: 2, method: "ping" }]);

  assert.ok(replies.some((r) => r.error?.code === -32700), "expected a parse error");
  // The half that matters: one bad line must not end the session, or a single
  // corrupt frame silently costs every call after it.
  assert.ok(replies.some((r) => r.id === 2), "server stopped answering after bad input");
});
