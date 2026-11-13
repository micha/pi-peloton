# Instructions for coding agents

## Start here

Read [README.md](README.md) for the user-facing product, then
[docs/implementation.md](docs/implementation.md) for architecture and API details.
Consult [docs/verification.md](docs/verification.md) before making claims about
verified behavior.

This is an experimental Pi extension targeting **Pi 1.0.3 on Unix**, using
**Peloton wire protocol v2**. Implementation and automated tests exist. A live
smoke test covered core delivery and one human-prepared draft; later recording
and rendering checks include user-reported results. Broader lifecycle/editor
verification and the effect of no-busy-waiting guidance remain incomplete.

Keep README concise and suitable for users. Put engineering detail in the
implementation notes, verification evidence in the verification record, and
instructions for future coding agents here. Distinguish implementation, design
intent, automated checks, independent live observations, and user reports.

## Product invariants

- Never use `tmux send-keys`, simulated paste, or editor submission for messaging
  or as a workaround for peer session creation/configuration.
- Never replace, clear, or submit a human's partially typed prompt.
- Preserve peer identity in model context. Collaborator input is not a human
  request, system instruction, or permission to perform prohibited actions.
- Default to current-session follow-up. Steering and passive delivery are
  explicit. Do not create/reset peer sessions or change their model/thinking
  level in this scope.
- Provide communication, not orchestration. Do not impose roles, handshakes,
  task states, or a mandatory collaboration stopping protocol. Do not generate
  automatic agent reply loops.
- Show sent and received messages with direction, PID, delivery mode, and stage;
  do not rely on color alone. Use the agreed card format:

  ```text
  PEER {←|→} Pi PID {pid} · {delivery} · {status}
  {message}
  ```

- Keep acceptance subdued. Hide incoming acceptance content once recorded,
  retaining it under Ctrl-O. Update outgoing cards in place. Keep repeated
  acceptance/recording implication notices out of cards; explain semantics in
  the docs/tool description instead.
- Never infer recording, consumption, response, or completion from acceptance.
  `recorded` means a matching Pi session entry was observed, not that the model
  read or acted on it.
- Unknown, ambiguous, stale, or incompatible targets fail clearly. Never silently
  choose another peer/conversation or change delivery modes.
- Preserve machine-identifiable messages and correlation metadata in normal
  session records. Do not add a separate message-content log or copy transcripts
  into discovery metadata.

## Working in this checkout

- Preserve unrelated changes. Coordinate file ownership before concurrent edits
  in a shared checkout; peer messaging does not make those edits safe.
- Continue independent work when available. If only waiting for a peer reply,
  finish the current turn so queued follow-ups can be delivered. Do not poll or
  sleep-loop merely to receive messages. Yielding is not declaring the task done.
- Obtain permission before installing into personal Pi settings, configuring or
  creating live peers, or injecting messages into existing sessions. Automated
  tests must use their own processes/settings/runtime directories.
- Do not add remote transport, supervision, scheduling, built-in discovery, or
  automated session/model setup without an explicit scope decision.
- Keep evaluation in a separate, read-only observer, not in messaging/control
  flow. Do not claim a collaboration-quality benefit from a functional smoke test.
- Use local dependencies. Commit manifests and lockfiles together. Report upstream
  advisories; do not silently upgrade the selected Pi target to address them.
- Use Pi extension APIs unless an observed limitation requires another approach.
  Read the installed version's docs, declarations, and checked examples before
  relying on an API. Verify a supported version range before publishing.

## Code and documentation map

- `src/extension.ts`: lifecycle, `peer_send`, messages, metadata, renderers.
- `src/protocol.ts`: types, validation, identities, limits, safe text.
- `src/transport.ts`: private Unix sockets, handshakes, frames, receipts, cleanup.
- `src/inbox.ts`: inbound admission tracking.
- `src/recording.ts`: bounded outgoing correlations and recording notifications.
- `src/presentation.ts`: shared card headers.
- `test/`: unit/integration tests and isolated RPC checks. Fixtures are test-only.
- `docs/implementation.md`: contributor reference; keep it synchronized with code.
- `docs/verification.md`: evidence, method, provenance, and untested cases.

## Pi integration constraints

- Start sockets, workers, watchers, and timers from `session_start`, not the
  extension factory. Make `session_shutdown` cleanup idempotent and cancel active
  sends/queues before abandoning their context.
- Preserve the process-instance nonce across reload; rotate conversation identity
  with the session lifecycle. Public PID targets remain instance-level. Surface
  invalidated pending messages rather than silently carrying them into a new
  conversation.
