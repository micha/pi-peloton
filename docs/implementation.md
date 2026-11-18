# Implementation notes

Contributor reference for the current prototype. Start with [README.md](../README.md)
for installation and user-facing behavior, and [AGENTS.md](../AGENTS.md) for coding
constraints. Verification evidence is in [verification.md](verification.md).

The development target is Pi 1.0.3 on Unix, with Node.js 22.19 or newer. A wider
supported Pi version range has not been selected. Peloton wire protocol **v2** is
separate from the Pi version; mixed v1/v2 endpoints fail before sending content.

## Code map

| File | Responsibility |
| --- | --- |
| `src/pi-peloton.ts` | Pi lifecycle, shared tool/API send path, attributed messages, session metadata, and renderers |
| `src/api.ts` | Exported process-local extension API types, bounded request/reply helper, and delivery subscription |
| `src/protocol.ts` | Envelope/control types, validation, identities, limits, and safe text |
| `src/transport.ts` | PID socket lookup, framed transport, handshakes, receipts, and endpoint cleanup |
| `src/inbox.ts` | Admission tracking for accepted messages not yet recorded |
| `src/recording.ts` | Outgoing correlations, recording observation, and serial notification queue |
| `src/presentation.ts` | Shared card-header format |
| `test/` | Transport, extension, recording, and isolated RPC tests |

## Pi message delivery

`peer_send` takes a receiving Pi PID, content, optional delivery mode, and optional
reply-to ID. It sends only to the peer's current conversation. Socket paths and
process-instance nonces are not model-facing arguments.

| Delivery | `pi.sendMessage()` options |
| --- | --- |
| Follow-up | `deliverAs: "followUp", triggerTurn: true` |
| Steering | `deliverAs: "steer", triggerTurn: true` |
| Passive | `deliverAs: "nextTurn"` |

`triggerTurn` is a per-call option, not a global setting. True wakes an idle
recipient and preserves queued delivery when busy. Explicit false while busy
does not queue a follow-up/steering response. `nextTurn` ignores it and waits for
a user prompt.

Received content is a custom `peloton.peer` message. Its model-visible prefix
identifies the sender PID, message ID, optional reply-to ID, and collaborator
status. Its details retain the envelope, recipient Pi session ID, and acceptance
time. Peer input is never relabelled as a human message or interpreted as a slash
command.

The tool description and active-tool `promptGuidelines` explain automatic reply
delivery and yielding when only waiting. Each guideline names `peer_send`, since
Pi inserts them as flat system-prompt bullets. This is delivery guidance, not an
enforced role or collaboration protocol.

## Programmatic extension sending

The [extension API contract and consumer example](extension-api.md) describe
`sendPeerMessage(pi.events, input, options?)` and `onPeerDelivery()`. Requests use
`peloton:send:v1`; replies use a per-request `peloton:send-result:v1:<id>` channel.
Status observation uses `peloton:delivery:v1`. These are process-local bus events,
not transport packets, RPC commands, or model messages. API v1 is independent of
wire protocol v2. `src/api.ts` has no runtime transport or extension-factory import.

Tool and extension sends call one routine for strict input validation, fresh-ID
correlation, identity checks, transport, aborts, and monotonic outgoing tracking.
There are at most 16 concurrent active sends across both origins. API request IDs
are also transport message IDs; the helper generates a fresh UUID for each call.
A bounded 256-ID recent-request set rejects duplicates, supplemented by active
sends/live outgoing correlations; this is not durable cross-session idempotency.

The API listener starts only after endpoint startup and is unsubscribed on close.
Lifecycle cleanup aborts active sends and waits for their results to be journaled
before abandoning the old context. The helper independently bounds reply waits
(default 6 seconds), propagates cancellation, and removes its per-request listener
in `finally`. Missing Peloton, unsupported event versions, or lost replies cannot
leave helper callers waiting indefinitely. Cancellation/deadline can leave
acceptance unknown; no entry point retries automatically.

Content-free live status events cover prepared sends and recording, plus explicit
`untracked` events on correlation eviction/lifecycle clearing. Recording remains
monotonic even before acceptance or after a lost acknowledgement. A failed result
can therefore carry proven `recorded`/`accepted` status. Metadata events never
invoke `pi.sendMessage()` or trigger model turns. Observers do not get replay.

PID targets still address current conversations; neither this API nor `replyTo`
pins the consumer's original session/response association. That validation and
any approval or restatement policy belongs to the consumer, not Peloton.

## Rendering and session records

The footer is `{pid} →{pending_send} ←{pending_receive}`. Outgoing counts include
live correlations in `sending` or `accepted`, not `recorded`/`error`; incoming
counts use the inbox admission backlog, released on native delivery. Sends enter
tracking when the handshake prepares their envelope. Lost recording updates can
leave a count positive until correlation eviction. Historical cards do not
reconstitute live counts after a session change/reload.

Refresh the footer on admission, send preparation/acceptance/failure, native
incoming delivery, and outgoing recording updates. Cache the displayed string to
avoid redundant redraws; clear it on shutdown. This is UI-only and does not add
model input or start a turn.

All cards use `PEER {←|→} Pi PID {pid} · {delivery} · {status}` followed by message
content. Incoming acceptance is dim; recorded headers are accented with
full-contrast bodies. Expanded views show correlation metadata without repeated
acceptance/recording notices.

- `peloton.status`: transcript-only entries for immediate acceptance visibility,
  errors, and invalidated pending messages. Acceptance content hides after
  recording but remains available under Ctrl-O.
