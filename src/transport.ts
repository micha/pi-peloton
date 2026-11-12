import { createServer, createConnection, type Server, type Socket } from "node:net";
import { mkdir, lstat, chmod, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LIMITS, VERSION, isIdentity, isPid, sameIdentity, validateEnvelope,
  type Identity, type Envelope, type Delivery, type Receipt } from "./protocol.ts";

export function runtimeDirectory(env = process.env, home = homedir()): string {
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "pi-peloton") : join(home, ".pi", "peloton-runtime");
}
export function socketPath(directory: string, pid: number): string {
  if (!isPid(pid)) throw new Error("Target must be a positive Pi PID");
  const path = join(directory, `${pid}.sock`);
  if (Buffer.byteLength(path) > 100) throw new Error("Unix socket path exceeds 100 bytes; use a shorter runtime directory");
  return path;
}
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error("Peloton runtime directory must be a real, owner-only directory");
  }
}

/** One LF-terminated JSON frame at a time. Byte limits apply before decoding. */
function frames(socket: Socket, onFrame: (value: unknown) => void, onError: (error: Error) => void) {
  let buffer = Buffer.alloc(0);
  socket.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const end = buffer.indexOf(10);
      if ((end < 0 && buffer.length > LIMITS.frameBytes) || end > LIMITS.frameBytes) {
        onError(new Error("Frame too large")); return;
      }
      if (end < 0) break;
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
      catch { onError(new Error("Malformed JSON or UTF-8 frame")); return; }
      try { onFrame(value); }
      catch (error) { onError(error instanceof Error ? error : new Error("Invalid frame")); return; }
      if (socket.destroyed) return;
    }
  });
}
function write(socket: Socket, value: unknown) { socket.write(`${JSON.stringify(value)}\n`); }

async function removeStaleSocket(path: string) {
  let stat;
  try { stat = await lstat(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Refusing to replace non-owned socket path");
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(path);
    probe.setTimeout(LIMITS.timeoutMs, () => { probe.destroy(); reject(new Error("Existing socket probe timed out")); });
    probe.once("connect", () => { probe.destroy(); reject(new Error("A Peloton endpoint is already active for this PID")); });
    probe.once("error", async error => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") { reject(error); return; }
      try {
        const current = await lstat(path);
        if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error("Socket changed during stale cleanup");
        await unlink(path); resolve();
      } catch (e) { reject(e); }
    });
  });
}

export class PeerServer {
  private server?: Server;
  private sockets = new Set<Socket>();
  private closePromise?: Promise<void>;
  private seen = new Map<string, { envelope: string; receipt: Receipt }>();
  private path?: string;
  private owned?: { ino: number; dev: number };
  constructor(readonly directory: string, readonly identity: Identity,
    private accept: (envelope: Envelope) => void,
    private report: (error: Error) => void = () => {}) {}

