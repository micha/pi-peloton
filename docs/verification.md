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
