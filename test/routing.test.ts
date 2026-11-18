import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, mkdir, lstat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfiguration, CONFIG_ENV, type PelotonConfiguration } from "../src/configuration.ts";
import { PeerRouting } from "../src/routing.ts";
import { PeerClient, PeerServer, socketPath } from "../src/transport.ts";
import { identity, recordingUpdate, LIMITS, type Envelope } from "../src/protocol.ts";
import { registerPeerRoute, PELOTON_ROUTE, peerRouteResultEvent, type PeerRouteRequest } from "../src/api.ts";
import { harness } from "./harness.ts";

const config = (directory: string, routePolicy: "default" | "explicit" = "explicit"): PelotonConfiguration => ({
  version: 1, advertisedPid: 12345, runtimeDirectory: directory, routePolicy, routes: [],
});

test("trusted bootstrap validates complete bounded configuration without changing ordinary defaults", () => {
  assert.equal(readConfiguration({ XDG_RUNTIME_DIR: "/private/run" }).runtimeDirectory, "/private/run/pi-peloton");
  assert.equal(readConfiguration({}).advertisedPid, process.pid);
  const valid = config("/private/run");
  const read = (value: unknown) => readConfiguration({ [CONFIG_ENV]: JSON.stringify(value) });
  assert.deepEqual(read(valid), valid);
  for (const patch of [
    { version: 2 }, { advertisedPid: 0 }, { advertisedPid: "12345" }, { runtimeDirectory: "relative" },
    { runtimeDirectory: "/bad\0path" }, { runtimeDirectory: "/" + "x".repeat(100) },
    { routePolicy: "unknown" }, { routes: null }, { extra: true }, { routes: Array(LIMITS.duplicates + 1).fill({}) },
    { routes: [{ target: 34567, directory: "relative" }] }, { routes: [{ target: 34567, directory: "/peer", extra: true }] },
    { routes: [{ target: 12345, directory: "/peer" }] },
    { routes: [{ target: 34567, directory: "/a" }, { target: 34567, directory: "/b" }] },
  ]) assert.throws(() => read({ ...valid, ...patch }));
  for (const key of Object.keys(valid)) {
    const incomplete = { ...valid } as Record<string, unknown>; delete incomplete[key];
    assert.throws(() => read(incomplete));
  }
  for (const source of ["", "{", "null", "[]", "x".repeat(65537)]) {
    assert.throws(() => readConfiguration({ [CONFIG_ENV]: source }));
  }
});

test("route leases are bounded, one-shot, cancellation-owned and isolated across lifecycle", () => {
  const routing = new PeerRouting(config("/default", "default"));
  const owner = new AbortController();
  routing.register({ target: 34567, directory: "/private/peer" }, owner.signal);
  const endpoint = routing.resolve(34567);
  assert.equal(endpoint.directory, "/private/peer");
  assert.throws(() => routing.register({ target: 34567, directory: "/other" }, owner.signal), /already has/);
  assert.throws(() => routing.register({ target: 12345, directory: "/self" }, owner.signal), /this Pi/);
  assert.throws(() => routing.register({ target: 45678, directory: "/peer" }, {} as AbortSignal), /AbortSignal/);
  owner.abort();
  assert.equal(endpoint.signal?.aborted, true);
  assert.throws(() => routing.resolve(34567), /revoked.*no fallback/);
  assert.throws(() => routing.register({ target: 34567, directory: "/other" }, new AbortController().signal), /retired/);
  for (let i = 1; i < LIMITS.duplicates; i++) {
    const lifetime = new AbortController();
    routing.register({ target: 50000 + i, directory: "/peer" }, lifetime.signal);
    lifetime.abort();
  }
  assert.throws(() => routing.register({ target: 99999, directory: "/peer" }, new AbortController().signal), /limit/);
  const oldOwner = new AbortController();
  const old = new PeerRouting(config("/old"));
  old.register({ target: 34567, directory: "/old-peer" }, oldOwner.signal);
  const oldSignal = old.resolve(34567).signal;
  old.close(); old.close();
  assert.equal(oldSignal?.aborted, true);
  const fresh = new PeerRouting(config("/new"));
  fresh.register({ target: 34567, directory: "/new-peer" }, new AbortController().signal);
  oldOwner.abort(); // Cannot revoke the registration belonging to the next lifecycle.
  assert.equal(fresh.resolve(34567).signal?.aborted, false);
  assert.throws(() => old.resolve(34567), /closed/);
  assert.throws(() => old.register({ target: 45678, directory: "/peer" }, new AbortController().signal), /closed/);
  assert.throws(() => fresh.resolve(45678), /No explicit route/);
  fresh.close(); routing.close();
});

