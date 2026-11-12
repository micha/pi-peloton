import { LIMITS, sameIdentity, messageKey, type Envelope, type Identity } from "./protocol.ts";

/** Tracks admission, not model consumption. Pi owns actual delivery queues. */
export class Inbox {
  readonly pending = new Map<string, Envelope>();
  constructor(readonly recipient: Identity) {}
  accept(envelope: Envelope) {
    if (!sameIdentity(envelope.recipient, this.recipient)) throw new Error("Stale recipient");
    if (this.pending.size >= LIMITS.pending) throw new Error("Peer pending-message limit reached");
    this.pending.set(messageKey(envelope), envelope);
  }
  recorded(envelope: Envelope) { this.pending.delete(messageKey(envelope)); }
  close(): Envelope[] {
    const pending = [...this.pending.values()];
    this.pending.clear();
    return pending;
  }
}
