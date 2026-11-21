import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import peloton from "../src/pi-peloton.ts";
import { PELOTON_SEND, peerSendResultEvent, sendPeerMessage, onPeerDelivery,
  type PelotonEvents, type PeerSendInput, type PeerSendRequest, type PeerSendResponse, type PeerDeliveryStatus } from "../src/api.ts";
import { identity, recordingUpdate, VERSION, LIMITS, type Envelope } from "../src/protocol.ts";
import { PeerServer, PeerClient, socketPath } from "../src/transport.ts";
import { harness } from "./harness.ts";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "peloton-api-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = root;
  const h = harness();
  peloton(h.pi as unknown as ExtensionAPI);
  t.after(async () => {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  await h.emit("session_start");
  return { h, directory: join(root, "pi-peloton") };
}
const theme = { fg(_color: string, text: string) { return text; }, bg(_color: string, text: string) { return text; } };
const output = (component: any) => component.render(120).map((line: string) => line.trim()).filter(Boolean).join("\n");

function request(events: PelotonEvents, data: PeerSendRequest): Promise<PeerSendResponse["result"]> {
  return new Promise(resolve => {
    const stop = events.on(peerSendResultEvent(data.requestId), value => {
      const response = value as PeerSendResponse;
      if (response.requestId === data.requestId) { stop(); resolve(response.result); }
    });
    events.emit(PELOTON_SEND, data);
  });
}

test("API helper correlates concurrent results, bounds waits, cancels and removes listeners", { timeout: 10000 }, async () => {
  const bus = harness().pi.events;
  let listeners = 0;
  let emissions = 0;
  const events: PelotonEvents = {
    emit(name, data) { emissions++; bus.emit(name, data); },
    on(name, handler) { listeners++; const stop = bus.on(name, handler); return () => { listeners--; stop(); }; },
  };
  const input = { target: 12345, content: "hello" };
  const missing = await sendPeerMessage(events, input, { timeoutMs: 5 });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "timeout");
  assert.equal(listeners, 0);
  assert.equal(emissions, 1); // No retry.
  const requests: PeerSendRequest[] = [];
  const stop = bus.on(PELOTON_SEND, data => requests.push(data as PeerSendRequest));
  const a = sendPeerMessage(events, input);
  const b = sendPeerMessage(events, input);
  const respond = (index: number) => bus.emit(peerSendResultEvent(requests[index].requestId), { requestId: requests[index].requestId,
    result: { messageId: requests[index].requestId, ok: true, acceptance: "accepted", stage: "accepted", acceptedAt: index } });
  bus.emit(peerSendResultEvent(requests[0].requestId), { requestId: "unrelated", result: { ok: true } });
  respond(1); respond(0);
  assert.equal((await a).messageId, requests[0].requestId);
  assert.equal((await b).messageId, requests[1].requestId);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
  assert.equal(listeners, 0);
  const abort = new AbortController();
  const cancelled = sendPeerMessage(events, input, { signal: abort.signal });
  abort.abort();
  const result = await cancelled;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "cancelled");
  assert.equal(requests[2].signal?.aborted, true);
  respond(2); // Late result is harmless.
  assert.equal(listeners, 0);
  const count = emissions;
  await sendPeerMessage(events, input, { signal: abort.signal });
  await sendPeerMessage(events, input, { timeoutMs: Infinity });
  assert.equal(emissions, count);
  stop();
  const stale = await sendPeerMessage({ ...events, emit() { throw new Error("disposed"); } }, input);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "unavailable");
  assert.equal(listeners, 0);
});

