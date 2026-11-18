import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import peloton from "../src/pi-peloton.ts";
import { CONFIG_ENV, type PelotonConfiguration } from "../src/configuration.ts";
import { sendPeerMessage, registerPeerRoute } from "../src/api.ts";
import { PeerServer, PeerClient, socketPath } from "../src/transport.ts";
import { identity, recordingUpdate, type Envelope, type RecordedUpdate } from "../src/protocol.ts";
import { harness } from "./harness.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<T>((done, reject) => {
    resolve = value => { clearTimeout(timer); done(value); };
    timer = setTimeout(() => reject(new Error("Expected test notification did not arrive")), 3000);
  });
  return { promise, resolve };
}

test("configured extension uses advertised PID and shared explicit routes across sends, recording and lifecycle", { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-config-"));
  const previous = process.env[CONFIG_ENV];
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  const advertisedPid = 1234567890;
  const localDirectory = join(root, "local");
  const parentDirectory = join(root, "parent");
  const childDirectory = join(root, "child");
  const config: PelotonConfiguration = { version: 1, advertisedPid, runtimeDirectory: localDirectory,
    routePolicy: "explicit", routes: [{ target: 34567, directory: parentDirectory }] };
  process.env[CONFIG_ENV] = JSON.stringify(config);
  process.env.XDG_RUNTIME_DIR = root;
  const h = harness();
  peloton(h.pi as unknown as ExtensionAPI);
  t.after(async () => {
    await h.emit("session_shutdown");
    if (previous === undefined) delete process.env[CONFIG_ENV]; else process.env[CONFIG_ENV] = previous;
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previousRuntime;
    await rm(root, { recursive: true, force: true });
  });
  const envelopes: Envelope[] = [];
  const recording = deferred<RecordedUpdate>();
  let notificationCount = 0;
  const acceptRecorded = (update: RecordedUpdate) => { notificationCount++; recording.resolve(update); };
  const parentIdentity = identity(34567);
  const parent = new PeerServer(parentDirectory, parentIdentity, envelope => envelopes.push(envelope), () => {}, acceptRecorded);
  const childIdentity = identity(45678);
  const child = new PeerServer(childDirectory, childIdentity, envelope => envelopes.push(envelope), () => {}, acceptRecorded);
  let fallbackDeliveries = 0;
  const fallback = new PeerServer(join(root, "pi-peloton"), childIdentity, () => fallbackDeliveries++);
  await parent.start(); await child.start(); await fallback.start();
  t.after(async () => { await parent.close(); await child.close(); await fallback.close(); });
  process.env[CONFIG_ENV] = "{}";
  await h.emit("session_start");
  assert.equal(h.statuses.has("peloton"), false);
  await assert.rejects(lstat(socketPath(localDirectory, advertisedPid)), { code: "ENOENT" });
  assert.ok(h.entries.some(entry => entry.customType === "peloton.status" && /Invalid or incomplete/.test(entry.data.text)));
  process.env[CONFIG_ENV] = JSON.stringify(config);
  await h.emit("session_start");
  assert.equal((await lstat(socketPath(localDirectory, advertisedPid))).mode & 0o777, 0o600);
  await assert.rejects(lstat(socketPath(localDirectory, process.pid)), { code: "ENOENT" });
  assert.equal(h.statuses.get("peloton"), `${advertisedPid} →0 ←0`);
  const api = await sendPeerMessage(h.pi.events, { target: parentIdentity.pid, content: "parent API", delivery: "nextTurn" });
  const tool = await h.tools[0].execute("tool", { target: parentIdentity.pid, content: "parent tool", replyTo: api.messageId });
  assert.equal(api.ok, true); assert.equal(tool.details.envelope.sender.pid, advertisedPid);
  assert.equal(envelopes.length, 2);
  assert.equal(envelopes[1].replyTo, api.messageId);
  const sender = envelopes[0].sender;
  for (const envelope of envelopes) {
    assert.equal(envelope.sender.pid, advertisedPid);
    await new PeerClient(localDirectory).sendRecorded(recordingUpdate(envelope));
  }
  assert.equal(h.entries.filter(entry => entry.customType === "peloton.delivery" && entry.data.kind === "recorded").length, 2);
  assert.equal(h.messages.length, 0); // No sender model input for API/tool status.
  const inbound = new PeerClient(localDirectory);
  const received = await inbound.send(parentIdentity, advertisedPid, "from selected parent", "nextTurn");
  const message = h.messages.at(-1).message;
  assert.match(message.content, /PEER MESSAGE FROM Pi PID 34567/);
  assert.deepEqual(message.details.envelope.recipient, sender);
  await h.emit("message_end", { message: { role: "custom", ...message } });
  const update = await recording.promise;
  assert.equal(update.id, received.envelope.id);
  assert.deepEqual(update.sender, sender);
  assert.deepEqual(update.recipient, parentIdentity);
  assert.ok(h.entries.some(entry => entry.type === "custom_message" && entry.details.envelope.id === update.id));
  const unrouted = await sendPeerMessage(h.pi.events, { target: childIdentity.pid, content: "must not fallback" });
  assert.equal(unrouted.ok, false);
  if (!unrouted.ok) assert.match(unrouted.error.message, /No explicit route/);
  const innerPid = await sendPeerMessage(h.pi.events, { target: process.pid, content: "inner PID is not an alias" });
  assert.equal(innerPid.ok, false);
  assert.equal(fallbackDeliveries, 0);
  const owner = new AbortController();
  assert.deepEqual(await registerPeerRoute(h.pi.events, { target: childIdentity.pid, directory: childDirectory }, { signal: owner.signal }), { ok: true, target: childIdentity.pid });
  assert.equal((await sendPeerMessage(h.pi.events, { target: childIdentity.pid, content: "dynamic route" })).ok, true);
  const duplicate = await registerPeerRoute(h.pi.events, { target: childIdentity.pid, directory: childDirectory }, { signal: new AbortController().signal });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "conflict");
  const priorNotifications = notificationCount;
  const childMessage = await inbound.send(childIdentity, advertisedPid, "native observation cancelled by revoke", "nextTurn");
  const observing = h.messages.at(-1).message;
  const queued = await inbound.send(childIdentity, advertisedPid, "queued control also fails closed", "nextTurn");
  // Observe both failures without polling. message_end precedes session append,
  // so one worker observes recording while the second notification is queued.
  const pendingIds = new Set([childMessage.envelope.id, queued.envelope.id]);
  const failed = deferred<void>();
  const append = h.pi.appendEntry;
  h.pi.appendEntry = (type, data) => {
    append(type, data);
    if (type === "peloton.delivery" && data.kind === "notificationFailed") {
      pendingIds.delete(data.update.id);
      if (!pendingIds.size) failed.resolve();
    }
  };
  await h.emit("message_end", { message: { role: "custom", ...observing } });
  await h.emit("message_end", { message: { role: "custom", ...h.messages.at(-1).message } });
  owner.abort();
  await failed.promise;
  assert.equal(notificationCount, priorNotifications); // No control reached the revoked child.
  const revoked = await sendPeerMessage(h.pi.events, { target: childIdentity.pid, content: "revoked route" });
  assert.equal(revoked.ok, false);
  if (!revoked.ok) assert.match(revoked.error.message, /revoked.*no fallback/);
  assert.equal(fallbackDeliveries, 0);
  await h.emit("session_shutdown");
  await assert.rejects(lstat(socketPath(localDirectory, advertisedPid)), { code: "ENOENT" });
  h.session("session-2");
  await h.emit("session_start");
  assert.equal((await sendPeerMessage(h.pi.events, { target: childIdentity.pid, content: "route not replayed" })).ok, false);
  const nextOwner = new AbortController();
  assert.equal((await registerPeerRoute(h.pi.events, { target: childIdentity.pid, directory: childDirectory }, { signal: nextOwner.signal })).ok, true);
  owner.abort(); // A stale owner cannot revoke the fresh lifecycle.
  assert.equal((await sendPeerMessage(h.pi.events, { target: childIdentity.pid, content: "new generation" })).ok, true);
  const freshSender = envelopes.at(-1)!.sender;
  assert.equal(freshSender.pid, advertisedPid);
  assert.equal(freshSender.instance, sender.instance);
  assert.notEqual(freshSender.generation, sender.generation);
  await assert.rejects(new PeerClient(localDirectory).sendRecorded(recordingUpdate(envelopes[0])), /stale conversation/);
  await h.emit("session_shutdown");
  // Explicit bootstrap cannot change identity or routing implicitly on reload.
  process.env[CONFIG_ENV] = JSON.stringify({ ...config, advertisedPid: advertisedPid - 1 });
  await h.emit("session_start");
  assert.ok(h.entries.some(entry => entry.customType === "peloton.status" && /cannot change within a Pi process/.test(entry.data.text)));
  assert.equal(h.statuses.has("peloton"), false);
  await assert.rejects(h.tools[0].execute("unavailable", { target: parentIdentity.pid, content: "not sent" }), /unavailable/);
  const absent = await registerPeerRoute(h.pi.events, { target: childIdentity.pid, directory: childDirectory }, { signal: new AbortController().signal, timeoutMs: 5 });
  assert.equal(absent.ok, false);
  for (const source of [undefined, "{"]) {
    if (source === undefined) delete process.env[CONFIG_ENV]; else process.env[CONFIG_ENV] = source;
    await h.emit("session_start");
    assert.equal(h.statuses.has("peloton"), false);
    await assert.rejects(lstat(socketPath(join(root, "pi-peloton"), process.pid)), { code: "ENOENT" });
  }
});
