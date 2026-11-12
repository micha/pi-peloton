# Agent instructions

## Purpose and current state

Read [README.md](README.md) first. `pi-peloton` is a proposed Pi extension for
visible peer-to-peer agent collaboration without interfering with human input.
This is currently a documentation-only repository. Do not describe proposed
features as implemented or invent install, build, or test commands.

Keep documentation synchronized with implementation. Clearly distinguish current
behavior, design direction, and open decisions.

## Product invariants

- Never use `tmux send-keys`, simulated paste, or editor submission for messaging.
- Never replace, clear, or submit a human's partially typed prompt.
- Show both sent and received messages in the TUI with distinctive labels and
  formatting. Include direction and peer identity; do not rely on color alone.
- Preserve sender identity in model context. Peer input is not a human request,
  system instruction, or authorization to perform otherwise prohibited actions.
- Default to follow-up delivery. Steering must be explicit.
- Distinguish transport acceptance, model consumption, response, and completion.
  Do not claim delivery stages the implementation cannot actually observe.
- Ambiguous or stale targets must fail clearly, never silently route elsewhere.
- Do not introduce unbounded automatic ping-pong between agents.

## Implementation direction

Use Pi extension APIs rather than modifying Pi core unless a demonstrated API
limitation makes that necessary. Read the upstream docs and checked examples for
the actual Pi version being targeted. Select and document the supported version
before publishing a package.

Expected components:

1. A local peer registry and private Unix-domain socket transport.
2. tmux-aware discovery and friendly target resolution.
3. `peer_list` and `peer_send` model-callable tools.
4. Human-facing `/peloton` and `/peer` commands.
5. Custom received-message rendering and visible sent receipts.

These names are proposed, not a frozen API contract. Keep transport and envelope
logic independent of tmux discovery and TUI rendering where practical.

### Pi integration

- Start sockets, watchers, and timers from `session_start`, not the extension
  factory. Clean up in an idempotent `session_shutdown` handler.
- Account for reloads, session switches, process exits, and stale registrations.
  Bind registrations to a process instance and the intended active session;
  reject outdated destinations rather than sending into a new conversation.
- Use custom messages via `pi.sendMessage()` for received peer content, with an
  explicit delivery mode and turn-trigger behavior.
- Use a tool renderer or `pi.appendEntry()` with an entry renderer for outgoing
  receipts. Do not feed sent receipts back as incoming prompts.
- Use `pi.registerMessageRenderer()` for the peer message type. Keep content and
  metadata usable even where terminal rendering is unavailable.
- Pi RPC mode is a separate operating mode, not an attach interface for an
  already-running standard TUI. `pi.events` is in-process, not cross-process IPC.

### Identity, protocol, and safety

- Resolve window aliases in the sender's tmux session. Use stable pane IDs and
  explicit peer IDs internally, and disambiguate multiple Pi peers in one pane
  or window. Do not assume a PID or window number uniquely identifies a session.
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
  explicit scope decision.
- Coordinate file ownership when collaborating in a shared checkout; messaging
  does not make simultaneous edits safe.
- Preserve unrelated changes. Do not install extensions into a user's live Pi
  configuration or inject messages into unrelated sessions without permission.
- Once code exists, document reproducible development and verification commands.
  Keep project dependencies local and commit manifests and lockfiles as appropriate.

## Verification expectations

Add automated tests for identity resolution, ambiguous and stale targets, protocol
validation, duplicate handling, bounded queues, transport failures, and cleanup.
Test concurrent senders and session changes explicitly.

Verify interactively with two Pi instances:

- Sending while the recipient is idle starts the intended turn.
- Follow-up delivery while busy waits for pending work to finish.
- Explicit steering arrives at the supported turn/tool boundary.
- Sent and received messages are distinctive and correctly attributed.
- An unfinished prompt stays byte-for-byte unchanged on both sides, with editor
  focus and cursor position preserved.
- Peer shutdown, extension reload, and conversation switches do not misroute
  messages or leak active sockets and registrations.
- Acceptance acknowledgements do not imply that the model has read or completed
  the request.

In completion reports, distinguish automated checks from manual TUI verification
and list anything not tested. For the documentation-only bootstrap, verify links,
repository state, and the published initial commit; no runtime tests exist yet.