test("extension sends share modes/identity/transport, durable cards and content-free recording statuses", { timeout: 10000 }, async t => {
  const { h, directory } = await setup(t);
  const envelopes: Envelope[] = [];
  const peer = new PeerServer(directory, identity(34567), envelope => envelopes.push(envelope));
  await peer.start(); t.after(() => peer.close());
  const statuses: PeerDeliveryStatus[] = [];
  const stop = onPeerDelivery(h.pi.events, status => statuses.push(status));
  t.after(stop);
  for (const delivery of [undefined, "steer", "nextTurn"] as const) {
    const result = await sendPeerMessage(h.pi.events, { target: 34567, content: "literal /new\x1b[31m", delivery, replyTo: "prior-message" });
    assert.equal(result.ok, true);
    assert.equal(result.acceptance, "accepted");
    assert.equal(result.stage, "accepted");
    assert.equal(result.senderSession, "session-1");
    const envelope = envelopes.at(-1)!;
    assert.equal(result.messageId, envelope.id);
    assert.equal(envelope.delivery, delivery ?? "followUp");
    assert.equal(envelope.replyTo, "prior-message");
    assert.equal(envelope.sender.pid, process.pid);
    assert.equal(h.messages.length, 0); // Outbound journal/status is never model input.
    const sent = h.entries.find(entry => entry.customType === "peloton.sent" && entry.data.messageId === result.messageId);
    const card = h.renderers.get("peloton.sent")!(sent, { expanded: false }, theme);
    assert.match(output(card), new RegExp(`PEER → Pi PID 34567 · ${delivery ?? "followUp"} · accepted`));
    assert.match(output(card), /literal \/new\\u001b\[31m/);
    const update = recordingUpdate(envelope);
    await new PeerClient(directory).sendRecorded(update);
    await new PeerClient(directory).sendRecorded(update);
    assert.match(output(card), /· recorded/);
    assert.equal(h.entries.filter(entry => entry.customType === "peloton.delivery" && entry.data.update.id === result.messageId).length, 1);
    assert.deepEqual(statuses.filter(status => status.messageId === result.messageId).map(status => status.stage), ["sending", "accepted", "recorded"]);
  }
  assert.ok(statuses.every(status => !("content" in status) && !("envelope" in status) && !("instance" in status)));
  assert.equal(h.entries.filter(entry => entry.customType === "peloton.send-result").length, 3);
  assert.equal(h.statuses.get("peloton"), `${process.pid} →0 ←0`);
  const original = h.entries.find(entry => entry.customType === "peloton.sent");
  await h.emit("session_shutdown");
  assert.equal(statuses.filter(status => status.stage === "untracked").length, 3);
  await h.emit("session_start");
  const resumed = h.renderers.get("peloton.sent")!(original, { expanded: true }, theme);
  assert.match(output(resumed), /· recorded/);
  assert.match(output(resumed), /Message ID: .* · reply to: prior-message/);
  assert.equal(h.messages.length, 0);
  assert.equal(h.statuses.get("peloton"), `${process.pid} →0 ←0`);
  const raw = { requestId: "once-only", input: { target: 34567, content: "only once" } };
  assert.equal((await request(h.pi.events, raw)).ok, true);
  const duplicate = await request(h.pi.events, raw);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "duplicate_request");
  assert.equal(envelopes.filter(envelope => envelope.id === raw.requestId).length, 1);
});

test("nextTurn remains API-only and old/direct tool calls fail before sending or guard skipping", async t => {
  const { h, directory } = await setup(t);
  const received: Envelope[] = [];
  const peerIdentity = identity(34567);
  const peer = new PeerServer(directory, peerIdentity, envelope => received.push(envelope));
  await peer.start(); t.after(() => peer.close());
  const statuses: PeerDeliveryStatus[] = [];
  t.after(onPeerDelivery(h.pi.events, status => statuses.push(status)));
  const tool = h.tools[0];
  const input = { target: peerIdentity.pid, content: "passive context", delivery: "nextTurn" };
  const rejectTool = async (guard?: boolean) => {
    const entries = h.entries.length;
    const footer = h.statuses.get("peloton");
    await assert.rejects(tool.execute("old-tool-call", { ...input, skipIfPendingFromTarget: guard }),
      /peer_send supports only followUp or steer; nextTurn is available only through the extension API/);
    assert.equal(received.length, 0);
    assert.equal(statuses.length, 0);
    assert.equal(h.entries.length, entries);
    assert.equal(h.statuses.get("peloton"), footer);
  };
  await rejectTool();
  await rejectTool(false);
  await rejectTool(true);
  // A queued reply must not disguise an unsupported old tool call as a skipped send.
  await new PeerClient(directory).send(peerIdentity, process.pid, "pending reply", "steer");
  await rejectTool(true);

  const result = await sendPeerMessage(h.pi.events, { ...input, delivery: "nextTurn" });
  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].delivery, "nextTurn");
  assert.equal(received[0].content, input.content);
  for (const delivery of [undefined, "followUp", "steer"] as const) {
    const sent = await tool.execute("valid-tool-call", { target: peerIdentity.pid, content: "active message", delivery });
    assert.equal(sent.details.receipt.type, "accepted");
    assert.equal(received.at(-1)!.delivery, delivery ?? "followUp");
  }
});

