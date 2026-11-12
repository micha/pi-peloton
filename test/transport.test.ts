import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, lstat, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { identity, LIMITS, validateEnvelope, deliveryOptions, safeText, type Envelope } from "../src/protocol.ts";
import { Inbox } from "../src/inbox.ts";
import { PeerServer, PeerClient, socketPath, runtimeDirectory, privateDirectory } from "../src/transport.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "peloton-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recipient = identity(23456);
  const sender = identity(12345);
  const received: Envelope[] = [];
  const server = new PeerServer(directory, recipient, envelope => received.push(envelope));
  await server.start();
  t.after(() => server.close());
  return { directory, recipient, sender, received, server, client: new PeerClient(directory) };
}

// Read/write raw protocol records without any Pi instance.
async function raw(directory: string, pid: number, make: (hello: any) => string | Buffer) {
  const socket = createConnection(socketPath(directory, pid));
  socket.setEncoding("utf8");
  let buffer = "";
  return new Promise<any>((resolve, reject) => {
    let hello = false;
    socket.on("error", reject);
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const value = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!hello) { hello = true; socket.write(make(value)); }
        else { socket.destroy(); resolve(value); }
      }
    });
  });
}

test("PID lookup, all modes, receipts, duplicate suppression, permissions and cleanup", async t => {
  const f = await fixture(t);
  for (const delivery of ["followUp", "steer", "nextTurn"] as const) {
    const result = await f.client.send(f.sender, f.recipient.pid, "hello", delivery);
    assert.equal(result.receipt.type, "accepted");
    assert.equal(f.received.at(-1)?.delivery, delivery);
  }
  const first = await f.client.send(f.sender, f.recipient.pid, "once", "nextTurn", { id: "same-id" });
  const second = await f.client.send(f.sender, f.recipient.pid, "once", "nextTurn", { id: "same-id" });
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(f.received.length, 4);
  await assert.rejects(f.client.send(f.sender, f.recipient.pid, "different", "nextTurn", { id: "same-id" }), /reused/);
  assert.equal((await lstat(socketPath(f.directory, f.recipient.pid))).mode & 0o777, 0o600);
  await f.server.close();
  await f.server.close();
  await assert.rejects(lstat(socketPath(f.directory, f.recipient.pid)), { code: "ENOENT" });
});

test("concurrent senders retain identity", async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.client.send(identity(30000 + i), f.recipient.pid, `message ${i}`)));
  assert.equal(f.received.length, 12);
  assert.equal(new Set(f.received.map(e => e.sender.pid)).size, 12);
});

test("invalid envelope, invalid UTF8 and oversize frames are rejected without stopping listener", async t => {
  const f = await fixture(t);
  for (const payload of ["not-json\n", Buffer.from([0xff, 10]), JSON.stringify({ version: 99 }) + "\n", "x".repeat(LIMITS.frameBytes + 1)]) {
    assert.equal((await raw(f.directory, f.recipient.pid, () => payload)).type, "error");
  }
  assert.equal((await f.client.send(f.sender, f.recipient.pid, "still alive")).receipt.type, "accepted");
  await assert.rejects(f.client.send(f.sender, f.recipient.pid, "x".repeat(LIMITS.contentBytes + 1)), /Invalid envelope/);
});

test("stale conversation from handshake is rejected", async t => {
  const f = await fixture(t);
  const response = await raw(f.directory, f.recipient.pid, hello => JSON.stringify({
    version: 1, id: "stale", sender: f.sender, recipient: { ...hello.identity, generation: "old" }, content: "hello", delivery: "followUp",
  }) + "\n");
  assert.match(response.error, /Stale/);
  assert.equal(f.received.length, 0);
});