- Deliver received content with attributed custom `pi.sendMessage()` messages.
  Follow-up/steering use `triggerTurn: true`; `nextTurn` does not wake the peer.
  Custom content does not execute slash commands. Do not substitute
  `sendUserMessage()` to impersonate a human.
- Persist status/control data with `pi.appendEntry()`, not custom model messages.
  Status packets must not trigger a turn, run tools, or generate notifications
  in response to notifications.
- Pi 1.0.3 dispatches native extension `message_end` **before** session append.
  Confirm the matching session entry before sending `recorded`. Direct
  `triggerTurn:false` appends do not dispatch that extension hook; do not assume
  every append path has the same behavior.
- Keep outgoing stages monotonic if recording arrives before acceptance or after
  a lost acknowledgement. Restore recorded cards from branch metadata without
  re-injecting peer content.
- Pi omits custom entries when their renderer returns undefined. Hidden
  acceptance content must retain a component so Ctrl-O can reveal it after
  recording/resume. Use tool-renderer invalidation for outgoing row refresh.
- Each `promptGuidelines` bullet must name `peer_send`; Pi adds bullets flat to
  the model prompt. Explain automatic reply delivery and yielding without
  enforcing roles or a workflow.
- RPC is a separate operating mode, not an attach interface to a live TUI.
  `pi.events` is in-process, not cross-process IPC.

## Protocol and safety constraints

- Expose only the receiving Pi PID as the model-facing address. Keep socket paths
  and nonces internal. Validate observed process identities to reject known PID
  replacements; first contact means the current instance at that PID.
- Use `$XDG_RUNTIME_DIR/pi-peloton/<pid>.sock`, with the private
  `~/.pi/peloton-runtime/` fallback. Enforce owner-only leaf directories/sockets,
  short paths, and safe stale-file cleanup. Do not replace an active endpoint or
  unrelated file.
- tmux pane PIDs may be shells. Use process inspection for agent-driven discovery.
  If a built-in resolver is added, scope it to the sender's tmux session, use
  stable pane IDs, and reject ambiguity.
- Keep envelopes/versioning/transport separate from TUI rendering. Reject
  unsupported versions and modes rather than silently adapting them.
- Validate recording updates against the original message and both process and
  conversation identities. Bound live correlations, recording observation,
  notification queues, connections, frame sizes, and deadlines.
- Keep control packets content-free and separate from peer-message delivery.
  Retain the last observed stage on lost updates, expired correlations, or exits.
  Do not add retries without defining duplicate/retry semantics first.
- Same-user peers are not a strong sandbox. Do not claim authentication against
  hostile same-user processes. Never evaluate received text or interpolate it
  into shell commands; use argument arrays for tmux.
- Escape terminal controls and unsafe metadata in renderers. Keep failures visible
  without crashing the session or flooding its UI. Do not log credentials.

## Verification requirements

After implementation changes, run from the repository root:

```sh
npm run check
npm test
```

Also run `git diff --check` and verify changed documentation links/assets. The RPC
tests use Pi's bundled CLI, disposable settings/runtime directories, and a
synthetic provider; do not replace that with external credentials/model calls.

Maintain automated coverage for protocol/identity validation, unknown/stale
peers, PID reuse, concurrent senders, duplicates, bounds, modes, timeouts, aborts,
crash leftovers, and cleanup. Cover recording before acceptance, duplicate/lost
updates, identity/session mismatches, observation/queue cancellation, monotonic
stages, UI refresh, and history restoration without extra model input. Add
ambiguity tests if friendly resolution is introduced.

For live tests, use explicitly authorized peers and record which checks ran:

- Idle follow-up/steering wake the intended peer; busy follow-up waits and
  steering arrives at the supported boundary.
- Passive messages do not independently start a turn and reach the next human
  prompt; test both idle and busy cases.
- Sent/received cards are correctly attributed, stages update without duplicate
  normal-view content, and Ctrl-O reveals metadata.
- Human drafts remain byte-for-byte unchanged on both sides, with cursor/focus
  preserved; expand beyond the single ASCII draft already checked.
- Shutdown, reload, and conversation changes do not misroute messages or leave
  active sockets/registrations; test pending messages explicitly.
- Recording control updates refresh outgoing cards without starting sender turns.
- The model yields rather than busy-waiting when only awaiting a peer response;
  do not treat the presence of guidance as proof of model compliance.

Report automated checks, synthetic RPC checks, live observations, user reports,
and untested cases separately. Pi owns native queues: context filtering can
exclude stale content but cannot guarantee cancellation of an already-scheduled
turn. Never conceal that limitation or equate acceptance/recording with model
consumption or task completion.