test("common tool and extension inputs share strict validation and known-PID replacement checks", { timeout: 10000 }, async t => {
  const { h, directory } = await setup(t);
  let deliveries = 0;
  let peer = new PeerServer(directory, identity(34567), () => deliveries++);
  await peer.start(); t.after(() => peer.close());
  const valid = { target: 34567, content: "hello" };
  for (const patch of [
    { target: 0 }, { target: "34567" }, { content: "  " }, { content: "🙂".repeat(5000) },
    { delivery: "unsupported" }, { replyTo: "" }, { replyTo: "bad id" }, { extra: true },
  ]) {
    const input = { ...valid, ...patch } as PeerSendInput;
    const api = await sendPeerMessage(h.pi.events, input);
    const tool = await h.tools[0].execute("invalid", input);
    assert.equal(api.ok, false);
    if (!api.ok) {
      assert.equal(api.error.code, "invalid_request");
      assert.equal(api.acceptance, "not-sent");
      assert.equal(api.error.message, tool.details.error);
    }
    assert.equal(tool.isError, true);
  }
  assert.equal(deliveries, 0);
  assert.equal(h.entries.filter(entry => entry.customType === "peloton.sent").length, 0);
  const invalidSignal = await request(h.pi.events, { requestId: "bad-signal", input: valid, signal: {} as AbortSignal });
  assert.equal(invalidSignal.ok, false);
  const absent = await sendPeerMessage(h.pi.events, { ...valid, target: 98765 });
  assert.equal(absent.ok, false);
  assert.equal(absent.acceptance, "not-sent");
  const first = await sendPeerMessage(h.pi.events, valid);
  assert.equal(first.ok, true);
  const tool = await h.tools[0].execute("valid-tool", valid);
  assert.equal(tool.details.receipt.type, "accepted");
  await peer.close();
  peer = new PeerServer(directory, identity(34567), () => deliveries++);
  await peer.start();
  for (const result of [await sendPeerMessage(h.pi.events, valid), await h.tools[0].execute("replacement", valid)]) {
    const error = "ok" in result ? result.error.message : result.details.error;
    assert.match(error, /replacement process/);
  }
  assert.equal(deliveries, 2);
  assert.equal(h.messages.length, 0);
});

async function fakePeer(t: TestContext, directory: string, accept: (envelope: Envelope, socket: Socket) => Promise<void> | void) {
  const peer = identity(34567);
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "hello", version: VERSION, identity: peer }) + "\n");
    socket.once("data", frame => { void Promise.resolve(accept(JSON.parse(frame.toString().trim()), socket)).catch(() => socket.destroy()); });
  });
  server.listen(socketPath(directory, peer.pid));
  await once(server, "listening");
  await chmod(socketPath(directory, peer.pid), 0o600);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return peer;
}

test("API early recording stays monotonic, including a lost acknowledgement", { timeout: 10000 }, async t => {
  const { h, directory } = await setup(t);
  const control = new PeerClient(directory);
  let drop = false;
  let early = true;
  let lastEnvelope: Envelope;
  await fakePeer(t, directory, async (envelope, socket) => {
    lastEnvelope = envelope;
    if (early) await control.sendRecorded(recordingUpdate(envelope));
    if (drop) socket.destroy();
    else socket.end(JSON.stringify({ type: "accepted", id: envelope.id, recipient: envelope.recipient, acceptedAt: Date.now() }) + "\n");
  });
  const statuses: PeerDeliveryStatus[] = [];
  const stop = onPeerDelivery(h.pi.events, status => statuses.push(status)); t.after(stop);
  for (const lost of [false, true]) {
    drop = lost;
    const result = await sendPeerMessage(h.pi.events, { target: 34567, content: "proof before receipt" });
    assert.equal(result.ok, !lost);
    assert.equal(result.stage, "recorded");
    assert.equal(result.acceptance, "accepted");
    assert.deepEqual(statuses.filter(status => status.messageId === result.messageId).map(status => status.stage), ["sending", "recorded"]);
    const sent = h.entries.find(entry => entry.customType === "peloton.sent" && entry.data.messageId === result.messageId);
    assert.match(output(h.renderers.get("peloton.sent")!(sent, {}, theme)), /· recorded\nproof before receipt/);
  }
  early = false;
  const late = await sendPeerMessage(h.pi.events, { target: 34567, content: "late proof" });
  assert.equal(late.ok, false);
  assert.equal(late.acceptance, "unknown");
  await control.sendRecorded(recordingUpdate(lastEnvelope!));
  assert.deepEqual(statuses.filter(status => status.messageId === late.messageId).map(status => status.stage), ["sending", "error", "recorded"]);
  assert.equal(h.messages.length, 0);
});

