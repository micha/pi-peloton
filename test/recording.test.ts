import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identity, VERSION, LIMITS, recordingUpdate, validateRecordedUpdate, type Envelope, type RecordedUpdate } from "../src/protocol.ts";
import { PeerClient, PeerServer, socketPath } from "../src/transport.ts";
import { Outgoing, RecordingNotifications, waitForRecording } from "../src/recording.ts";

function envelope(id = "message-id"): Envelope {
  return { version: VERSION, id, sender: identity(12345), recipient: identity(23456), content: "original", delivery: "followUp" };
}

test("recording correlation validates both identities and is monotonic before acceptance", () => {
  const outgoing = new Outgoing();
  const sent = envelope();
  const update = recordingUpdate(sent, 42);
  outgoing.prepare(sent);
  assert.throws(() => outgoing.receive({ ...update, id: "unknown" }), /Unknown/);
  assert.throws(() => outgoing.receive({ ...update, sender: identity(23456) }), /identity mismatch/);
  assert.throws(() => outgoing.receive({ ...update, recipient: identity(12345) }), /identity mismatch/);
  let redraws = 0;
  outgoing.watch(sent.id, () => redraws++);
  assert.equal(outgoing.receive(update), true);
  outgoing.refresh(sent.id);
  outgoing.accepted(sent.id);
  outgoing.failed(sent.id);
  assert.equal(outgoing.get(sent.id)?.stage, "recorded");
  assert.equal(redraws, 1);
  assert.equal(outgoing.receive(update), false);
  assert.throws(() => outgoing.receive({ ...update, recordedAt: 43 }), /Conflicting/);
  outgoing.clear();
  assert.throws(() => outgoing.receive(update), /Unknown/);
});

test("bounded live correlations evict only settled sends and reject expired updates", () => {
  const outgoing = new Outgoing();
  const first = envelope("first");
  outgoing.prepare(first);
  for (let i = 1; i < LIMITS.outgoing; i++) outgoing.prepare(envelope(`id-${i}`));
  assert.throws(() => outgoing.prepare(envelope("overflow")), /limit/);
  outgoing.accepted(first.id);
  outgoing.prepare(envelope("next"));
  assert.throws(() => outgoing.receive(recordingUpdate(first)), /expired/);
});

test("recording updates use a distinct transport path, deduplicate, and reject stale conversations", async t => {
  const directory = await mkdtemp(join(tmpdir(), "peloton-record-"));
  const sent = envelope();
  const updates: RecordedUpdate[] = [];
  const modelMessages: Envelope[] = [];
  const outgoing = new Outgoing();
  outgoing.prepare(sent);
  const server = new PeerServer(directory, sent.sender, value => modelMessages.push(value), () => {}, update => {
    if (outgoing.receive(update)) updates.push(update);
  });
  await server.start();
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const client = new PeerClient(directory);
  const update = recordingUpdate(sent, 42);
  assert.equal((await client.sendRecorded(update)).type, "accepted");
  await client.sendRecorded(update);
  assert.equal(updates.length, 1);
  assert.equal(modelMessages.length, 0);
  await assert.rejects(client.sendRecorded({ ...update, recordedAt: 43 }), /reused/);
  await assert.rejects(client.sendRecorded({ ...update, id: "unknown" }), /Unknown/);
  await assert.rejects(client.sendRecorded({ ...update, sender: identity(23456) }), /identity mismatch/);
  await server.close();
  const nextSession = new PeerServer(directory, identity(sent.sender.pid, sent.sender.instance), () => {}, () => {}, () => {});
  await nextSession.start();
  t.after(() => nextSession.close());
  await assert.rejects(client.sendRecorded(update), /stale conversation/);
});

test("recording packets are versioned, content-free, and strictly validated", () => {
  const update = recordingUpdate(envelope());
  assert.deepEqual(validateRecordedUpdate(update), update);
  assert.throws(() => validateRecordedUpdate({ ...update, version: 1 }), /Invalid/);
  assert.throws(() => validateRecordedUpdate({ ...update, recordedAt: -1 }), /Invalid/);
  assert.throws(() => validateRecordedUpdate({ ...update, content: "not a model message" }), /Invalid/);
});

test("mixed wire versions fail before sending content and request reload", async t => {
  const directory = await mkdtemp(join(tmpdir(), "peloton-version-"));
  const peer = identity(23456);
  let contentSent = false;
  const server = createServer(socket => {
    socket.on("data", () => contentSent = true);
    socket.write(JSON.stringify({ type: "hello", version: 1, identity: peer }) + "\n");
  });
  server.listen(socketPath(directory, peer.pid));
  await once(server, "listening");
  await chmod(socketPath(directory, peer.pid), 0o600);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(new PeerClient(directory).send(identity(12345), peer.pid, "do not deliver"), /Unsupported Peloton protocol.*reload/);
  assert.equal(contentSent, false);
});

test("recording observation waits for the actual entry, times out, and cancels", async () => {
  const controller = new AbortController();
  let entryExists = false;
  let finished = false;
  const waiting = waitForRecording(() => entryExists, controller.signal, 100).then(() => finished = true);
  await new Promise<void>(resolve => setTimeout(resolve, 15));
  assert.equal(finished, false);
  entryExists = true;
  await waiting;
  await assert.rejects(waitForRecording(() => false, controller.signal, 10), /timed out/);
  const aborted = waitForRecording(() => false, controller.signal, 100);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
});

test("notification queue is bounded, best-effort without retries, and abortable on shutdown", async () => {
  const sent = envelope();
  let attempts = 0;
  let failures = 0;
  const failing = new RecordingNotifications(async () => { attempts++; throw new Error("offline"); }, () => failures++);
  failing.enqueue(recordingUpdate(sent));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(failures, 1);
  await failing.close();
  assert.throws(() => failing.enqueue(recordingUpdate(sent)), /closed/);

  let aborted = false;
  const blocked = new RecordingNotifications((_update, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  }), () => { throw new Error("Shutdown should not report a failure"); });
  for (let i = 0; i < LIMITS.notifications; i++) blocked.enqueue(recordingUpdate({ ...sent, id: `id-${i}` }));
  assert.throws(() => blocked.enqueue(recordingUpdate(sent)), /limit/);
  await blocked.close();
  assert.equal(aborted, true);
});
