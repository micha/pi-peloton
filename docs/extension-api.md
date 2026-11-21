# Extension integration API v1

Peloton exposes a **process-local** `pi.events` request/reply API. Another extension
can send without an LLM call, invoking a model tool, or importing raw transport.
Peloton must be loaded and its `session_start` completed in the sending process;
the recipient must also have a ready Peloton endpoint. This API is experimental,
tested with Pi 1.0.3, and independent of Peloton wire protocol v2.

## Consumer example

Import the helper module from your checkout (adjust the absolute path), **not**
the extension factory. Installing a Pi package does not by itself make it an npm
module resolvable from every other extension. No package-name import is promised.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendPeerMessage, onPeerDelivery } from "/path/to/pi-peloton/src/api.ts";

export default function (pi: ExtensionAPI) {
  let stop: (() => void) | undefined;
  let lifetime = new AbortController();

  pi.on("session_start", () => {
    lifetime = new AbortController();
    stop = onPeerDelivery(pi.events, status => {
      // Metadata only. Do not send another peer message in response to a status.
      if (status.stage === "recorded") {
        pi.appendEntry("my-extension.recorded", { messageId: status.messageId });
      }
    });
  });
  pi.on("session_shutdown", () => {
    lifetime.abort();
    stop?.();
    stop = undefined;
  });

  pi.registerCommand("send-note", {
    description: "Send a confirmed note: /send-note <Pi PID> <text>",
    handler: async (args, ctx) => {
      const match = /^(\d+)\s+([\s\S]+)$/.exec(args.trim());
      if (!match) { ctx.ui.notify("Use /send-note <Pi PID> <text>", "warning"); return; }
      const signal = lifetime.signal;
      if (!(await ctx.ui.confirm("Send collaborator note?", match[2])) || signal.aborted) return;
      // Application-specific session/response association must be checked here.
      const result = await sendPeerMessage(pi.events, {
        target: Number(match[1]), content: match[2], delivery: "followUp",
      }, { signal });
      if (signal.aborted) return; // Do not use a replaced session's context.
      ctx.ui.notify(result.ok
        ? `${result.messageId}: ${result.stage}`
        : `${result.error.code}: ${result.error.message}`, result.ok ? "info" : "warning");
    },
  });
}
```

Peloton does **not** obtain approval or validate application associations for you.
The receiving model still sees attributed **collaborator input, not human
authorization**, even if your extension obtained approval to send it. The example's
confirmation approves sending, not actions described by the text.

## Helper contract

Exports and full TypeScript definitions live in [`src/api.ts`](../src/api.ts).
Trusted extensions can also use `registerPeerRoute(events, { target, directory },
{ signal, timeoutMs? })` to reach a newly launched private endpoint without
rebinding Peloton. The required signal owns revocation; targets are one-shot per
lifecycle and never fall back after revocation. This is not a model-facing send
option. See the [bootstrap/private-routing contract](namespace-routing.md).

```ts
sendPeerMessage(events, { target, content, delivery?, replyTo? }, { signal?, timeoutMs? }?)
  // Promise<PeerSendResult>
onPeerDelivery(events, listener)
  // () => void  (unsubscribe)
