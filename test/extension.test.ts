import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, lstat, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import peloton from "../src/extension.ts";
import { PeerClient, PeerServer, socketPath } from "../src/transport.ts";
import { identity, LIMITS, VERSION, recordingUpdate, type Envelope, type RecordedUpdate } from "../src/protocol.ts";

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
      // Match Pi 1.0.3 ordering: extension handlers run before session append.
      if (name === "message_end" && event.message.role === "custom") {
        entries.push({ type: "custom_message", customType: event.message.customType,
          content: event.message.content, details: event.message.details });
      }
      return result;
    },
  };
}

test("incoming cards use standard headers, with acceptance expanded-only after recording", async () => {
  const h = harness();
  peloton(h.pi as unknown as ExtensionAPI);
  const envelope: Envelope = {
    version: VERSION, id: "render-test", sender: identity(12345), recipient: identity(23456),
    content: "hello\x1b[31m", delivery: "nextTurn", replyTo: "previous-message",
  };
  const colors: { color: string; text: string }[] = [];
  const theme = {
    fg(color: string, text: string) { colors.push({ color, text }); return text; },
    bg(_color: string, text: string) { return text; },
  };
  const lines = (component: any): string[] => component.render(120).map((line: string) => line.trim()).filter(Boolean);
  const entry = { data: { kind: "queued", text: "Accepted by recipient.", envelope } };
  const acceptanceComponent = h.renderers.get("peloton.status")!(entry, { expanded: false }, theme);
  assert.deepEqual(lines(acceptanceComponent), ["PEER ← Pi PID 12345 · nextTurn · accepted", "hello\\u001b[31m"]);
  assert.ok(colors.every(call => call.color === "dim"));
  colors.length = 0;
  const message = { content: envelope.content, details: { envelope } };
  const recorded = h.renderers.get("peloton.peer")!(message, { expanded: false }, theme);
  assert.deepEqual(lines(recorded), ["PEER ← Pi PID 12345 · nextTurn · recorded", "hello\\u001b[31m"]);
  assert.ok(colors.some(call => call.color === "accent" && call.text.includes("· recorded")));
  assert.ok(colors.some(call => call.color === "text" && call.text === "hello\\u001b[31m"));
  await h.emit("message_end", { message: { role: "custom", customType: "peloton.peer", details: { envelope } } });
  assert.deepEqual(acceptanceComponent.render(120), []); // Existing card updates on repaint.
  assert.deepEqual(h.renderers.get("peloton.status")!(entry, { expanded: false }, theme).render(120), []);
  for (const expanded of [
    h.renderers.get("peloton.status")!(entry, { expanded: true }, theme),
    h.renderers.get("peloton.peer")!(message, { expanded: true }, theme),
  ]) {
    const output = lines(expanded).join("\n");
    assert.match(output, /Message ID: render-test · reply to: previous-message/);
    assert.doesNotMatch(output, /proof|consumption|completion|acceptance only/);
  }
  colors.length = 0;
  const error = h.renderers.get("peloton.status")!({ data: { kind: "error", text: "Unavailable peer" } }, {}, theme);
  assert.deepEqual(lines(error), ["PEER ← Pi PID ? · unknown · error", "Unavailable peer"]);
  assert.equal(colors[0].color, "warning");
});

test("outgoing cards update from sending to accepted without duplicating the message", () => {
  const h = harness();
  peloton(h.pi as unknown as ExtensionAPI);
  const tool = h.tools[0];
  const theme = { fg(_color: string, text: string) { return text; } };
  const params = { target: 23456, content: "outgoing\x1b[31m", delivery: "steer" };
  const context = { args: params, state: {}, isError: false };
  const lines = (component: any) => component.render(120).map((line: string) => line.trimEnd());
  const call = tool.renderCall(params, theme, context);
  assert.deepEqual(lines(call), ["PEER → Pi PID 23456 · steer · sending", "outgoing\\u001b[31m"]);
  const result = { content: [{ type: "text", text: "Accepted" }], details: { receipt: { id: "sent-id" } } };
  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
  assert.deepEqual(collapsed.render(120), []);
  assert.deepEqual(lines(call), ["PEER → Pi PID 23456 · steer · accepted", "outgoing\\u001b[31m"]);
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, context);
  assert.deepEqual(lines(expanded), ["Message ID: sent-id"]);
  context.isError = true;
  tool.renderResult({ content: [{ type: "text", text: "Peer unavailable" }] }, { expanded: false, isPartial: false }, theme, context);
  assert.deepEqual(lines(call), ["PEER → Pi PID 23456 · steer · error", "Peer unavailable"]);
});

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
  assert.match(h.tools[0].description, /Replies arrive automatically/);
  const guidance = h.tools[0].promptGuidelines.join("\n");
  assert.match(guidance, /No polling or sleep loop/);
  assert.match(guidance, /continue independent work/i);
  assert.ok(h.tools[0].promptGuidelines.every((line: string) => line.includes("peer_send")));
  assert.match(guidance, /finish the current turn/);
  assert.match(guidance, /not declaring the task complete/);
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
  assert.ok(h.entries.some(e => e.data?.kind === "invalidated"));
  h.session("session-2");
  await h.emit("session_start");
  const firstAcceptance = h.entries.find(e => e.type === "custom" && e.data.kind === "queued");
  const theme = { fg(_color: string, text: string) { return text; }, bg(_color: string, text: string) { return text; } };
  assert.deepEqual(h.renderers.get("peloton.status")!(firstAcceptance, { expanded: false }, theme).render(120), []);
  assert.ok(h.renderers.get("peloton.status")!(firstAcceptance, { expanded: true }, theme).render(120).length > 0);
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
  assert.match(sent.content[0].text, /PEER → Pi PID 34567 · followUp · accepted/);
  assert.equal(h.messages.length, before);
});

