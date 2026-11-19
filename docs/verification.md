# Verification record

## Live TUI smoke test — 2026-11-12

Environment: installed Pi 1.0.3, tmux 3.6a, Unix-domain sockets, two dedicated
windows in the user's existing tmux session. Both test agents used
`amazon-bedrock/us.openai.gpt-6.1-sol` with low thinking. Peloton was loaded with
an explicit `-e` path; other extensions, skills, prompt templates, and context
files were disabled for these test processes. No personal/project package
settings were changed.

The user authorized creating the test windows and participated in the editor
check. Windows were launched with tmux argument arrays; no `send-keys`, simulated
paste, or editor submission was used by the testing agent. A was given a bounded
startup prompt. Subsequent delivery probes came from a short-lived, correctly
attributed controller using the same transport client, not from unrelated Pi
instances or by impersonating A.

### Observed checks

| Check | Observation |
|---|---|
| Local loading | Both TUIs displayed the extension and their Pi PID; both sockets had mode `0600` |
| Model-callable tool | A invoked `peer_send` to B; B invoked it to reply to A with a reply-to ID |
| Idle wake-up | B began a model turn from an idle state; A subsequently processed B's acknowledgement |
| Busy follow-up | A follow-up accepted during B's 15-second shell tool was recorded after B's original final response; B then produced the follow-up marker |
| Explicit steering | A steering correction accepted during another 15-second shell tool was recorded after the tool result, before the next model response; B produced the corrected marker rather than its originally planned marker |
| Passive delivery | A passive message appeared as an acceptance entry without starting work; it remained pending through a separate peer-triggered follow-up turn |
| Passive consumption | After the human submitted their draft, the passive custom message entered the conversation and B reported its marker |
| Attribution | Both TUIs showed explicit sent/received direction and peer PID; model-visible custom content retained collaborator attribution |
| Receipts | Sent receipts said accepted and explicitly disclaimed model consumption/response/completion |
| Unsent draft | The user typed an ASCII draft and moved the cursor into its middle. The exact visible draft and tmux cursor coordinates remained unchanged after passive delivery and after a follow-up woke B |
| Human submission | The user confirmed editor/cursor preservation and submitted the draft themselves. The session record contained the exact requested draft text |

The editor check used:

```text
PELOTON-EDITOR-CHECK please report the pending passive marker.
```

The passive marker was `PELOTON-PASSIVE-731`. Screen captures and normal test
session records were stored temporarily under `/tmp/peloton-tui.Gb69sT/`; they
are disposable evidence, not a committed transcript archive. The windows were
left open as `peloton-A` and `peloton-B`, with no automatic reply loop or further
test work requested.

### Limits of this verification

- Editor observations cover this single-line ASCII draft in B, including a
  peer-triggered model turn. They do not directly instrument internal editor
  bytes or focus state, and do not cover Unicode/multiline drafts, a draft in A,
  or every delivery mode while a draft is present.
- Busy follow-up and steering were controller-to-B probes. Agent-to-agent tool
  use was exercised for default follow-up in both directions.
- Pending native Pi queues across extension reload, shutdown of these live TUIs,
  and live conversation switches were not exercised in this run. Automated tests
  cover socket cleanup and an isolated RPC conversation switch, not every TUI
  lifecycle case.
- Stale-content filtering cannot guarantee cancellation of a turn Pi already
  scheduled. This remains an implementation limitation.
- This is a functional smoke test, not evidence that collaboration improves task
  outcomes or that the transport is safe against hostile same-user processes.
- At the time of the smoke test, received content appeared twice: immediate
  acceptance/status rendering and later custom-message rendering. The subsequent
  rendering refinement below addresses this in the normal view.

## Rendering refinement after the smoke test

Acceptance/status cards now use the theme's `dim` tone for both heading and body.
Recorded custom messages use an accented heading with an explicit `recorded`
label and full-contrast body text. Once recording is observed, the acceptance
card's content disappears from the normal view but remains available with Ctrl-O.
Pending acceptance cards and warning/error cards stay visible. Both records
remain in session history; visibility changes do not imply model consumption.

Automated renderer tests check semantic color choices, explicit stage labels with
color disabled, terminal-control escaping, hiding an existing card on repaint,
expanded receipt visibility, and reconstruction from recorded branch history.
The suite now has 14 passing tests. The follow-up check below confirmed the
single-message collapsed view in live windows. Expanded receipt visibility is
automatically tested but has not been separately captured live.