  async start() {
    await privateDirectory(this.directory);
    this.path = socketPath(this.directory, this.identity.pid);
    await removeStaleSocket(this.path);
    const server = createServer(socket => {
      if (this.sockets.size >= LIMITS.connections) { socket.destroy(); return; }
      this.sockets.add(socket);
      const deadline = setTimeout(() => socket.destroy(), LIMITS.timeoutMs);
      deadline.unref();
      socket.once("close", () => { clearTimeout(deadline); this.sockets.delete(socket); });
      socket.on("error", () => {});
      let used = false;
      write(socket, { type: "hello", version: VERSION, identity: this.identity });
      const fail = (error: Error) => {
        this.report(error);
        if (!socket.destroyed) socket.end(`${JSON.stringify({ type: "error", error: error.message })}\n`);
      };
      frames(socket, value => {
        if (used) throw new Error("Only one message is allowed per connection");
        used = true;
        const envelope = validateEnvelope(value);
        if (!sameIdentity(envelope.recipient, this.identity)) throw new Error("Stale recipient conversation or process");
        const key = `${envelope.sender.pid}:${envelope.sender.instance}:${envelope.id}`;
        const fingerprint = JSON.stringify(envelope);
        const existing = this.seen.get(key);
        if (existing) {
          if (existing.envelope !== fingerprint) throw new Error("Message ID reused with different content");
          socket.end(`${JSON.stringify(existing.receipt)}\n`); return;
        }
        this.accept(envelope);
        const receipt: Receipt = { type: "accepted", id: envelope.id, recipient: this.identity, acceptedAt: Date.now() };
        this.seen.set(key, { envelope: fingerprint, receipt });
        if (this.seen.size > LIMITS.duplicates) this.seen.delete(this.seen.keys().next().value!);
        socket.end(`${JSON.stringify(receipt)}\n`);
      }, fail);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.path!, () => { server.removeListener("error", reject); resolve(); });
      });
      server.on("error", this.report);
      await chmod(this.path, 0o600);
      this.owned = await lstat(this.path);
    } catch (error) { await this.close(); throw error; }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      for (const socket of this.sockets) socket.destroy();
      if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
      if (this.path && this.owned) {
        try {
          const stat = await lstat(this.path);
          if (stat.ino === this.owned.ino && stat.dev === this.owned.dev) await unlink(this.path);
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      this.seen.clear();
    })();
    return this.closePromise;
  }
}

export class PeerClient {
  private known = new Map<number, string>();
  constructor(readonly directory: string) {}
  async send(sender: Identity, target: number, content: string, delivery: Delivery = "followUp",
    options: { replyTo?: string; id?: string; signal?: AbortSignal } = {}): Promise<{ envelope: Envelope; receipt: Receipt }> {
    if (target === sender.pid) throw new Error("Cannot send to this Pi instance");
    const path = socketPath(this.directory, target);
    await privateDirectory(this.directory);
    const stat = await lstat(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Unsafe peer socket permissions");
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let envelope: Envelope | undefined;
      let settled = false;
      const finish = (error?: Error, receipt?: Receipt) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        clearTimeout(deadline);
        socket.destroy();
        if (error) reject(error); else resolve({ envelope: envelope!, receipt: receipt! });
      };
      const abort = () => finish(new Error("Peer send aborted; acceptance may be unknown"));
      options.signal?.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(() => finish(new Error("Peer timed out; acceptance may be unknown")), LIMITS.timeoutMs);
      socket.on("error", error => finish(error));
      socket.on("close", () => finish(new Error("Peer disconnected before acknowledgement; acceptance may be unknown")));
      frames(socket, value => {
        const v = value as Record<string, unknown>;
        if (!v || typeof v !== "object") throw new Error("Malformed response");
        if (v.type === "error") throw new Error(typeof v.error === "string" ? v.error : "Peer rejected message");
        if (!envelope) {
          if (v.type !== "hello" || v.version !== VERSION || !isIdentity(v.identity) || v.identity.pid !== target) throw new Error("Invalid peer handshake");
          const previous = this.known.get(target);
          if (previous && previous !== v.identity.instance) throw new Error("Peer PID now belongs to a replacement process; restart sender session to reconnect deliberately");
          this.known.set(target, v.identity.instance);
          if (this.known.size > LIMITS.duplicates) this.known.delete(this.known.keys().next().value!);
          envelope = validateEnvelope({ version: VERSION, id: options.id ?? randomUUID(), sender,
            recipient: v.identity, content, delivery, ...(options.replyTo ? { replyTo: options.replyTo } : {}) });
          write(socket, envelope);
        } else {
          const receipt = v as unknown as Receipt;
          if (receipt.type !== "accepted" || receipt.id !== envelope.id || !isIdentity(receipt.recipient)
            || !sameIdentity(receipt.recipient, envelope.recipient) || !Number.isSafeInteger(receipt.acceptedAt)) throw new Error("Invalid acknowledgement");
          finish(undefined, receipt);
        }
      }, error => finish(error));
    });
  }
}