test("recording updates refresh outgoing rows before acceptance, persist invisibly, and survive reload", async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-control-"));
  const oldRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = root;
  const h = harness();
  peloton(h.pi as unknown as ExtensionAPI);
  const sockets = new Set<import("node:net").Socket>();
  let fake: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    await h.emit("session_shutdown");
    for (const socket of sockets) socket.destroy();
    if (fake) await new Promise<void>(resolve => fake!.close(() => resolve()));
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
    await rm(root, { recursive: true, force: true });
  });
  await h.emit("session_start");
  const directory = join(root, "pi-peloton");
  const peer = identity(34567);
  const control = new PeerClient(directory);
  const updates: RecordedUpdate[] = [];
  let dropAcceptance = false;
  fake = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "hello", version: VERSION, identity: peer }) + "\n");
    socket.once("data", async frame => {
      try {
        const envelope = JSON.parse(frame.toString().trim()) as Envelope;
        const update = recordingUpdate(envelope);
        updates.push(update);
        await control.sendRecorded(update); // Deterministically arrive before acceptance.
        if (dropAcceptance) socket.destroy();
        else socket.end(JSON.stringify({ type: "accepted", id: envelope.id, recipient: peer, acceptedAt: Date.now() }) + "\n");
      } catch { socket.destroy(); }
    });
  });
  fake.listen(socketPath(directory, peer.pid));
  await once(fake, "listening");
  await chmod(socketPath(directory, peer.pid), 0o600);
  const tool = h.tools[0];
  const params = { target: peer.pid, content: "record this" };
  const theme = { fg(_color: string, text: string) { return text; } };
  let redraws = 0;
  const ctx = { args: params, state: {}, toolCallId: "send-1", isError: false, invalidate() { redraws++; } };
  const call = tool.renderCall(params, theme, ctx);
  const result = await tool.execute("send-1", params, undefined);
  tool.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
  assert.match(call.render(120).join("\n"), /PEER → Pi PID 34567 · followUp · recorded/);
  assert.equal(redraws, 1);
  assert.equal(h.messages.length, 0); // Control packets never invoke pi.sendMessage.
  assert.equal(h.renderers.has("peloton.delivery"), false);
  assert.equal(h.entries.filter(e => e.customType === "peloton.delivery" && e.data.kind === "recorded").length, 1);
  await control.sendRecorded(updates[0]);
  assert.equal(h.entries.filter(e => e.customType === "peloton.delivery" && e.data.kind === "recorded").length, 1);
  await assert.rejects(control.sendRecorded({ ...updates[0], id: "unrelated-id" }), /Unknown/);
  await assert.rejects(control.sendRecorded({ ...updates[0], sender: identity(peer.pid) }), /identity mismatch/);
  assert.equal(h.messages.length, 0);

  dropAcceptance = true;
  const ctx2 = { ...ctx, state: {}, toolCallId: "send-2" };
  const call2 = tool.renderCall(params, theme, ctx2);
  const lost = await tool.execute("send-2", params, undefined);
  assert.equal(lost.isError, true);
  ctx2.isError = true;
  tool.renderResult(lost, { expanded: false, isPartial: false }, theme, ctx2);
  assert.match(call2.render(120).join("\n"), /· recorded/); // Lost acceptance cannot regress proof already received.

  await h.emit("session_shutdown");
  await h.emit("session_start"); // Same branch models extension reload.
  const resumedCtx = { ...ctx, state: {} };
  const resumed = tool.renderCall(params, theme, resumedCtx);
  tool.renderResult(result, { expanded: false, isPartial: false }, theme, resumedCtx);
  assert.match(resumed.render(120).join("\n"), /· recorded/);
  await assert.rejects(control.sendRecorded(updates[0]), /stale conversation/);
  assert.equal(h.messages.length, 0);
});

test("recipient recording sends one control notification without adding model input", async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-notify-"));
  const oldRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = root;
  const h = harness();
  peloton(h.pi as unknown as ExtensionAPI);
  let sender: PeerServer | undefined;
  t.after(async () => {
    await h.emit("session_shutdown");
    await sender?.close();
    if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
    await rm(root, { recursive: true, force: true });
  });
  await h.emit("session_start");
  const directory = join(root, "pi-peloton");
  const senderIdentity = identity(12345);
  const updates: RecordedUpdate[] = [];
  let resolveUpdate!: () => void;
  const received = new Promise<void>(resolve => resolveUpdate = resolve);
  let unexpectedModelMessages = 0;
  sender = new PeerServer(directory, senderIdentity, () => unexpectedModelMessages++, () => {}, update => { updates.push(update); resolveUpdate(); });
  await sender.start();
  const sent = await new PeerClient(directory).send(senderIdentity, process.pid, "passive content", "nextTurn");
  assert.equal(updates.length, 0);
  const message = { ...h.messages[0].message, role: "custom" };
  await h.emit("message_end", { message });
  await received;
  await h.emit("message_end", { message });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, sent.envelope.id);
  assert.deepEqual(updates[0].recipient, senderIdentity);
  assert.equal(unexpectedModelMessages, 0);
  assert.equal(h.messages.length, 1); // Only the original peer input.
});