test("route helper bounds waits, preserves ownership after success and revokes on lost replies", async () => {
  const bus = harness().pi.events;
  const routing = new PeerRouting(config("/default"));
  const stop = bus.on(PELOTON_ROUTE, data => {
    const request = data as PeerRouteRequest;
    routing.register(request.input, request.signal);
    bus.emit(peerRouteResultEvent(request.requestId), { requestId: request.requestId, result: { ok: true, target: request.input.target } });
  });
  let listeners = 0;
  let emissions = 0;
  const events = {
    on(name: string, handler: (data: unknown) => void) {
      listeners++; const unsubscribe = bus.on(name, handler);
      return () => { listeners--; unsubscribe(); };
    },
    emit(name: string, data: unknown) { emissions++; bus.emit(name, data); },
  };
  const owner = new AbortController();
  assert.deepEqual(await registerPeerRoute(events, { target: 34567, directory: "/peer" }, { signal: owner.signal }), { ok: true, target: 34567 });
  assert.equal(listeners, 0);
  assert.equal(routing.resolve(34567).signal?.aborted, false);
  owner.abort();
  assert.throws(() => routing.resolve(34567), /revoked/);
  const input = { target: 45678, directory: "/second" };
  const dropped = await registerPeerRoute({ ...events, on: () => () => {} }, input, { signal: new AbortController().signal, timeoutMs: 5 });
  assert.equal(dropped.ok, false);
  if (!dropped.ok) assert.equal(dropped.error.code, "timeout");
  assert.throws(() => routing.resolve(45678), /revoked/);
  assert.equal(emissions, 2); // No retry.
  await registerPeerRoute(events, input, { signal: owner.signal });
  await registerPeerRoute(events, input, { signal: {} as AbortSignal });
  await registerPeerRoute(events, input, { signal: new AbortController().signal, timeoutMs: Infinity });
  assert.equal(emissions, 2);
  stop();
  const pendingOwner = new AbortController();
  const pending = registerPeerRoute(events, input, { signal: pendingOwner.signal });
  pendingOwner.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  if (!cancelled.ok) assert.equal(cancelled.error.code, "cancelled");
  const absent = await registerPeerRoute(events, input, { signal: new AbortController().signal, timeoutMs: 5 });
  assert.equal(absent.ok, false);
  const stale = await registerPeerRoute({ ...events, emit() { throw new Error("disposed"); } }, input, { signal: new AbortController().signal });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "unavailable");
  assert.equal(listeners, 0);
  routing.close();
});