## Global installation, fresh sessions, and reload — 2026-11-12

After personal installation, the human started fresh sessions in the existing
A/B test instances and ran `/reload` in the coordinating Pi. The coordinator then
used its newly available `peer_send` tool directly, rather than the standalone
controller:

- Default follow-up to B woke it and produced a one-time `PELOTON-GLOBAL-B-ACK`
  reply via `peer_send`, correlated with the original message ID.
- Explicit steering to idle A woke it and produced a one-time
  `PELOTON-GLOBAL-A-ACK` reply via `peer_send`, also correlated with the request.
- Both replies targeted the coordinating Pi instance, whose extension accepted
  them as follow-ups. Acceptance alone is not proof that the coordinating model
  consumed the replies while its existing turn was still active.
- Captures of both receiving TUIs showed one recorded incoming message, without
  a second acceptance card in the normal collapsed view.
- Instance PIDs stayed usable across the human-prepared conversation changes.
  All messages were attributed, and neither agent was asked to modify files or
  continue a reply loop.

This confirms basic messaging after actual global installation and a coordinator
reload, plus current-session routing after human session changes. It does not
exercise pending-message invalidation across those changes or reloads, nor live
shutdown cleanup. The A/B processes still had their explicit `-e` launch paths;
this was not a test of automatic loading in an otherwise unconfigured new TUI.

## Standard card format

Message cards now use:

```text
PEER {←|→} Pi PID {pid} · {delivery} · {status}
{message}
```

Message IDs and reply-to metadata are shown in expanded view. Repeated notices
about acceptance/recording implications are removed from both normal and expanded
cards; those semantics remain in the documentation and tool description. Outgoing
cards update from `sending` to `accepted` in place rather than showing separate
call/result cards. Errors remain visible.

The suite now has 15 tests, including exact incoming/outgoing header/body layout,
status transitions, escaping, and collapsed/expanded metadata. This latest
formatting change has not yet been checked in the live TUIs.

## Extension-only recording updates — wire protocol v2

Outgoing cards now progress from `sending` to `accepted` to `recorded` when a
validated recording control update arrives. The recipient uses the custom
message's native `message_end` event as a signal, then waits for the matching Pi
session entry before transmitting the update. The sender persists non-model
`peloton.delivery` metadata and invalidates the existing tool row. No status
packet becomes a collaborator prompt or an agent reply.

Automated checks cover:

- Both original identities and message IDs, including stale conversations/PID
  replacements and unknown or expired correlations.
- A deliberately early recording update before the acceptance response; later
  acceptance and lost-acknowledgement errors do not regress the observed stage.
- Duplicate control packets and conflicting updates, with no extra model input.
- Bounded correlation/notification state, serial sends, no retries, and shutdown
  cancellation.
- Recording observation after the event but before transmission, with timeout
  and cancellation rather than speculative status.
- Immediate row refresh and restoration from recorded branch history on reload.
- An actual Pi 1.0.3 recording event in an isolated RPC subprocess, using a
  deterministic in-process provider without external calls. Recording generates
  one control notification; it does not generate another model turn.

The suite has 24 passing tests. The user subsequently reported the latest
protocol/formatting working in a live check (see below); detailed traces for that
check were not independently captured. Both ends must `/reload` after upgrading
from protocol v1; mixed versions fail visibly.

Pi 1.0.3 dispatches native extension `message_end` before appending the session
entry, so the update worker confirms the entry separately. Its direct
`triggerTurn:false` custom-message append emits session events
but does not dispatch the extension `message_end` hook. Peloton's ordinary
follow-up/steering and next-user-turn delivery use native agent-message events;
the isolated test uses that path rather than treating a direct append as proof
of notification support.

## User-reported live check and busy-waiting guidance

The user reported that the recording-update/card changes worked in a live test.
They also observed an agent looping on `sleep` while waiting for a peer response
rather than ending its turn. No detailed transcript of that run was independently
captured, so this is a user report rather than an expanded verification matrix.

The `peer_send` description and active-tool `promptGuidelines` now explain that
default follow-up replies arrive automatically, keeping a turn busy delays their
delivery, and an agent with nothing but waiting left should finish its current
turn. Independent work can continue; ending a turn is not declaring the task
complete. The extension does not enforce a stopping protocol or choose roles.

Automated checks verify that this guidance is present and names `peer_send`.
Whether it prevents model busy-waiting in practice still needs a follow-up test
after reloading the extension.

## Delivery-backlog footer

