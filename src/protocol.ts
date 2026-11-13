import { randomUUID } from "node:crypto";

export const VERSION = 2;
export const LIMITS = {
  contentBytes: 16 * 1024,
  frameBytes: 24 * 1024,
  connections: 16,
  pending: 64,
  duplicates: 256,
  outgoing: 256,
  notifications: 64,
  timeoutMs: 5000,
} as const;
export type Delivery = "followUp" | "steer" | "nextTurn";
export interface Identity { pid: number; instance: string; generation: string }
export interface Envelope {
  version: typeof VERSION;
  id: string;
  sender: Identity;
  recipient: Identity;
  content: string;
  delivery: Delivery;
  replyTo?: string;
}
export interface RecordedUpdate {
  version: typeof VERSION;
  type: "recorded";
  id: string;
  sender: Identity;
  recipient: Identity;
  recordedAt: number;
}
export type Packet = Envelope | RecordedUpdate;
export interface Receipt {
  type: "accepted";
  id: string;
  recipient: Identity;
  acceptedAt: number;
}
export function identity(pid = process.pid, instance: string = randomUUID()): Identity {
  return { pid, instance, generation: randomUUID() };
}
export function isPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 2147483647;
}
export function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
}
export function isIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== "object") return false;
  const v = value as Identity;
  return isPid(v.pid) && isToken(v.instance) && isToken(v.generation);
}
export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.pid === b.pid && a.instance === b.instance && a.generation === b.generation;
}
export function validateEnvelope(value: unknown): Envelope {
  if (!value || typeof value !== "object") throw new Error("Malformed envelope");
  const v = value as Envelope;
  if (v.version !== VERSION || !isToken(v.id) || !isIdentity(v.sender) || !isIdentity(v.recipient)
    || typeof v.content !== "string" || !v.content.trim()
    || Buffer.byteLength(v.content) > LIMITS.contentBytes
    || !["followUp", "steer", "nextTurn"].includes(v.delivery)
    || (v.replyTo !== undefined && !isToken(v.replyTo))) throw new Error("Invalid envelope fields or size");
  return v;
}
export function validateRecordedUpdate(value: unknown): RecordedUpdate {
  if (!value || typeof value !== "object") throw new Error("Malformed recording update");
  const v = value as RecordedUpdate;
  if (v.version !== VERSION || v.type !== "recorded" || !isToken(v.id)
    || !isIdentity(v.sender) || !isIdentity(v.recipient)
    || !Number.isSafeInteger(v.recordedAt) || v.recordedAt < 0
    || Object.keys(v).some(key => !["version", "type", "id", "sender", "recipient", "recordedAt"].includes(key))) {
    throw new Error("Invalid recording update");
  }
  return v;
}
export function recordingUpdate(envelope: Envelope, recordedAt = Date.now()): RecordedUpdate {
  return { version: VERSION, type: "recorded", id: envelope.id,
    sender: envelope.recipient, recipient: envelope.sender, recordedAt };
}
export function messageKey(envelope: Envelope): string {
  return `${envelope.sender.pid}:${envelope.sender.instance}:${envelope.id}`;
}
export function deliveryOptions(delivery: Delivery) {
  return delivery === "nextTurn"
    ? { deliverAs: delivery }
    : { deliverAs: delivery, triggerTurn: true };
}
/** Plain terminal text, never executable escape sequences or bidi overrides. */
export function safeText(value: unknown): string {
  return String(value ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/\t/g, "    ");
}
