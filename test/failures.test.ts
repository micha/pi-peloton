import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, createConnection, type Socket } from "node:net";
import { mkdtemp, rm, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { identity, LIMITS } from "../src/protocol.ts";
import { PeerServer, PeerClient, socketPath } from "../src/transport.ts";

test("client abort and total deadline; bounded listener connections", { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "peloton-fail-"));
  const sockets = new Set<Socket>();
  const fake = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const path = socketPath(directory, 34567);
  fake.listen(path);
  await once(fake, "listening");
  await chmod(path, 0o600);
  const receiver = new PeerServer(directory, identity(23456), () => {});
  await receiver.start();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => fake.close(() => resolve()));
    await receiver.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = new PeerClient(directory);
  const controller = new AbortController();
  const send = client.send(identity(12345), 34567, "hello", "followUp", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(send, /aborted/);
  await assert.rejects(client.send(identity(12345), 34567, "hello"), /timed out/);

  const connections: Socket[] = [];
  for (let i = 0; i < LIMITS.connections; i++) {
    const socket = createConnection(socketPath(directory, 23456));
    connections.push(socket);
    await once(socket, "data"); // Server hello proves this slot is occupied.
  }
  const excess = createConnection(socketPath(directory, 23456));
  excess.resume();
  await once(excess, "close");
  for (const socket of connections) socket.destroy();
});

test("crashed process leaves socket pathname; a new listener safely replaces it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "peloton-crash-"));
  const recipient = identity(45678);
  const path = socketPath(directory, recipient.pid);
  const child = spawn(process.execPath, ["-e", `require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready\\n'))`, path]);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  });
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.ok((await lstat(path)).isSocket());
  const server = new PeerServer(directory, recipient, () => {});
  await server.start();
  t.after(() => server.close());
  await new PeerClient(directory).send(identity(12345), recipient.pid, "after crash");
});
