#!/usr/bin/env node
// A small MCP server for the screen preview only (not published): one tool,
// write_file, that writes a file inside the project it starts in. It lets a
// preview show agent-undo recording and undoing an MCP tool's write.
// Speaks MCP over stdio, one JSON-RPC message per line; exits when input closes.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const ROOT = process.cwd();
const TOOL = {
  name: "write_file",
  description: "Write text to a file in the project (replaces it if it exists, creates it if not).",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the project folder" },
      content: { type: "string", description: "The whole new text of the file" },
    },
    required: ["path", "content"],
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

function text(t, isError) {
  const r = { content: [{ type: "text", text: t }] };
  if (isError) r.isError = true;
  return r;
}

function writeFile(args) {
  const rel = args && args.path;
  if (typeof rel !== "string" || typeof args.content !== "string" || rel === "") {
    return text("write_file needs a path and content, both text.", true);
  }
  const full = path.resolve(ROOT, rel);
  if (path.isAbsolute(rel) || !full.startsWith(ROOT + path.sep)) {
    return text(`Refused: ${rel} is outside the project.`, true);
  }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, args.content);
  return text(`Wrote ${path.relative(ROOT, full)} (${Buffer.byteLength(args.content)} bytes).`);
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // a notification: nothing to answer
  if (method === "initialize") {
    return send({
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "writer", version: "1.0.0" },
      },
    });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: [TOOL] } });
  if (method === "tools/call") {
    if (!params || params.name !== TOOL.name) return send({ id, result: text(`No tool named ${params && params.name}.`, true) });
    try {
      return send({ id, result: writeFile(params.arguments) });
    } catch (e) {
      return send({ id, result: text(`write_file failed: ${e.message}`, true) });
    }
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(msg);
});
rl.on("close", () => process.exit(0));
