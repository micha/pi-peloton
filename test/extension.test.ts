import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import peloton from "../src/extension.ts";
import { PeerClient, PeerServer, socketPath } from "../src/transport.ts";
import { identity, LIMITS } from "../src/protocol.ts";

function harness() {
  const handlers = new Map<string, Function[]>();
  const messages: any[] = [];
  const entries: any[] = [];
  const tools: any[] = [];
  const renderers = new Map<string, Function>();
  let sessionId = "session-1";
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    ui: new Proxy({ setStatus() {}, notify() {} }, {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        throw new Error(`Unexpected editor/UI access: ${String(key)}`);
      },
    }),
  };
  const pi = {
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
    registerMessageRenderer(name: string, renderer: Function) { renderers.set(name, renderer); },
    registerEntryRenderer(name: string, renderer: Function) { renderers.set(name, renderer); },
    registerTool(tool: any) { tools.push(tool); },
  };
  return {
    pi, ctx, messages, entries, tools, renderers,
    session(id: string) { sessionId = id; },
    async emit(name: string, event: any = {}) {
      let result;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
      return result;
    },
  };
}

test("extension lifecycle, delivery mapping, attribution, limits, literal commands and invalidation", async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-ext-"));
  const oldRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = root;
  const directory = join(root, "pi-peloton");
  const h = harness();
  peloton(h.pi as unknown as ExtensionAPI);
  t.after(async () => {
    await h.emit("session_shutdown");
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(lstat(directory), { code: "ENOENT" }); // Factory starts no resources.
  await h.emit("session_start");
  const sender = identity(12345);
  const client = new PeerClient(directory);
  for (const mode of ["followUp", "steer", "nextTurn"] as const) {
    await client.send(sender, process.pid, "/new\x1b[31m", mode);
    const sent = h.messages.at(-1);
    assert.equal(sent.options.deliverAs, mode);
    assert.equal(sent.options.triggerTurn, mode === "nextTurn" ? undefined : true);
    assert.match(sent.message.content, /PEER MESSAGE FROM Pi PID 12345/);
    assert.match(sent.message.content, /not human authorization/);
    assert.match(sent.message.content, /\/new\\u001b\[31m/);
    assert.equal(sent.message.customType, "peloton.peer");
  }
  assert.equal(h.tools.length, 1);
  assert.equal(h.tools[0].name, "peer_send");
  assert.equal(h.tools[0].parameters.properties.session, undefined);
  assert.equal(h.entries.filter(e => e.data.kind === "queued").length, 3);

  // Recording releases admission capacity, but is not called consumption.
  await h.emit("message_end", { message: { ...h.messages[0].message, role: "custom" } });
  for (let i = 0; i < LIMITS.pending - 2; i++) await client.send(sender, process.pid, "passive", "nextTurn");
  await assert.rejects(client.send(sender, process.pid, "overflow", "nextTurn"), /pending-message limit/);
  const oldQueued = { ...h.messages[1].message, role: "custom" };
  await h.emit("session_shutdown");
  await h.emit("session_shutdown"); // Idempotent cleanup.
  await assert.rejects(lstat(socketPath(directory, process.pid)), { code: "ENOENT" });
  assert.ok(h.entries.some(e => e.data.kind === "invalidated"));
  h.session("session-2");
  await h.emit("session_start");
  const result = await h.emit("context", { messages: [oldQueued, { role: "user", content: "hello" }] });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
  await client.send(sender, process.pid, "new session is addressable");

  // Outgoing tool receipt is structured and never injected as an incoming prompt.
  const peer = new PeerServer(directory, identity(34567), () => {});
  await peer.start();
  t.after(() => peer.close());
  const before = h.messages.length;
  const sent = await h.tools[0].execute("tool-1", { target: 34567, content: "review" }, undefined);
  assert.equal(sent.details.receipt.type, "accepted");
  assert.match(sent.content[0].text, /does not confirm model consumption/);
  assert.equal(h.messages.length, before);
});
