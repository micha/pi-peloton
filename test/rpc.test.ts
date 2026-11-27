import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { PeerClient, PeerServer, socketPath } from "../src/transport.ts";
import { identity, VERSION, type RecordedUpdate } from "../src/protocol.ts";

const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
function rpc(child: ChildProcessWithoutNullStreams) {
  let buffer = "";
  let sequence = 0;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let diagnostics = "";
  let onSettled: ((error?: Error) => void) | undefined;
  child.stderr.on("data", chunk => diagnostics += chunk);
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line);
        if (value.type === "agent_settled") onSettled?.();
        if (value.type === "response") {
          const request = pending.get(value.id);
          pending.delete(value.id);
          if (value.success) request?.resolve(value.data); else request?.reject(new Error(value.error));
        }
      } catch { /* Ignore nonprotocol startup diagnostics; deadlines expose load failures. */ }
    }
  });
  child.on("exit", () => {
    const error = new Error(`Pi exited: ${diagnostics}`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    onSettled?.(error);
  });
  const request = async (type: string, extra = {}) => {
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
  return Object.assign(request, {
    async settledAfter(action: () => Promise<unknown>) {
      assert.equal(onSettled, undefined);
      let timer: NodeJS.Timeout | undefined;
      const settled = new Promise<void>((resolveSettled, reject) => {
        timer = setTimeout(() => reject(new Error(`No agent_settled event: ${diagnostics}`)), 15000);
        onSettled = error => error ? reject(error) : resolveSettled();
      });
      try { await Promise.all([settled, Promise.resolve().then(action)]); }
      finally { clearTimeout(timer); onSettled = undefined; }
    },
  });
}

test("isolated Pi 1.0.3 delivers and records API sends in both directions by local PID", { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "peloton-rpc-"));
  const runtime = join(root, "run");
  const directory = join(runtime, "pi-peloton");
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
  async function start(name: string, extraExtensions: string[], extraArgs: string[]) {
    const config = join(root, name);
    // Allowlist environment: no inherited provider credentials or live Pi config.
    const env = {
      PATH: process.env.PATH, HOME: root, XDG_RUNTIME_DIR: runtime,
      PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    };
    // Verify installation only inside disposable settings, never the user's config.
    const install = spawn(process.execPath, [cli, "install", packagePath], { cwd: root, env });
    let diagnostics = "";
    install.stdout.on("data", chunk => diagnostics += chunk);
    install.stderr.on("data", chunk => diagnostics += chunk);
    assert.equal((await once(install, "exit"))[0], 0, diagnostics);
    assert.ok((await readFile(join(config, "settings.json"), "utf8")).includes(packagePath));
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--session-dir", join(config, "sessions"),
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools",
      ...extraExtensions.flatMap(path => ["-e", path]), ...extraArgs], { cwd: root, env });
    children.push(child);
    const request = rpc(child);
    await request("get_state");
    const pid = child.pid!;
    const path = socketPath(directory, pid);
    assert.equal((await lstat(path)).isSocket(), true);
    return { child, request, path, pid };
  }
  const extensions = [resolve("test/fixtures/api-consumer.ts"), resolve("test/fixtures/record-peer.ts")];
  const provider = ["--provider", "peloton-test", "--model", "model"];
  const a = await start("a", extensions, provider);
  const b = await start("b", extensions, provider);
  const client = new PeerClient(directory);
  const sentByExtension = await a.request("prompt", { message: `/peloton-test-send ${JSON.stringify({
    target: b.pid, content: "Please review HANDOFF.md, without starting work yet.", delivery: "nextTurn", replyTo: "approved-resolution",
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
  const [receiverRuntime] = records.entries.filter((entry: any) => entry.customType === "peloton.runtime");
  assert.equal(receiverRuntime.data.reason, "startup");
  assert.deepEqual(receiverRuntime.data.identity, queued.data.envelope.recipient);
  assert.equal(queued.data.envelope.sender.pid, a.pid);
  assert.equal(queued.data.envelope.recipient.pid, b.pid);
  assert.equal(queued.data.envelope.delivery, "nextTurn");
  assert.equal(queued.data.envelope.id, apiResult.messageId);
  assert.equal(queued.data.envelope.replyTo, "approved-resolution");
  assert.ok(!records.entries.some((entry: any) => entry.type === "message" && entry.message.role === "assistant"));

  // A normal prompt drains Pi's passive queue through the deterministic provider.
  await b.request.settledAfter(() => b.request("prompt", { message: "Read the first passive note." }));
  const controllerIdentity = identity(34567);
  let resolveRecorded!: (update: RecordedUpdate) => void;
  let notificationTimer: NodeJS.Timeout;
  const notification = new Promise<RecordedUpdate>((resolve, reject) => {
    notificationTimer = setTimeout(() => reject(new Error("No native recording notification")), 5000);
    resolveRecorded = update => { clearTimeout(notificationTimer); resolve(update); };
  });
  t.after(() => clearTimeout(notificationTimer));
  let unexpectedInputs = 0;
  const controller = new PeerServer(directory, controllerIdentity, () => unexpectedInputs++, () => {}, resolveRecorded);
  await controller.start();
  t.after(() => controller.close());
  const recordProbe = await client.send(controllerIdentity, b.pid, "native recording probe", "nextTurn");
  await b.request.settledAfter(() => b.request("prompt", { message: "Read the second passive note." }));
  const update = await notification;
  assert.equal(update.id, recordProbe.envelope.id);
  assert.deepEqual(update.recipient, controllerIdentity);
  assert.equal(unexpectedInputs, 0);
  assert.equal((await b.request("get_state")).isStreaming, false);
  const afterRecording = await b.request("get_entries");
  assert.deepEqual(afterRecording.entries.filter((entry: any) => entry.type === "custom_message")
    .map((entry: any) => entry.details?.envelope.id), [apiResult.messageId, update.id]);
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
  // Exercise native recording in the other direction over the same runtime.
  await b.request("prompt", { message: `/peloton-test-send ${JSON.stringify({ target: a.pid, content: "reverse API probe", delivery: "nextTurn", replyTo: apiResult.messageId })}` });
  const reverse = (await b.request("get_entries")).entries.find((entry: any) => entry.customType === "peloton.test-send").data;
  assert.equal(reverse.ok, true);
  await a.request.settledAfter(() => a.request("prompt", { message: "Read the reverse note." }));
  let reverseUpdate: RecordedUpdate | undefined;
  const reverseDeadline = Date.now() + 2000;
  do {
    const entries = (await b.request("get_entries")).entries;
    assert.equal(entries.filter((entry: any) => entry.customType === "peloton.test-model").length, 2);
    reverseUpdate = entries.find((entry: any) => entry.type === "custom" && entry.customType === "peloton.delivery"
      && entry.data.kind === "recorded" && entry.data.update.id === reverse.messageId)?.data.update;
    if (!reverseUpdate) await delay(20); // Recording control is asynchronous, not a model turn.
  } while (!reverseUpdate && Date.now() < reverseDeadline);
  assert.ok(reverseUpdate, "No reverse recording update");
  const reverseEnvelope = (await a.request("get_entries")).entries.find((entry: any) => entry.type === "custom_message"
    && entry.customType === "peloton.peer" && entry.details?.envelope.id === reverse.messageId)?.details.envelope;
  assert.equal(reverseEnvelope?.sender.pid, b.pid);
  assert.equal(reverseEnvelope?.recipient.pid, a.pid);
  assert.equal(reverseEnvelope?.replyTo, apiResult.messageId);
  assert.deepEqual(reverseUpdate.sender, reverseEnvelope.recipient);
  assert.deepEqual(reverseUpdate.recipient, reverseEnvelope.sender);

  // A real reload appends provenance to the existing session, without adding
  // model content. The generation changes while PID and instance stay stable.
  const { sessionFile } = await a.request("get_state");
  const runtimesOnDisk = async () => (await readFile(sessionFile, "utf8")).trimEnd().split("\n")
    .map(line => JSON.parse(line)).filter(entry => entry.customType === "peloton.runtime");
  const initialRuntimes = await runtimesOnDisk();
  assert.equal(initialRuntimes.length, 1);
  const startup = initialRuntimes[0].data;
  assert.equal(initialRuntimes[0].type, "custom");
  assert.equal(startup.packageVersion, JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")).version);
  assert.equal(startup.wireVersion, VERSION);
  assert.match(startup.peerSendDefinitionSha256, /^[0-9a-f]{64}$/);
  const beforeMessages = (await a.request("get_messages")).messages;
  assert.equal((await a.request("prompt", { message: "/peloton-test-reload" })).disposition, "handled");
  const runtimes = await runtimesOnDisk();
  assert.deepEqual(runtimes.map(entry => entry.data.reason), ["startup", "reload"]);
  const reloaded = runtimes[1].data;
  assert.equal(reloaded.identity.pid, startup.identity.pid);
  assert.equal(reloaded.identity.instance, startup.identity.instance);
  assert.notEqual(reloaded.identity.generation, startup.identity.generation);
  assert.equal(reloaded.peerSendDefinitionSha256, startup.peerSendDefinitionSha256);
  const afterMessages = (await a.request("get_messages")).messages;
  assert.doesNotMatch(JSON.stringify(afterMessages), /peerSendDefinitionSha256/);
  const assistantCount = (messages: any[]) => messages.filter(message => message.role === "assistant").length;
  assert.equal(assistantCount(afterMessages), assistantCount(beforeMessages));
  assert.equal((await a.request("get_state")).isStreaming, false);
  // Pi replaces extension runtimes on session changes. The bus API must rebind.
  await a.request("new_session");
  await a.request("prompt", { message: `/peloton-test-send ${JSON.stringify({ target: b.pid, content: "fresh sender", delivery: "nextTurn" })}` });
  const freshSender = (await a.request("get_entries")).entries;
  // Pi's RPC rebinding can emit more than one start for a new conversation.
  const freshRuntime = freshSender.filter((entry: any) => entry.customType === "peloton.runtime").at(-1).data;
  const freshEnvelope = freshSender.filter((entry: any) => entry.customType === "peloton.send-result").at(-1).data.details.envelope;
  assert.equal(freshRuntime.reason, "new");
  assert.equal(freshRuntime.identity.instance, startup.identity.instance);
  assert.notEqual(freshRuntime.identity.generation, reloaded.identity.generation);
  assert.deepEqual(freshRuntime.identity, freshEnvelope.sender);
  assert.equal(freshSender.filter((entry: any) => entry.customType === "peloton.test-send").length, 1);
  assert.equal(freshSender.find((entry: any) => entry.customType === "peloton.test-send").data.ok, true);
  const freshTools = freshSender.find((entry: any) => entry.customType === "peloton.test-tools").data;
  assert.ok(freshTools.registered.includes("peer_send"));
  assert.ok(!freshTools.active.includes("peer_send"));

  // A human-equivalent conversation switch in the isolated test recipient.
  await b.request("new_session");
  // Session lifecycle awaits new listener creation; PID still locates the peer.
  await client.send(controllerIdentity, b.pid, "Message for the newly prepared conversation.", "nextTurn");
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

test("isolated passive nextTurn ordering under human and idle-peer wakeups", { timeout: 30000 }, async t => {
  // Optional compatibility probe; the normal suite still uses the pinned Pi CLI.
  const probeCli = process.env.PI_PELOTON_TEST_CLI ? resolve(process.env.PI_PELOTON_TEST_CLI) : cli;
  const version = JSON.parse(await readFile(resolve(dirname(probeCli), "../../package.json"), "utf8")).version;
  assert.ok(version === "1.0.3" || version === "1.6.0", `No nextTurn expectation defined for Pi ${version}`);
  t.diagnostic(`nextTurn probe: Pi ${version}, CLI ${probeCli}`);
  const root = await mkdtemp(join(tmpdir(), "peloton-next-turn-"));
  const runtime = join(root, "run");
  await mkdir(runtime, { mode: 0o700 });
  // Raw RPC deliberately uses an allowlisted child environment, not inherited credentials.
  const child = spawn(process.execPath, [probeCli, "--mode", "rpc", "--no-session", "--no-extensions",
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools",
    "-e", resolve("src/pi-peloton.ts"), "-e", resolve("test/fixtures/record-peer.ts"),
    "--provider", "peloton-test", "--model", "model"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, XDG_RUNTIME_DIR: runtime,
      PI_CODING_AGENT_DIR: join(root, "settings"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.kill("SIGTERM");
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(root, { recursive: true, force: true });
  });
  const request = rpc(child);
  await request("get_state");
  const directory = join(runtime, "pi-peloton");
  const recipient = child.pid!;
  await lstat(socketPath(directory, recipient));
  const sender = identity(34567);
  const controller = new PeerServer(directory, sender, () => assert.fail("Unexpected peer model input"), () => {}, () => {});
  await controller.start(); t.after(() => controller.close());
  const client = new PeerClient(directory);
  const modelMessages = (entries: any[]) => entries.filter(entry => entry.type === "custom_message"
    || (entry.type === "message" && entry.message.role !== "system"));
  const peerIndex = (messages: any[], id: string) => messages.findIndex(entry => entry.type === "custom_message"
    && entry.customType === "peloton.peer" && entry.details?.envelope?.id === id);
  const userIndex = (messages: any[], text: string) => messages.findIndex(entry => entry.type === "message"
    && entry.message.role === "user" && entry.message.content.some((part: any) => part.text === text));

  for (const trigger of ["human", "followUp", "steer"] as const) {
    if (trigger !== "human") await request("new_session");
    const passive = await client.send(sender, recipient, `passive context before ${trigger}`, "nextTurn");
    assert.equal((await request("get_state")).isStreaming, false);
    const before = (await request("get_entries")).entries;
    const runtimeEntry = before.filter((entry: any) => entry.customType === "peloton.runtime").at(-1);
    assert.equal(runtimeEntry.type, "custom");
    assert.equal(runtimeEntry.data.reason, trigger === "human" ? "startup" : "new");
    assert.deepEqual(runtimeEntry.data.identity, passive.envelope.recipient);
    assert.match(runtimeEntry.data.peerSendDefinitionSha256, /^[0-9a-f]{64}$/);
    assert.equal(peerIndex(modelMessages(before), passive.envelope.id), -1);
    assert.equal(before.filter((entry: any) => entry.customType === "peloton.test-model").length, 0);
    let wakeId = "";
    const humanPrompt = `human prompt for ${trigger}`;
    await request.settledAfter(async () => {
      if (trigger === "human") return request("prompt", { message: humanPrompt });
      const wake = await client.send(sender, recipient, `idle wake via ${trigger}`, trigger);
      wakeId = wake.envelope.id;
    });
    let after = (await request("get_entries")).entries;
    assert.equal(after.filter((entry: any) => entry.customType === "peloton.test-model").length, 1);
    let messages = modelMessages(after);
    const start = trigger === "human" ? userIndex(messages, humanPrompt) : peerIndex(messages, wakeId);
    assert.ok(start >= 0);
    if (trigger === "human" || version === "1.6.0") {
      assert.equal(peerIndex(messages, passive.envelope.id), start + 1);
      assert.equal(messages[start + 2].message.role, "assistant");
    } else {
      assert.equal(peerIndex(messages, passive.envelope.id), -1);
      // Pi 1.0.3 keeps passive context queued through an idle peer wakeup.
      await request.settledAfter(() => request("prompt", { message: humanPrompt }));
      after = (await request("get_entries")).entries;
      messages = modelMessages(after);
      const human = userIndex(messages, humanPrompt);
      assert.ok(human >= 0);
      assert.equal(peerIndex(messages, passive.envelope.id), human + 1);
      assert.equal(messages[human + 2].message.role, "assistant");
      assert.equal(after.filter((entry: any) => entry.customType === "peloton.test-model").length, 2);
    }
    assert.equal(messages.filter(entry => entry.type === "custom_message"
      && entry.details?.envelope?.id === passive.envelope.id).length, 1);
    assert.equal((await request("get_state")).isStreaming, false);
    t.diagnostic(`${trigger}: passive context ${trigger === "human" || version === "1.6.0"
      ? "recorded immediately after the starting message" : "deferred until a subsequent human prompt"}`);
  }
  const exited = once(child, "exit");
  child.stdin.end();
  assert.equal((await exited)[0], 0);
  await assert.rejects(lstat(socketPath(directory, recipient)), { code: "ENOENT" });
});