test("one routed client handles messages/controls, never falls back and retains replacement checks", async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "default");
  const peerDirectory = join(root, "peer");
  const sender = identity(12345);
  let peerIdentity = identity(34567);
  let deliveries = 0;
  let controls = 0;
  const fallback = new PeerServer(directory, peerIdentity, () => deliveries++);
  let peer = new PeerServer(peerDirectory, peerIdentity, () => deliveries++, () => {}, () => controls++);
  await fallback.start(); await peer.start();
  t.after(async () => { await peer.close(); await fallback.close(); });
  const routing = new PeerRouting(config(directory)); t.after(() => routing.close());
  const owner = new AbortController();
  routing.register({ target: peerIdentity.pid, directory: peerDirectory }, owner.signal);
  const client = new PeerClient(directory, target => routing.resolve(target));
  const sent = await client.send(sender, peerIdentity.pid, "routed", "nextTurn");
  // A reversed synthetic envelope represents a peer->sender message being recorded.
  const incoming = { ...sent.envelope, id: "incoming", sender: peerIdentity, recipient: sender };
  await client.sendRecorded(recordingUpdate(incoming));
  assert.equal(deliveries, 1); assert.equal(controls, 1);
  await assert.rejects(client.send(sender, 45678, "unrouted"), /No explicit route/);
  await peer.close();
  peerIdentity = identity(34567);
  peer = new PeerServer(peerDirectory, peerIdentity, () => deliveries++);
  await peer.start();
  await assert.rejects(client.send(sender, peerIdentity.pid, "replacement"), /replacement process/);
  owner.abort();
  await assert.rejects(client.send(sender, peerIdentity.pid, "revoked"), /revoked/);
  await assert.rejects(client.sendRecorded(recordingUpdate(incoming)), /revoked/);
  assert.equal(deliveries, 1);
  // Registering an override must not discard a PID identity already learned via
  // ordinary lookup. The replacement lives in a different private directory.
  const ordinary = new PeerRouting(config(directory, "default"));
  t.after(() => ordinary.close());
  const sameClient = new PeerClient(directory, target => ordinary.resolve(target));
  await sameClient.send(sender, 34567, "learn default identity");
  ordinary.register({ target: 34567, directory: peerDirectory }, new AbortController().signal);
  await assert.rejects(sameClient.send(sender, 34567, "replacement after override"), /replacement process/);
});

test("routed destinations are checked, not created, and retain socket safety checks", async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-route-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sender = identity(12345);
  const directory = join(root, "export");
  const client = new PeerClient("/unused", () => ({ directory }));
  await assert.rejects(client.send(sender, 34567, "missing export"), { code: "ENOENT" });
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  await mkdir(directory, { mode: 0o755 });
  await assert.rejects(client.send(sender, 34567, "unsafe directory"), /owner-only/);
  await chmod(directory, 0o700);
  const path = socketPath(directory, 34567);
  await writeFile(path, "unrelated", { mode: 0o600 });
  await assert.rejects(client.send(sender, 34567, "non socket"), /Unsafe peer socket/);
  await rm(path);
  const actual = join(root, "actual");
  const peer = new PeerServer(actual, identity(34567), () => {});
  await peer.start(); t.after(() => peer.close());
  await symlink(socketPath(actual, 34567), path);
  await assert.rejects(client.send(sender, 34567, "symlink"), /Unsafe peer socket/);
  await rm(path);
  await rm(directory, { recursive: true });
  await symlink(actual, directory);
  await assert.rejects(client.send(sender, 34567, "symlink directory"), /real, owner-only/);
});

test("route revocation aborts active messages and recording controls before acknowledgement", async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-route-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let accepted!: () => void;
  let received = new Promise<void>(resolve => accepted = resolve);
  const peerIdentity = identity(34567);
  const server = createServer(socket => {
    socket.on("error", () => {});
    socket.write(JSON.stringify({ type: "hello", version: 2, identity: peerIdentity }) + "\n");
    socket.once("data", () => accepted()); // Intentionally never acknowledge.
  });
  server.listen(socketPath(root, peerIdentity.pid)); await once(server, "listening");
  await chmod(socketPath(root, peerIdentity.pid), 0o600);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const sender = identity(12345);
  for (const control of [false, true]) {
    const routing = new PeerRouting(config("/unused"));
    const owner = new AbortController();
    routing.register({ target: peerIdentity.pid, directory: root }, owner.signal);
    const client = new PeerClient("/unused", target => routing.resolve(target));
    const incoming: Envelope = { version: 2, id: "pending", sender: peerIdentity, recipient: sender, content: "incoming", delivery: "nextTurn" };
    const pending = control ? client.sendRecorded(recordingUpdate(incoming)) : client.send(sender, peerIdentity.pid, "pending");
    const rejected = assert.rejects(pending, /aborted.*acceptance may be unknown/);
    await received;
    owner.abort();
    await rejected;
    routing.close();
    received = new Promise<void>(resolve => accepted = resolve);
  }
});
