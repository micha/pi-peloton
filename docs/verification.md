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
The suite now has 14 passing tests. This refinement has not yet been visually
checked in the live test windows; use `/reload` there to load it, then Ctrl-O to
inspect acceptance details. Existing smoke-test captures show the preceding
styling.

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