The status line now uses `{pid} →{pending_send} ←{pending_receive}`. Counts track
live delivery state: sending/accepted outgoing correlations and admitted incoming
messages not yet delivered. They do not count outstanding replies or tasks.

The suite now has 26 passing tests. Assertions cover startup zeros, incoming
admission/native delivery, mixed send/receive backlog, recording before
acceptance, missing/rejected peers, correlation eviction, shutdown/session reset,
and contexts without a UI. Status updates do not add model messages. The user
subsequently reported the new footer working in a live test; no detailed trace
of that check was independently captured.

## Generic extension integration API — automated checks

`npm run check`, `npm test` (**33 passing tests**), and `git diff --check` pass
with the pinned Pi 1.0.3 development dependencies. Changed local documentation
links/assets were checked separately. No personal Pi settings were changed and
no messages were injected into existing live peers for these checks.

Focused automated coverage in `test/api.test.ts` checks:

- Concurrent request correlation, per-request listener cleanup, missing/disposed
  buses, deadlines, pre-send and in-flight cancellation, and no retries.
- All delivery modes, reply-to IDs, sender identity, shared tool/API validation,
  UTF-8 bounds, unavailable peers, and known-PID replacement rejection.
- API-only outgoing records/cards, escaped text, content-free status events,
  duplicate request rejection, recording deduplication, and history restoration.
- Recording before acceptance, lost acknowledgement after recording, and late
  recording after an error, without regressive stages or added model messages.
- Shared active-send bounds, correlation eviction/untracking, cancellation and
  journaling before session teardown, listener removal/rebinding, and synthetic
  session-record write failures that return errors rather than hanging callers.

The isolated RPC test additionally loads `test/fixtures/api-consumer.ts` into an
actual Pi 1.0.3 sender. The consumer deactivates `peer_send` using
`pi.setActiveTools()`; assertions confirm it remains registered but absent from
the active tool list, both initially and after session replacement. A command
still sends a passive message through the public helper, without a sender model
call. A recipient with the existing deterministic
provider records it through native Pi events; the sender observes durable
recording metadata and live status events without receiving custom model input
or starting a turn. A sender session replacement reloads the consumer/Peloton
listeners and successfully sends again. These processes use disposable
settings/runtime directories and no external credentials or model calls.

This is automated/synthetic evidence, **not a new live TUI observation**. API
outgoing-card behavior is renderer-tested, but its live repaint/editor/focus
behavior has not been independently exercised. No broader Pi version range,
sidebar workflow, application session/response-association policy, or
collaboration-quality benefit is verified here. Existing live-verification gaps
above remain. `npm ci --ignore-scripts` reports the existing pinned dependency
advisories: 2 moderate and 1 high (including `minimatch` and `undici`); the target
versions were not upgraded.

## Trusted bootstrap and private routes — automated checks

`npm run check`, `npm test` (**40 passing tests**), and `git diff --check` pass
with the pinned Pi 1.0.3 development dependencies. Changed local documentation
links/assets were checked. No personal settings, existing peers, external
credentials/providers, or live TUI sessions were used. Dependencies were not
changed; the previously reported upstream advisories remain.

`test/routing.test.ts` and `test/namespace-extension.test.ts` cover:

- Complete/strict/versioned bootstrap validation, UTF-8/path/route bounds, duplicate
  and self routes, advertised PID in socket/handshake/envelopes/footer/controls,
  and explicit-only rejection without a default connection or inner-PID alias.
- Invalid initial configuration disabling startup and changed/removed/malformed
  established configuration failing visibly across lifecycle changes, never
  resetting advertised identity or routing policy. Endpoint startup failures are
  not hidden by the protocol-error UI rate limiter.
- Post-start route registration, duplicate/full limits including tombstones,
  caller-owned cancellation, pre-aborted calls creating nothing, lost-reply
  revocation, helper deadlines, disposed buses, and reply-listener cleanup.
- Active message and recording-control cancellation before acknowledgement,
  cancellation during native-recording observation, queued control failure without
  fallback, and revoked-target failure even under the ordinary default policy.
- The shared client's process-replacement checks, no routed-directory creation,
  socket/directory type/ownership/permission checks, and symlink rejection.
- Shutdown clearing dynamic routes, no registration replay, stale ownership not
  affecting a new lifecycle, stable process instance with rotated generation,
  and old-generation recording rejection.

