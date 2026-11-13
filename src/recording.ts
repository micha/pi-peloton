import { setTimeout as delay } from "node:timers/promises";
import { LIMITS, sameIdentity, type Envelope, type RecordedUpdate } from "./protocol.ts";

type SendStage = "sending" | "accepted" | "recorded" | "error";
export interface TrackedSend {
  envelope: Envelope;
  stage: SendStage;
  update?: RecordedUpdate;
  invalidate?: () => void;
}

/** Bounded live correlation; durable status history belongs to Pi's session. */
export class Outgoing {
  private entries = new Map<string, TrackedSend>();
  prepare(envelope: Envelope) {
    if (this.entries.has(envelope.id)) throw new Error("Outgoing message ID already exists");
    if (this.entries.size >= LIMITS.outgoing) {
      const evictable = [...this.entries].find(([, send]) => send.stage !== "sending");
      if (!evictable) throw new Error("Outgoing correlation limit reached");
      this.entries.delete(evictable[0]);
    }
    this.entries.set(envelope.id, { envelope, stage: "sending" });
  }
  get(id: string): TrackedSend | undefined { return this.entries.get(id); }
  accepted(id: string) {
    const send = this.entries.get(id);
    if (send && send.stage !== "recorded") send.stage = "accepted";
  }
  failed(id: string) {
    const send = this.entries.get(id);
    if (send && send.stage !== "recorded") send.stage = "error";
  }
  receive(update: RecordedUpdate): boolean {
    const send = this.entries.get(update.id);
    if (!send) throw new Error("Unknown or expired recording correlation");
    if (!sameIdentity(update.sender, send.envelope.recipient)
      || !sameIdentity(update.recipient, send.envelope.sender)) throw new Error("Recording update identity mismatch");
    if (send.update) {
      if (send.update.recordedAt !== update.recordedAt) throw new Error("Conflicting recording update");
      return false;
    }
    send.update = update;
    send.stage = "recorded";
    return true;
  }
  watch(id: string, invalidate: () => void) {
    const send = this.entries.get(id);
    if (send) send.invalidate = invalidate;
  }
  refresh(id: string) { this.entries.get(id)?.invalidate?.(); }
  clear() { this.entries.clear(); }
}

/** Pi 1.0.3 dispatches extension message_end before appending the session entry. */
export async function waitForRecording(check: () => boolean, signal: AbortSignal, timeout: number = LIMITS.timeoutMs) {
  const deadline = Date.now() + timeout;
  while (true) {
    signal.throwIfAborted();
    if (check()) return;
    if (Date.now() >= deadline) throw new Error("Pi recording observation timed out");
    await delay(10, undefined, { signal });
  }
}

/** Serial, best-effort notifications: no model work, no retries, bounded backlog. */
export class RecordingNotifications {
  private queue: RecordedUpdate[] = [];
  private worker?: Promise<void>;
  private abort = new AbortController();
  private closed = false;
  constructor(private send: (update: RecordedUpdate, signal: AbortSignal) => Promise<unknown>,
    private failed: (update: RecordedUpdate, error: Error) => void) {}
  enqueue(update: RecordedUpdate) {
    if (this.closed) throw new Error("Recording notifications are closed");
    if (this.queue.length + (this.worker ? 1 : 0) >= LIMITS.notifications) throw new Error("Recording notification limit reached");
    this.queue.push(update);
    this.start();
  }
  private start() {
    if (this.worker || this.closed) return;
    this.worker = this.drain().finally(() => {
      this.worker = undefined;
      if (this.queue.length && !this.closed) this.start();
    });
  }
  private async drain() {
    while (this.queue.length && !this.closed) {
      const update = this.queue.shift()!;
      try { await this.send(update, this.abort.signal); }
      catch (error) {
        if (!this.closed) {
          // A reporting failure must not become an unhandled process rejection.
          try { this.failed(update, error instanceof Error ? error : new Error(String(error))); } catch {}
        }
      }
    }
  }
  async close() {
    this.closed = true;
    this.queue = [];
    this.abort.abort();
    await this.worker;
  }
}
