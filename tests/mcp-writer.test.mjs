// The preview's MCP server (preview/mcp-writer.js): one write_file tool, so a
// preview can show agent-undo recording and undoing an MCP tool's write.
// Run: node --test tests/mcp-writer.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "preview", "mcp-writer.js");

function start(cwd) {
  const child = spawn(process.execPath, [SERVER], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  });
  let next = 1;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { child, call, notify };
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-writer-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "greet.py"), "def greet(name):\n    return 'hi ' + name\n");
  return dir;
}

test("answers initialize with the client's protocol version and a tools capability", async () => {
  const s = start(project());
  const r = await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, "writer");
  s.child.kill();
});

test("lists exactly one tool, write_file, with path and content required", async () => {
  const s = start(project());
  await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  s.notify("notifications/initialized");
  const r = await s.call("tools/list", {});
  assert.deepEqual(r.result.tools.map((t) => t.name), ["write_file"]);
  assert.deepEqual(r.result.tools[0].inputSchema.required, ["path", "content"]);
  s.child.kill();
});

test("write_file replaces a file and creates a new one, relative to the project", async () => {
  const dir = project();
  const s = start(dir);
  await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const a = await s.call("tools/call", { name: "write_file", arguments: { path: "src/greet.py", content: "X\n" } });
  assert.equal(a.result.isError, undefined);
  assert.equal(readFileSync(join(dir, "src", "greet.py"), "utf8"), "X\n");
  await s.call("tools/call", { name: "write_file", arguments: { path: "notes.txt", content: "n\n" } });
  assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "n\n");
  s.child.kill();
});

test("refuses a path outside the project, and writes nothing (comparison: a path inside is written)", async () => {
  const dir = project();
  const s = start(dir);
  await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  for (const p of ["../escape.txt", "/tmp/escape.txt", "src/../../escape.txt"]) {
    const r = await s.call("tools/call", { name: "write_file", arguments: { path: p, content: "no" } });
    assert.equal(r.result.isError, true, p);
  }
  assert.equal(existsSync(join(dir, "..", "escape.txt")), false);
  const ok = await s.call("tools/call", { name: "write_file", arguments: { path: "src/ok.txt", content: "y" } });
  assert.equal(ok.result.isError, undefined);
  s.child.kill();
});

test("an unknown method gets a JSON-RPC error, an unknown tool an error result", async () => {
  const s = start(project());
  await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const m = await s.call("no/such", {});
  assert.equal(m.error.code, -32601);
  const t = await s.call("tools/call", { name: "nope", arguments: {} });
  assert.equal(t.result.isError, true);
  s.child.kill();
});

test("exits when its input closes, so a preview restart is not blocked", async () => {
  const s = start(project());
  await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("still running"), 3000);
    s.child.on("exit", (c) => { clearTimeout(t); resolve(c); });
    s.child.stdin.end();
  });
  assert.equal(code, 0);
});
