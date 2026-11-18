import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Delivery } from "./protocol.ts";
import type { PeerRouteInput } from "./configuration.ts";
export type { PeerRouteInput } from "./configuration.ts";

/** Process-local API v1, independent of the Peloton wire protocol version. */
export const PELOTON_SEND = "peloton:send:v1";
export const PELOTON_SEND_RESULT = "peloton:send-result:v1";
export const PELOTON_DELIVERY = "peloton:delivery:v1";
export const PELOTON_ROUTE = "peloton:route:v1";
export function peerRouteResultEvent(requestId: string): string { return `peloton:route-result:v1:${requestId}`; }
export type PeerRouteErrorCode = "invalid_request" | "unavailable" | "conflict" | "limit" | "cancelled" | "timeout";
export type PeerRouteResult = { ok: true; target: number } | { ok: false; error: { code: PeerRouteErrorCode; message: string } };
/** The signal owns the route after success: abort it to revoke. No retries/replacement. */
export interface PeerRouteRequest { requestId: string; input: PeerRouteInput; signal: AbortSignal }
export interface PeerRouteResponse { requestId: string; result: PeerRouteResult }
/** A separate reply channel per request avoids accumulating listeners on one event. */
export function peerSendResultEvent(requestId: string): string { return `${PELOTON_SEND_RESULT}:${requestId}`; }
export type PelotonEvents = ExtensionAPI["events"];
export interface PeerSendInput {
  target: number;
  content: string;
  delivery?: Delivery;
  replyTo?: string;
}
export type PeerSendErrorCode = "invalid_request" | "unavailable" | "busy" | "duplicate_request"
  | "send_failed" | "cancelled" | "session_changed" | "timeout";
export type PeerSendResult = {
  messageId: string;
  senderSession?: string;
} & ({
  ok: true;
  acceptance: "accepted";
  stage: "accepted" | "recorded";
  acceptedAt: number;
} | {
  ok: false;
  acceptance: "not-sent" | "unknown" | "accepted";
  stage: "error" | "recorded";
  error: { code: PeerSendErrorCode; message: string };
});
/** requestId is also the outgoing message ID. Always use a fresh ID; never retry it. */
export interface PeerSendRequest { requestId: string; input: PeerSendInput; signal?: AbortSignal }
export interface PeerSendResponse { requestId: string; result: PeerSendResult }
export type PeerDeliveryStage = "sending" | "accepted" | "recorded" | "error";
/** Content-free observation, not a collaborator message or proof of consumption. */
export type PeerDeliveryStatus = {
  messageId: string;
  senderSession: string;
  target: number;
  delivery: Delivery;
  at: number;
} & ({ stage: PeerDeliveryStage; error?: string } | {
  stage: "untracked";
  lastStage: PeerDeliveryStage;
  reason: "lifecycle" | "evicted";
});

/** No transport imports, retries, model call, or persistent subscription. */
export async function sendPeerMessage(events: PelotonEvents, input: PeerSendInput,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PeerSendResult> {
  const messageId = randomUUID();
  const failure = (code: PeerSendErrorCode, message: string, sent: boolean): PeerSendResult => ({
    messageId, ok: false, stage: "error", acceptance: sent ? "unknown" : "not-sent", error: { code, message },
  });
  const timeout = options.timeoutMs ?? 6000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) {
    return failure("invalid_request", "timeoutMs must be positive and at most 2147483647", false);
  }
  if (options.signal?.aborted) return failure("cancelled", "Peloton request cancelled before sending", false);
  const abort = new AbortController();
  let sent = false;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<PeerSendResult>(resolve => {
      unsubscribe = events.on(peerSendResultEvent(messageId), data => {
        const response = data as PeerSendResponse | undefined;
        if (response?.requestId === messageId && response.result?.messageId === messageId
          && typeof response.result.ok === "boolean") resolve(response.result);
      });
      onAbort = () => {
        // Resolve first: a synchronous cancellation response cannot replace this result.
        resolve(failure("cancelled", "Peloton request cancelled; acceptance may be unknown", sent));
        abort.abort();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        resolve(failure("timeout", "No Peloton result before deadline (extension unavailable or send unresolved); acceptance may be unknown", sent));
        abort.abort();
      }, timeout);
      sent = true;
      events.emit(PELOTON_SEND, { requestId: messageId, input, signal: abort.signal } satisfies PeerSendRequest);
    });
  } catch {
    abort.abort();
    return failure("unavailable", "Peloton event bus is unavailable (possibly a stale extension runtime)", sent);
  } finally {
    try { unsubscribe?.(); } catch { /* A disposed bus must not mask the result. */ }
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Trusted extension capability, not model input. Abort ownership on session_shutdown. */
export async function registerPeerRoute(events: PelotonEvents, input: PeerRouteInput,
  options: { signal: AbortSignal; timeoutMs?: number }): Promise<PeerRouteResult> {
  const failure = (code: PeerRouteErrorCode, message: string): PeerRouteResult => ({ ok: false, error: { code, message } });
  const timeout = options?.timeoutMs ?? 6000;
  if (!(options?.signal instanceof AbortSignal) || !Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) {
    return failure("invalid_request", "Route requires an AbortSignal and a positive timeoutMs at most 2147483647");
  }
  if (options.signal.aborted) return failure("cancelled", "Route owner is already cancelled");
  const requestId = randomUUID();
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  let accepted = false;
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const result = await new Promise<PeerRouteResult>(resolve => {
      stop = events.on(peerRouteResultEvent(requestId), data => {
        const response = data as PeerRouteResponse | undefined;
        if (response?.requestId === requestId && typeof response.result?.ok === "boolean"
          && (!response.result.ok || response.result.target === input.target)) resolve(response.result);
      });
      onAbort = () => { resolve(failure("cancelled", "Route ownership cancelled")); abort.abort(); };
      options.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        resolve(failure("timeout", "No Peloton route result before deadline; registration revoked"));
        abort.abort();
      }, timeout);
      events.emit(PELOTON_ROUTE, { requestId, input, signal } satisfies PeerRouteRequest);
    });
    accepted = result.ok;
    return result;
  } catch {
    return failure("unavailable", "Peloton event bus is unavailable (possibly a stale extension runtime)");
  } finally {
    if (!accepted) abort.abort();
    try { stop?.(); } catch {}
    clearTimeout(timer);
    if (onAbort) options.signal.removeEventListener("abort", onAbort);
  }
}

/** Subscribe before sending if observing all stages. Unsubscribe on session_shutdown. */
export function onPeerDelivery(events: PelotonEvents, listener: (status: PeerDeliveryStatus) => void): () => void {
  return events.on(PELOTON_DELIVERY, data => listener(data as PeerDeliveryStatus));
}