test("API bounds active sends, cancels on lifecycle, removes listeners and restarts without old work", { timeout: 10000 }, async t => {
  const { h, directory } = await setup(t);
  const peer = await fakePeer(t, directory, () => {}); // Accept bytes, never acknowledge.
  const statuses: PeerDeliveryStatus[] = [];
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => resolveReady = resolve);
  const stop = onPeerDelivery(h.pi.events, status => {
    statuses.push(status);
    if (statuses.filter(status => status.stage === "sending").length === LIMITS.connections) resolveReady();
  }); t.after(stop);
  const pending = Array.from({ length: LIMITS.connections }, () => sendPeerMessage(h.pi.events, { target: peer.pid, content: "old conversation" }));
  await ready;
  const busy = await sendPeerMessage(h.pi.events, { target: peer.pid, content: "overflow" });
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.error.code, "busy");
  await h.emit("session_shutdown");
  for (const result of await Promise.all(pending)) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "session_changed");
    assert.equal(result.acceptance, "unknown");
    assert.equal(result.senderSession, "session-1");
  }
  assert.equal(h.entries.filter(entry => entry.customType === "peloton.send-result").length, LIMITS.connections);
  assert.equal(statuses.filter(status => status.stage === "untracked").length, LIMITS.connections);
  const unavailable = await sendPeerMessage(h.pi.events, { target: peer.pid, content: "after shutdown" }, { timeoutMs: 5 });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, "timeout");
  h.entries.length = 0;
  h.session("session-2");
  await h.emit("session_start");
  const abort = new AbortController();
  const next = sendPeerMessage(h.pi.events, { target: peer.pid, content: "new conversation" }, { signal: abort.signal });
  abort.abort();
  await next;
  let prepared!: () => void;
  const toolReady = new Promise<void>(resolve => prepared = resolve);
  const stopTool = onPeerDelivery(h.pi.events, status => {
    if (status.senderSession === "session-2" && status.stage === "sending") prepared();
  });
  const toolResult = h.tools[0].execute("pending-tool", { target: peer.pid, content: "tool cancellation" })
    .then(() => undefined, (error: Error) => error);
  await toolReady;
  stopTool();
  await h.emit("session_shutdown"); // Wait for both tool/API cancellation settlement.
  assert.match((await toolResult).message, /aborted/);
  assert.ok(h.entries.every(entry => entry.customType !== "peloton.send-result" || entry.data.result.senderSession === "session-2"));
  assert.equal(h.messages.length, 0);
});

test("API deadline aborts transport and journal failures return errors rather than hanging", { timeout: 10000 }, async t => {
  const { h, directory } = await setup(t);
  let acknowledge = false;
  let delivered = 0;
  await fakePeer(t, directory, (envelope, socket) => {
    delivered++;
    if (acknowledge) socket.end(JSON.stringify({ type: "accepted", id: envelope.id, recipient: envelope.recipient, acceptedAt: Date.now() }) + "\n");
  });
  const input = { target: 34567, content: "bounded wait" };
  const timed = await sendPeerMessage(h.pi.events, input, { timeoutMs: 1000 });
  assert.equal(timed.ok, false);
  if (!timed.ok) assert.equal(timed.error.code, "timeout");
  assert.equal(timed.acceptance, "unknown");
  assert.equal(delivered, 1); // No retry after the lost acknowledgement.
  await h.emit("session_shutdown"); // Settle the service-side cancellation too.
  const settled = h.entries.find(entry => entry.customType === "peloton.send-result" && entry.data.result.messageId === timed.messageId);
  assert.equal(settled.data.result.ok, false);
  assert.equal(settled.data.result.acceptance, "unknown");
  await h.emit("session_start");
  acknowledge = true;
  const append = h.pi.appendEntry;
  for (const failingEntry of ["peloton.sent", "peloton.send-result"]) {
    h.pi.appendEntry = (type, data) => {
      if (type === failingEntry) throw new Error("Synthetic journal failure");
      append(type, data);
    };
    const result = await sendPeerMessage(h.pi.events, input);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "send_failed");
    assert.equal(result.acceptance, failingEntry === "peloton.sent" ? "not-sent" : "accepted");
  }
  h.pi.appendEntry = append;
  assert.equal(delivered, 2);
  assert.equal(h.statuses.get("peloton"), `${process.pid} →0 ←0`);
  assert.equal(h.messages.length, 0);
});

test("delivery observers learn when bounded correlations are evicted, without replay or turns", { timeout: 10000 }, async t => {
  const { h, directory } = await setup(t);
  const peer = new PeerServer(directory, identity(34567), () => {});
  await peer.start(); t.after(() => peer.close());
  const statuses: PeerDeliveryStatus[] = [];
  const stop = onPeerDelivery(h.pi.events, status => statuses.push(status)); t.after(stop);
  let firstId = "";
  for (let i = 0; i <= LIMITS.outgoing; i++) {
    const result = await sendPeerMessage(h.pi.events, { target: 34567, content: "bounded" });
    assert.equal(result.ok, true);
    if (i === 0) firstId = result.messageId;
  }
  assert.deepEqual(statuses.filter(status => status.stage === "untracked").map(status => [status.messageId, status.lastStage, status.reason]), [[firstId, "accepted", "evicted"]]);
  assert.equal(h.messages.length, 0);
  assert.equal(h.statuses.get("peloton"), `${process.pid} →256 ←0`);
});