- `peloton.peer`: recorded custom messages that enter model context.
- Tool-result details: original envelope, receipt, message ID, sender session ID,
  and any transport error. Outgoing call/result renderers share row state so they
  update one card rather than duplicate it.
- `peloton.delivery`: non-model recording-status and notification-failure metadata.
  It has no separate chat renderer and never becomes an inbound prompt.
- `peloton.sent`: one non-model outgoing card/record for each valid admitted API
  send, with message ID, normalized input, sender session ID, and timestamp.
- `peloton.send-result`: API send outcome plus the same envelope/receipt/error
  details used by the tool. It has no renderer. The sent card reads live tracking
  and branch result/recording metadata, including after reload; restoration does
  not recreate live correlations or add model input.

Pi omits custom entries whose renderer returns undefined. Acceptance entries
therefore retain a component that renders no content when hidden, allowing
Ctrl-O to reveal it later, including after resume. Outgoing recording updates use
the tool renderer's invalidation callback to refresh the existing row.

## Transport, identity, and lifecycle

Sockets are named `<pi-pid>.sock` under `$XDG_RUNTIME_DIR/pi-peloton/`, falling back
to `~/.pi/peloton-runtime/`. The leaf directory must be a real, owner-only
directory; sockets are mode `0600`. Paths over 100 bytes fail clearly. There is no
separate registry file: the handshake provides endpoint identity.

A process-instance nonce distinguishes PID replacements and survives extension
reload within that process. A conversation-generation nonce changes with
`session_start`. First contact with a bare PID means the instance currently at
that PID. The client remembers at most 256 observed process identities within
its active session and rejects known replacements; a new sender session/reload
permits deliberate first contact again.

The handshake binds a send to the conversation observed on that connection;
acceptance rejects a changed process/generation. PID targets themselves remain
stable across conversation changes. tmux discovery is agent-driven: pane PIDs may
identify shells, so process-tree inspection may be needed. A future resolver must
reject ambiguity rather than choose a peer silently.

Resources start from `session_start` and close idempotently on `session_shutdown`.
Reload/session changes restart listeners, invalidate locally tracked pending
messages, and cancel recording notifications. A context filter excludes stale or
invalidated peer content while preserving recorded history. Pi owns the native
queues: filtering cannot cancel a turn already scheduled by Pi.

## Recording control updates

When an incoming custom message reaches native `message_end`, the recipient
queues a content-free recording update. The worker first waits until the matching
custom-message entry is observable in the active Pi branch, then sends it over
the same socket transport to the original sender.

This ordering matters in Pi 1.0.3: extension `message_end` runs **before** session
append. Also, direct `triggerTurn:false` appends emit session events but do not
dispatch that extension hook. Peloton's follow-up/steering and next-user-turn
paths use native agent events; do not infer recording from acceptance or from an
unverified append path.

Control packets carry the original message ID, reversed original sender/recipient
identities, and a recording timestamp. Validation checks both process and
conversation identities against a live outgoing correlation. Control packets do
not pass through peer-content delivery or trigger model work.

An update can arrive before the acceptance response. The outgoing stage remains
monotonic: later acceptance or a lost-acknowledgement error cannot regress
observed recording. Duplicate updates do not append repeated status metadata;
conflicting updates fail. Recorded branch metadata restores historical cards
without re-injecting message content.

Notifications are serial and best-effort, with no retries or notification loops.
Failures are journaled without message content and surfaced locally. On loss,
expiration, session change, or shutdown, the sender keeps its last observed state.
Recording is a transcript stage, not proof of model consumption or task completion.

## Bounds and failure semantics

Current constants live in `src/protocol.ts`:

| Bound | Value |
| --- | --- |
| UTF-8 message content | 16 KiB |
| JSONL frame | 24 KiB |
| Concurrent accepted connections | 16 |
| Concurrent active sends, tool and extension combined | 16 |
| Connection deadline | 5 seconds |
| Accepted messages not yet recorded | 64 |
| Live outgoing correlations | 256 |
| Recording notifications, including the active send | 64 |
| Recording-observation deadline | 5 seconds |
| Recent accepted packets for duplicate detection | 256 |
| Recent local extension request IDs | 256 |
| Extension-helper reply deadline, configurable | 6 seconds |

Identical duplicates return the original receipt; reusing an ID with changed
fields fails. Eviction and listener restart lose transport duplicate history.
Timeout/abort/lost acknowledgement can leave acceptance unknown, so retrying with
a new ID may duplicate work. There are no automatic retries. Protocol-error UI
reporting is rate-limited to avoid flooding the recipient.

Same-user identity is claimed metadata, not strong authentication. A hostile
same-user process can impersonate a peer. Received text is never evaluated or
interpolated into shell commands. Renderers escape terminal controls and bidi
overrides. Do not put credentials or transcripts into discovery metadata or add
a separate message-content log.

## Development checks

Use local dependencies and keep `package.json` and `package-lock.json` together.
Host-provided Pi packages are peer dependencies; pinned Pi 1.0.3 versions are
also development dependencies. Upstream npm advisories remain in that graph;
report them rather than silently upgrading the selected target.

`npm test` includes isolated Pi RPC processes using the package's bundled CLI,
disposable settings/runtime directories, and a deterministic in-process provider.
It does not use external provider credentials or call a remote model. Test-only
fixtures are not exposed by the package manifest.

An independent read-only evaluator can correlate structured session records.
Evaluation tooling, remote transport, orchestration, automated peer setup, and
built-in discovery remain outside the extension's initial scope.
