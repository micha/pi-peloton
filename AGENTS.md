# Agent instructions

## Purpose and current state

Read [README.md](README.md) first. `pi-peloton` is an experimental Pi extension for
visible peer-to-peer agent collaboration without interfering with human input.
The prototype targets Pi 1.0.3 on Unix. Transport, extension integration, and
automated tests exist. A live smoke test verified real model messaging, delivery
modes, and one human-prepared draft; broader TUI/lifecycle verification remains
outstanding. See [docs/verification.md](docs/verification.md). Do not describe
unverified behavior as proven.

Keep documentation synchronized with implementation. Clearly distinguish current
behavior, design direction, and open decisions.

## Product invariants

- Never use `tmux send-keys`, simulated paste, or editor submission for messaging
  or as a workaround for peer session creation/configuration.
- Never replace, clear, or submit a human's partially typed prompt.
- Show both sent and received messages in the TUI with distinctive labels and
  formatting. Include direction and peer identity; do not rely on color alone.
- Preserve sender identity in model context. Peer input is not a human request,
  system instruction, or authorization to perform otherwise prohibited actions.
- Default to current-session follow-up delivery. Steering must be explicit.
  Peer setup is separate: do not create/reset peer sessions or change their model
  or thinking level in the initial extension.
- Distinguish transport acceptance, model consumption, response, and completion.
  Do not claim delivery stages the implementation cannot actually observe.
- Ambiguous or stale targets must fail clearly, never silently route elsewhere.
- Do not generate automatic reply loops in the extension. Agents choose their
  collaboration workflow; do not impose roles, handshakes, task states, or a
  mandatory stopping protocol.
- Keep peer messages machine-identifiable in session records as well as visible
  in the TUI. Preserve correlation and session identity metadata for independent
  evaluation without introducing a separate message-content log.

## Implementation direction

Use Pi extension APIs rather than modifying Pi core unless a demonstrated API
limitation makes that necessary. Read the upstream docs and checked examples for
the actual Pi version being targeted. The initial development target is Pi 1.0.3;
select and verify a supported version range before publishing a package.

Prototype components:

1. Minimal instance-level endpoint metadata and private Unix-domain sockets.
2. A visible way for each human to obtain their instance's Pi PID.
3. One `peer_send` model-callable tool targeting a Pi PID's current conversation;
   socket paths and nonces remain internal.
4. Follow-up, explicit steering, and passive next-turn delivery.
5. Custom received-message rendering and visible sent acceptance receipts.

These names are proposed, not a frozen API contract. Built-in automatic discovery,
tmux addressing, friendly aliases, `peer_list`, `/peloton`, `/peer`, and automatic
retries are deferred. Agents may use existing tmux/process tools to discover
receiving Pi PIDs. Keep transport and envelope logic independent of TUI rendering
and any future discovery integration.

### Pi integration

- Start sockets, watchers, and timers from `session_start`, not the extension
  factory. Clean up in an idempotent `session_shutdown` handler.
- Account for reloads, session switches, process exits, and stale registrations.
  Public peer addresses identify running instances across conversation changes.
  Track conversation changes internally and surface invalidated pending messages;
  do not silently carry them into a replacement conversation. Reconcile instance
  addressing with Pi's session-scoped extension lifecycle.
- Use custom messages via `pi.sendMessage()` for received peer content. For
  current-session follow-up/steering, set `triggerTurn: true`; passive `nextTurn`
  does not wake the recipient. Verify behavior against the supported Pi version.
- Custom message content does not execute slash commands. Keep peer input
  attributed; do not simulate TUI input or relabel peers as humans. Automated peer
  setup would need a separate scope decision and a verified supported control path.
- Use a tool renderer or `pi.appendEntry()` with an entry renderer for outgoing
  receipts. Do not feed sent receipts back as incoming prompts.
- Use `pi.registerMessageRenderer()` for the peer message type. Keep content and
  metadata usable even where terminal rendering is unavailable.
- Pi RPC mode is a separate operating mode, not an attach interface for an
  already-running standard TUI. `pi.events` is in-process, not cross-process IPC.