test("PID replacement rejected for known peer; conversation replacement keeps process identity", async t => {
  const f = await fixture(t);
  await f.client.send(f.sender, f.recipient.pid, "first");
  await f.server.close();
  const changedSession = new PeerServer(f.directory, identity(f.recipient.pid, f.recipient.instance), () => {});
  await changedSession.start();
  await f.client.send(f.sender, f.recipient.pid, "new conversation");
  await changedSession.close();
  const replacement = new PeerServer(f.directory, identity(f.recipient.pid), () => {});
  await replacement.start();
  t.after(() => replacement.close());
  await assert.rejects(f.client.send(f.sender, f.recipient.pid, "must not misroute"), /replacement process/);
  await new PeerClient(f.directory).send(f.sender, f.recipient.pid, "deliberate first contact");
});

test("unknown, self, invalid target, unsafe path and active socket fail clearly", async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.send(f.sender, 98765, "unknown"), { code: "ENOENT" });
  await assert.rejects(f.client.send(f.sender, f.sender.pid, "self"), /Cannot send/);
  await assert.rejects(f.client.send(f.sender, -1, "bad"), /positive/);
  assert.throws(() => socketPath("/" + "x".repeat(100), 1), /100 bytes/);
  const another = new PeerServer(f.directory, f.recipient, () => {});
  await assert.rejects(another.start(), /already active/);
  await f.client.send(f.sender, f.recipient.pid, "original still alive");
  const file = socketPath(f.directory, 98765);
  await writeFile(file, "do not delete");
  await assert.rejects(new PeerServer(f.directory, identity(98765), () => {}).start(), /non-owned socket path/);
  await chmod(f.directory, 0o755);
  await assert.rejects(privateDirectory(f.directory), /owner-only/);
});

test("bounded pending inbox and invalidation", () => {
  const recipient = identity();
  const inbox = new Inbox(recipient);
  const sender = identity(42);
  const envelope = (id: string) => validateEnvelope({ version: 1, id, sender, recipient, content: "test", delivery: "nextTurn" });
  for (let i = 0; i < LIMITS.pending; i++) inbox.accept(envelope(`id-${i}`));
  assert.throws(() => inbox.accept(envelope("overflow")), /limit/);
  inbox.recorded(envelope("id-0"));
  inbox.accept(envelope("one-more"));
  assert.equal(inbox.close().length, LIMITS.pending);
  assert.equal(inbox.close().length, 0);
  assert.throws(() => inbox.accept({ ...envelope("stale"), recipient: identity() }), /Stale/);
});

test("delivery options, control characters, byte size, runtime fallback", () => {
  assert.deepEqual(deliveryOptions("followUp"), { deliverAs: "followUp", triggerTurn: true });
  assert.deepEqual(deliveryOptions("steer"), { deliverAs: "steer", triggerTurn: true });
  assert.deepEqual(deliveryOptions("nextTurn"), { deliverAs: "nextTurn" });
  assert.equal(safeText("a\x1b[31m\r\u202eb"), "a\\u001b[31m\\u000d\\u202eb");
  assert.equal(runtimeDirectory({}, "/home/test"), "/home/test/.pi/peloton-runtime");
  assert.equal(runtimeDirectory({ XDG_RUNTIME_DIR: "/run/test" }), "/run/test/pi-peloton");
  assert.throws(() => validateEnvelope({ version: 1, id: "id", sender: identity(), recipient: identity(), content: "😀".repeat(5000), delivery: "steer" }), /Invalid/);
});

test("shutdown closes stalled connections and client reports lost acknowledgement", async t => {
  const f = await fixture(t);
  const socket = createConnection(socketPath(f.directory, f.recipient.pid));
  await once(socket, "connect");
  socket.resume();
  const closed = once(socket, "close");
  await f.server.close();
  await closed;
  const fake = createServer(socket => socket.destroy());
  const path = socketPath(f.directory, 34567);
  fake.listen(path);
  await once(fake, "listening");
  await chmod(path, 0o600);
  t.after(() => new Promise<void>(resolve => fake.close(() => resolve())));
  await assert.rejects(f.client.send(f.sender, 34567, "hello"), /disconnected/);
});
