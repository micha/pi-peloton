import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { PeerClient, PeerServer, socketPath } from "../src/transport.ts";
import { identity, type RecordedUpdate } from "../src/protocol.ts";
import type { PelotonConfiguration } from "../src/configuration.ts";

const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
function rpc(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  let sequence = 0;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let diagnostics = "";
  child.stderr.on("data", chunk => diagnostics += chunk);
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line);
        if (value.type === "response") {
          const request = pending.get(value.id);
          pending.delete(value.id);
          if (value.success) request?.resolve(value.data); else request?.reject(new Error(value.error));
        }
      } catch { /* Ignore nonprotocol startup diagnostics; deadlines expose load failures. */ }
    }
  });
  child.on("exit", () => {
    for (const request of pending.values()) request.reject(new Error(`Pi exited: ${diagnostics}`));
    pending.clear();
  });
  return async (type: string, extra = {}) => {
    const id = `req-${++sequence}`;
    return new Promise<any>((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout for ${type}: ${diagnostics}`));
      }, 15000);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolveRequest(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n");
    });
  };
}

test("isolated Pi 1.0.3 API sends and native recording use advertised PID and dynamic/private routes", { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-rpc-"));
  const runtime = join(root, "run");
  await mkdir(runtime, { mode: 0o700 });
  const children: ChildProcessWithoutNullStreams[] = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const packagePath = resolve(".");
  async function start(name: string, extraExtensions: string[] = [], extraArgs: string[] = [], configuration?: PelotonConfiguration) {
    const config = join(root, name);
    // Allowlist environment: no inherited provider credentials or live Pi config.
    const env = {
      PATH: process.env.PATH, HOME: root, XDG_RUNTIME_DIR: runtime,
      PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      ...(configuration ? { PI_PELOTON_CONFIG: JSON.stringify(configuration) } : {}),
    };
    // Verify installation only inside disposable settings, never the user's config.
    const install = spawn(process.execPath, [cli, "install", packagePath], { cwd: root, env });
    let diagnostics = "";
    install.stdout.on("data", chunk => diagnostics += chunk);
    install.stderr.on("data", chunk => diagnostics += chunk);
    assert.equal((await once(install, "exit"))[0], 0, diagnostics);
    assert.ok((await readFile(join(config, "settings.json"), "utf8")).includes(packagePath));
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools", ...extraExtensions.flatMap(path => ["-e", path]), ...extraArgs], { cwd: root, env });
    children.push(child);
    const request = rpc(child);
    await request("get_state");
    const address = configuration?.advertisedPid ?? child.pid!;
    const path = socketPath(configuration?.runtimeDirectory ?? join(runtime, "pi-peloton"), address);
    await lstat(path);
    return { child, request, path, address };
  }
  const extensions = [resolve("test/fixtures/api-consumer.ts"), resolve("test/fixtures/record-peer.ts")];
  const provider = ["--provider", "peloton-test", "--model", "model"];
  const a = await start("a", extensions, provider);
  const privateDirectory = join(root, "private");
  // Synthetic advertised PID, not an actual namespace. The launcher is trusted
  // to supply the real host PID; this checks production extension integration.
  const b = await start("b", extensions, provider, { version: 1, advertisedPid: 1234567890,
    runtimeDirectory: privateDirectory, routePolicy: "explicit", routes: [
      { target: a.address, directory: join(runtime, "pi-peloton") },
      { target: 34567, directory: join(runtime, "pi-peloton") },
    ] });
  await a.request("prompt", { message: `/peloton-test-route ${JSON.stringify({ target: b.address, directory: privateDirectory })}` });
  assert.equal((await a.request("get_entries")).entries.find((entry: any) => entry.customType === "peloton.test-route").data.ok, true);
  const client = new PeerClient(privateDirectory);
  const sentByExtension = await a.request("prompt", { message: `/peloton-test-send ${JSON.stringify({
    target: b.address, content: "Please review HANDOFF.md, without starting work yet.", delivery: "nextTurn", replyTo: "approved-resolution",
  })}` });
  assert.equal(sentByExtension.disposition, "handled");
  const outbound = (await a.request("get_entries")).entries;
  const apiResult = outbound.find((entry: any) => entry.customType === "peloton.test-send").data;
  const toolState = outbound.find((entry: any) => entry.customType === "peloton.test-tools").data;
  assert.ok(toolState.registered.includes("peer_send"));
  assert.ok(!toolState.active.includes("peer_send"));
  assert.equal(apiResult.ok, true);
  assert.equal(apiResult.stage, "accepted");
  assert.ok(outbound.some((entry: any) => entry.customType === "peloton.sent" && entry.data.messageId === apiResult.messageId));
  const state = await b.request("get_state");
  assert.equal(state.isStreaming, false);
  const records = await b.request("get_entries");
  const queued = records.entries.find((entry: any) => entry.customType === "peloton.status" && entry.data.kind === "queued");
  assert.equal(queued.data.envelope.sender.pid, a.child.pid);
  assert.equal(queued.data.envelope.delivery, "nextTurn");
  assert.equal(queued.data.envelope.id, apiResult.messageId);
  assert.equal(queued.data.envelope.replyTo, "approved-resolution");
  assert.ok(!records.entries.some((entry: any) => entry.type === "message" && entry.message.role === "assistant"));

  // A test-only command runs accepted content through a deterministic provider,
  // exercising native Pi recording and control transport without network calls.
  await b.request("prompt", { message: "/peloton-test-record" });
  for (let i = 0; i < 100 && (await b.request("get_state")).isStreaming; i++) await delay(20);
  assert.equal((await b.request("get_state")).isStreaming, false);
  const controllerIdentity = identity(34567);
  let resolveRecorded!: (update: RecordedUpdate) => void;
  let notificationTimer: NodeJS.Timeout;
  const notification = new Promise<RecordedUpdate>((resolve, reject) => {
    notificationTimer = setTimeout(() => reject(new Error("No native recording notification")), 5000);
    resolveRecorded = update => { clearTimeout(notificationTimer); resolve(update); };
  });
  t.after(() => clearTimeout(notificationTimer));
  let unexpectedInputs = 0;
  const controller = new PeerServer(join(runtime, "pi-peloton"), controllerIdentity,
    () => unexpectedInputs++, () => {}, resolveRecorded);
  await controller.start();
  t.after(() => controller.close());
  const recordProbe = await client.send(controllerIdentity, b.address, "native recording probe", "nextTurn");
  const command = await b.request("prompt", { message: "/peloton-test-record" });
  assert.equal(command.disposition, "handled");
  const update = await notification;
  assert.equal(update.id, recordProbe.envelope.id);
  assert.deepEqual(update.recipient, controllerIdentity);
  assert.equal(unexpectedInputs, 0);
  for (let i = 0; i < 100 && (await b.request("get_state")).isStreaming; i++) await delay(20);
  assert.equal((await b.request("get_state")).isStreaming, false);
  const afterRecording = await b.request("get_entries");
  assert.ok(afterRecording.entries.some((entry: any) => entry.type === "custom_message" && entry.details?.envelope.id === update.id));
  const calls = afterRecording.entries.filter((entry: any) => entry.customType === "peloton.test-model");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].data.calls, 1);
  assert.equal(calls[1].data.calls, 2);
  const senderEntries = await a.request("get_entries");
  assert.ok(!senderEntries.entries.some((entry: any) => entry.type === "message" && entry.message.role === "assistant"));
  assert.ok(senderEntries.entries.some((entry: any) => entry.customType === "peloton.delivery"
    && entry.data.kind === "recorded" && entry.data.update.id === apiResult.messageId));
  assert.deepEqual(senderEntries.entries.filter((entry: any) => entry.customType === "peloton.test-status"
    && entry.data.messageId === apiResult.messageId).map((entry: any) => entry.data.stage), ["sending", "accepted", "recorded"]);
  assert.ok(!senderEntries.entries.some((entry: any) => entry.type === "custom_message"));
  // Exercise reversed native recording too: A must route its control back to B.
  await b.request("prompt", { message: `/peloton-test-send ${JSON.stringify({ target: a.address, content: "reverse private-route probe", delivery: "nextTurn", replyTo: apiResult.messageId })}` });
  const reverse = (await b.request("get_entries")).entries.find((entry: any) => entry.customType === "peloton.test-send").data;
  assert.equal(reverse.ok, true);
  await a.request("prompt", { message: "/peloton-test-record" });
  for (let i = 0; i < 100 && (await a.request("get_state")).isStreaming; i++) await delay(20);
  let reverseRecorded = false;
  for (let i = 0; i < 100 && !reverseRecorded; i++) {
    reverseRecorded = (await b.request("get_entries")).entries.some((entry: any) => entry.customType === "peloton.delivery"
      && entry.data.kind === "recorded" && entry.data.update.id === reverse.messageId);
    if (!reverseRecorded) await delay(20); // Recording control is asynchronous, not a model turn.
  }
  assert.equal(reverseRecorded, true);
  // Revocation on an ordinary host must tombstone, not fall back to its runtime.
  await a.request("prompt", { message: `/peloton-test-revoke ${b.address}` });
  await a.request("prompt", { message: `/peloton-test-send ${JSON.stringify({ target: b.address, content: "revoked" })}` });
  const revoked = (await a.request("get_entries")).entries.filter((entry: any) => entry.customType === "peloton.test-send").at(-1).data;
  assert.equal(revoked.ok, false);
  assert.match(revoked.error.message, /revoked.*no fallback/);
  // Pi replaces extension runtimes on session changes; routes must not replay.
  await a.request("new_session");
  await a.request("prompt", { message: `/peloton-test-send ${JSON.stringify({ target: b.address, content: "route not restored" })}` });
  const missingRoute = (await a.request("get_entries")).entries.find((entry: any) => entry.customType === "peloton.test-send").data;
  assert.equal(missingRoute.ok, false);
  await a.request("prompt", { message: `/peloton-test-route ${JSON.stringify({ target: b.address, directory: privateDirectory })}` });
  await a.request("prompt", { message: `/peloton-test-send ${JSON.stringify({ target: b.address, content: "fresh sender", delivery: "nextTurn" })}` });
  const freshSender = (await a.request("get_entries")).entries;
  assert.equal(freshSender.filter((entry: any) => entry.customType === "peloton.test-send").length, 2);
  assert.equal(freshSender.filter((entry: any) => entry.customType === "peloton.test-send").at(-1).data.ok, true);
  const freshTools = freshSender.find((entry: any) => entry.customType === "peloton.test-tools").data;
  assert.ok(freshTools.registered.includes("peer_send"));
  assert.ok(!freshTools.active.includes("peer_send"));

  // A human-equivalent conversation switch in the isolated test recipient.
  await b.request("new_session");
  // Session lifecycle awaits new listener creation; PID still locates the peer.
  await client.send(identity(a.child.pid!), b.address, "Message for the newly prepared conversation.", "nextTurn");
  const fresh = await b.request("get_entries");
  const received = fresh.entries.filter((entry: any) => entry.customType === "peloton.status" && entry.data.kind === "queued");
  assert.equal(received.length, 1);
  assert.match(received[0].data.envelope.content, /newly prepared/);

  for (const peer of [a, b]) {
    const exited = once(peer.child, "exit");
    peer.child.stdin.end();
    assert.equal((await exited)[0], 0);
    await assert.rejects(lstat(peer.path), { code: "ENOENT" });
  }
});