```

- `target`: receiving **Pi process PID**, integer 1–2147483647, not a tmux shell PID.
- `content`: nonblank, at most 16 KiB UTF-8. Unknown input fields fail validation.
- `delivery`: `followUp` by default; explicit `steer` has the
  [tool's semantics](../README.md#delivery-modes). The API additionally accepts
  passive `nextTurn` context, which is not a model-tool choice; see below.
  `replyTo` is an optional 1–80 character alphanumeric/hyphen message ID, not a
  routing or authorization token.
- Every helper call allocates a fresh `messageId`, also used as its request ID.
  `senderSession` identifies the local Pi session when available, not the recipient.
- `ok: true` means an acceptance receipt arrived. `acceptance` is `accepted`,
  `stage` is `accepted` or already `recorded`, and `acceptedAt` is the recipient's
  receipt timestamp. Recording can arrive before acceptance.
- `ok: false` carries `error: { code, message }`. `acceptance` is `not-sent`,
  `unknown`, or `accepted`; `stage` is `error` or `recorded`. A lost acknowledgement
  after proven recording is an error **with** `acceptance: "accepted"` and
  `stage: "recorded"`. Do not reduce this to “not delivered.”
- Error codes: `invalid_request`, `unavailable`, `busy`, `duplicate_request`,
  `send_failed`, `cancelled`, `session_changed`, `timeout`. `send_failed` includes
  unknown peers, permission/protocol/identity failures, rejection, and transport
  timeouts. Errors are returned, not normally thrown by the helper.
- The helper's reply deadline defaults to **6000 ms**; `timeoutMs` must be positive
  and at most 2147483647. A missing/stopped Peloton listener produces `timeout`,
  not an endless wait. A disposed Pi event bus produces `unavailable`.
- Cancellation/deadline removes the helper's reply listener and aborts its local
  request signal. Cancellation after emission conservatively reports `unknown`:
  it cannot retract content accepted by the recipient. There are **no retries**.
  A returned timeout/cancellation snapshot does not subsequently mutate.

Valid admitted extension sends create normal, non-model `peloton.sent` and
`peloton.send-result` session entries and one outgoing card. Invalid input and
capacity rejection return errors without a send card. Model tool calls retain
their existing result details/cards; both entry points share sending logic and
bounds. Neither an outbound API call nor a delivery-status update adds sender
model input or starts a sender turn. Actual peer content follows the requested
recipient delivery mode.

## Passive context (`nextTurn`)

`sendPeerMessage(..., { target, content, delivery: "nextTurn" })` leaves passive
context without waking the recipient. The wire protocol and incoming/history
renderers also retain this mode. `peer_send` exposes only `followUp` and `steer`;
old/direct tool calls requesting `nextTurn` fail without sending or substituting
another mode.

Pi owns the passive queue, and its drain conditions differ by version:

| Pi version | After a normal user prompt | After `followUp` or `steer` wakes an idle peer |
| --- | --- | --- |
| 1.0.3 | Recorded after the user message, before the assistant response | Remains queued until a subsequent user prompt |
| 1.6.0 | Recorded after the user message, before the assistant response | Recorded after the waking peer message, before the assistant response |

Thus an older passive note can appear after a newer waking message. It is not
converted to a follow-up, does not request a separate run, and is **not** a
human-prompt-only guarantee. In Pi 1.6.0 source, new-run preparation drains this
queue for user or custom-message starts; steering/follow-up delivery within an
already-running peer is a different path, not a guaranteed drain boundary.

The table is covered by an isolated deterministic RPC probe for those two exact
versions, not a live TUI check or a supported-version range. Other versions and
busy/retry/compaction/lifecycle interleavings need separate verification. See the
[verification record](verification.md#two-mode-model-tool-and-passive-delivery-correction--2026-11-21).
Use passive context only where these deferred/reordered delivery semantics are
acceptable, not for active coordination.

## Delivery observation

`onPeerDelivery` subscribes to live **outgoing** statuses for both API and tool
sends. It does not observe incoming message content. Events include `messageId`,
`senderSession`, `target`, `delivery`, `at`, and:

- `stage: sending | accepted | recorded | error`, with an optional error string;
- or `stage: untracked`, `lastStage`, and `reason: lifecycle | evicted` when a live
  correlation is discarded. This ends observation, not delivery, and does not
  undo the last known stage. `error` can later advance to `recorded` if proof arrives.

These events carry no content, socket paths, or process nonces. `sending` begins
when the handshake prepares the envelope; pre-handshake failures are reported in
the result, without a live status event. Early recording is monotonic: subsequent
acceptance or acknowledgement failure does not emit a regressive stage.

Subscribe before sending if observing all stages; correlate with the returned
message ID. A result's `stage` includes recording observed before that result,
so callers need not wait for a second event for early recording. Observers are
best-effort, not replay subscriptions: after reload, inspect your own persisted
IDs and Peloton's branch metadata if historical evidence is needed. Unsubscribe
on `session_shutdown`; avoid slow handlers and automatic message/status loops.
No event implies model consumption, a response, or task completion.

## Raw bus contract

Consumers may instead implement bounded request/reply handling using the exported
types, without runtime imports. Event names are versioned:

| Event | Payload |
| --- | --- |
| `peloton:send:v1` | `PeerSendRequest`: `{ requestId, input, signal? }` |
| `peloton:send-result:v1:<requestId>` | `PeerSendResponse`: `{ requestId, result }` |
| `peloton:delivery:v1` | `PeerDeliveryStatus` |

`PELOTON_SEND`, `PELOTON_SEND_RESULT` (reply-channel prefix), `PELOTON_DELIVERY`,
and `peerSendResultEvent(requestId)` expose these names. Reply channels are per
request, avoiding a shared-channel listener limit under concurrent sends.

Subscribe to the reply channel **before** emitting; use a deadline, cancellation,
and `finally`-based listener cleanup. `pi.events.emit()` returns `void`: awaiting
it does not await the send. Its handlers' exceptions are not request replies.
Use a fresh 1–80 character alphanumeric/hyphen `requestId` for every operation;
it becomes the transport message ID. Recent duplicate IDs are rejected (256
remembered per session, plus live sends), not retried or replayed. This is not
cross-session idempotency. Requests without a valid correlation ID are ignored;
unsupported event versions have no listener. `signal` must be a local
`AbortSignal`, not a JSON object. This bus is neither RPC nor cross-process IPC.

## Lifecycle and association limits

The request listener exists only after successful endpoint startup and is removed
on shutdown/reload/session replacement. Active sends are aborted and their results
settled/journaled before the old context is abandoned. New sessions bind a fresh
listener; old requests are never moved into them. Calling from a consumer's
`session_start` before Peloton starts can time out; prefer user commands after
startup. Do not retain an old `pi.events`/context across replacement runtimes.

Up to 16 active sends share the tool/API path. Outgoing correlations remain
bounded to 256; recording notifications are best-effort and may be lost. There
are no automatic retries, sessions, models, or transport-mode substitutions.

**A PID means the current conversation**, not the conversation/response from
which your integration originated. The handshake pins the conversation observed
on that connection, but cannot establish your application's earlier association.
Consumers must validate their own original session/response association and any
stale-resolution policy; `replyTo` does not do this. This API deliberately has no
session setup, fork, approval, restatement, or domain-specific resolution logic.
Pi owns its native queues; stale-content filtering cannot guarantee cancellation
of an already-scheduled recipient turn. Same-user peers/extensions are trusted
code, not an authentication boundary.