### Identity, protocol, and safety

- Expose the receiving Pi PID as `peer_send`'s model-facing target. Locate the
  socket and obtain its process-instance nonce internally. First contact with a
  bare PID means the current Pi instance at that PID, not a historical process.
  Define internal identity retention/validation for continuing collaboration so
  PID reuse does not silently substitute a replacement peer. Current-session
  sends target the conversation active at acceptance; public targets need not
  include Pi session IDs.
- Use the private runtime directory `$XDG_RUNTIME_DIR/pi-peloton/`, with a
  `~/.pi/peloton-runtime/` fallback and `<pid>.sock` filenames. Keep Unix socket
  paths short and handle leftover socket files safely after crashes.
- tmux pane PIDs may identify shells rather than Pi processes. Agent-driven
  discovery can inspect process trees or match optional server/pane registration
  metadata. A later built-in resolver must use the sender's tmux session and
  stable pane IDs and reject ambiguity.
- Use structured, versioned envelopes with message IDs, sender/recipient identity,
  content, delivery mode, and optional reply-to ID.
- Validate inputs and bound message sizes, queues, connection counts, and timeouts.
  Define retry and duplicate-handling semantics before adding automatic retries.
- Restrict registry directories and sockets to the owning user. Do not expose a
  network listener by default. Same-user peers are a trust boundary, not a strong
  sandbox: state limitations explicitly.
- Never evaluate received text as code or interpolate it into shell commands.
  Use argument arrays when invoking tmux and treat terminal control characters
  and untrusted metadata safely in renderers.
- Do not store credentials or copy full transcripts into a discovery registry.
  Minimize persisted metadata and avoid unnecessary message-content logging.
- Report unavailable peers, malformed envelopes, stale registrations, and
  transport failures visibly without crashing the recipient session.

## Working practices

- Prefer a small, end-to-end prototype over an elaborate orchestration framework.
- Do not add remote transport, agent supervision, or a task scheduler without an
  explicit scope decision. Evaluation belongs in an independent, read-only
  observer, not in the initial extension or its collaboration control flow.
- Coordinate file ownership when collaborating in a shared checkout; messaging
  does not make simultaneous edits safe.
- Preserve unrelated changes. Do not install extensions into a user's live Pi
  configuration or inject messages into unrelated sessions without permission.
- Document reproducible development and verification commands. Run
  `npm run check` and `npm test` after implementation changes. Keep dependencies
  local, commit the manifest and lockfile together, and report upstream advisories
  without silently upgrading the selected Pi target.

## Verification expectations

Add automated tests for explicit identity resolution, unknown and stale targets,
protocol validation, duplicate handling, bounded queues, delivery modes, transport
failures, and cleanup. Test concurrent senders, PID reuse, and session changes
explicitly. Reject unsupported delivery modes.
Ambiguity tests become required if friendly target resolution is added.

Verify interactively with two Pi instances:

- Follow-up delivery while the recipient is idle starts the intended turn.
- Follow-up delivery while busy waits for pending work to finish.
- Explicit steering arrives at the supported turn/tool boundary; verify both
  busy and idle behavior against the selected Pi version.
- Passive next-turn delivery does not independently start a turn and is available
  to the subsequent turn; verify both busy and idle behavior.
- Unsupported delivery behavior fails visibly rather than changing modes.
- Sent and received messages are distinctive and correctly attributed.
- An unfinished prompt stays byte-for-byte unchanged on both sides, with editor
  focus and cursor position preserved.
- Peer shutdown, extension reload, and conversation switches do not misroute
  messages or leak active sockets and registrations.
- Acceptance acknowledgements do not imply that the model has read or completed
  the request.

In completion reports, distinguish automated checks (including isolated RPC
subprocess checks) from manual TUI verification and list anything not tested.
Acceptance and transcript recording are not proof of model consumption. Pi owns
native queues: context filtering can exclude stale content but cannot guarantee
cancellation of an already-scheduled turn. Do not conceal that limitation.