The isolated Pi RPC test now also uses an explicit **synthetic advertised PID**
and private runtime for one actual Pi 1.0.3 subprocess, plus a post-start dynamic
route in the ordinary parent. Both load the production extension and public API
consumer with `peer_send` inactive. API sends and native `peloton.peer` recording
work **in both directions**, with matching recording metadata and reply-to. The
parent's recording control back to the private child uses its dynamic route;
the child's recording control back to the parent uses its bootstrap route.
Revocation is not a fallback; a sender session replacement loses the dynamic
registration until explicitly registered again. The configured child's session
replacement preserves its advertised PID/instance, rotates generation, and
recreates its static routes. Disposable endpoints/settings are cleaned up.

This is automated/synthetic evidence. The RPC sessions are inspected via their
native entry API, not a separate disk-session observer. It does **not** verify
actual PID/user/mount namespaces, bubblewrap bootstrap/host-PID identification,
read-only bind mounts or pinned-inode lifecycle behavior, Pi 1.5.2 compatibility,
a production sidebar launcher, or live editor/focus/repaint behavior. Separate
sidebar-repository probes must retain their own source snapshot/version and
provenance; they are not implied by these 40 tests. Existing live/association and
collaboration-quality gaps remain. See the [routing contract](namespace-routing.md).

## Cross-repository namespace gate — collaborator report and source review

The sidebar collaborator (Pi PID 526557) reports a passing explicit
`npm run probe:pi-peloton` in the adjacent `pi-tmux-sidebar` checkout, using
installed Pi 1.5.2, real bubblewrap namespaces, two disposable Pi processes, and
deterministic offline providers. The evidence/method/limits and nine source
SHA-256 hashes are recorded there in `docs/pi-peloton-probe.md` (not packaged
with Peloton). All nine hashes were independently compared here with the current
Peloton sources and match. The probe, consumer, bootstrap, provider, RPC observer,
and PID/routing helpers were reviewed read-only; **this agent did not rerun that
namespace fixture**.

The reported runtime checks include public API sends and native session-file
`peloton.peer`/`peloton.delivery` records in both directions, reply-to/host-PID
attribution, inactive `peer_send`, dynamic parent routing without endpoint rebind,
explicit-only child routing, monotonic statuses, and no extra sender provider call
from API/status handling. Following source review, the collaborator strengthened
and reportedly reran the fixture: each native session must contain only its
expected `peloton.peer` custom model message, and all recording/delivery-status
entries must explicitly have non-model `type: "custom"`. Those assertions were
read back here, separately from the provider-call checks. Actual child session
replacement preserves its advertised PID/instance and rotates generation. Parent route revocation tombstones the target;
actual parent session replacement loses the dynamic route and leaves the child's
per-file parent export pinned to the old inode, causing sends to fail without
reconnection. A deliberate post-start failure reportedly exits nonzero with owned
process/state cleanup and preservation of an unrelated sentinel checked by a
separate wrapper.

These are **collaborator-reported runtime observations plus local source/hash
review**, not new independently executed checks in this repository. The
fixture's pending/cancellation/reload interleavings must not be inferred from our
separate Pi 1.0.3 tests or the older synthetic transport fixture. This one offline
profile does not establish a supported Pi version range, a production launcher,
automatic sidebar recreation, live popup/editor/focus behavior, remote-model
consumption, application-association validation, or collaboration-quality benefit.

## Opt-in send guard — automated check

An extension harness test with disposable sockets verifies that
`skipIfPendingFromTarget` skips a send without delivering an outgoing envelope
or emitting outgoing delivery events, reports pending `followUp` and `steer`
counts, and shows `not sent` in the card. Other peers and passive messages do not
block; leaving out the guard preserves the ordinary send path. Native delivery
simulated by the harness and a session replacement both clear blockers. The
suite has 41 passing tests. Model use of the guard has not been verified in live
collaboration.

## Automated checks

At the prototype commit, `npm run check` and all 13 tests passed. The tests cover
protocol/identity validation, PID replacement, concurrent senders, duplicate
handling, message/frame/admission/connection bounds, deadlines and aborts,
permission checks, stale socket-file replacement after a crash, extension
mapping/attribution/invalidation, and cleanup. Two isolated Pi 1.0.3 RPC processes
also verified local-path installation into disposable settings, passive
acceptance without a model call, a recipient conversation switch, and shutdown.

See [README.md](../README.md) for commands and current limitations. Upstream npm
advisories in the pinned development dependency graph remain unresolved; this
verification did not upgrade or patch the host Pi installation.
