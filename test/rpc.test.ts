import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { PeerClient, socketPath } from "../src/transport.ts";
import { identity } from "../src/protocol.ts";

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

test("two isolated Pi 1.0.3 subprocesses load local package, accept passive messages and clean up", { timeout: 45000 }, async t => {
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
  async function start(name: string) {
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
    const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-builtin-tools"], { cwd: root, env });
    children.push(child);
    const request = rpc(child);
    await request("get_state");
    const path = socketPath(join(runtime, "pi-peloton"), child.pid!);
    await lstat(path);
    return { child, request, path };
  }
  const a = await start("a");
  const b = await start("b");
  const client = new PeerClient(join(runtime, "pi-peloton"));
  await client.send(identity(a.child.pid!), b.child.pid!, "Please review HANDOFF.md, without starting work yet.", "nextTurn");
  const state = await b.request("get_state");
  assert.equal(state.isStreaming, false);
  const records = await b.request("get_entries");
  const queued = records.entries.find((entry: any) => entry.customType === "peloton.status" && entry.data.kind === "queued");
  assert.equal(queued.data.envelope.sender.pid, a.child.pid);
  assert.equal(queued.data.envelope.delivery, "nextTurn");
  assert.ok(!records.entries.some((entry: any) => entry.type === "message" && entry.message.role === "assistant"));

  // A human-equivalent conversation switch in the isolated test recipient.
  await b.request("new_session");
  // Session lifecycle awaits new listener creation; PID still locates the peer.
  await client.send(identity(a.child.pid!), b.child.pid!, "Message for the newly prepared conversation.", "nextTurn");
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
