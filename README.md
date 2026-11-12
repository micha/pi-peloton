# pi-peloton

Peer-to-peer collaboration for [Pi](https://pi.dev) agents, without taking over
the human's prompt editor.

A peloton moves together and shares the effort. `pi-peloton` aims to let Pi agents
do the same: discover peers, exchange messages, and coordinate work while humans
continue using the normal terminal UI.

**Status: design-stage repository.** This repository currently contains project
intent and agent instructions, not a working extension. Interfaces below are
proposals; there are no installation instructions yet.

## The experience

Tell your agent:

> Work with the agent in window 2 to complete this task.

The agent discovers the Pi instance in that tmux window and messages it through
local IPC. Neither agent types into the other's prompt editor. Both humans can
see the collaboration in their own transcripts.

Example presentation (illustrative, not implemented):

```text
┌─ PEER · SENT → window 2 / reviewer ───────────────────
│ Please review the authentication changes.
│ Focus on security; don't edit files yet.
└─ Accepted by recipient · msg-017

┌─ PEER · RECEIVED ← window 2 / reviewer ───────────────
│ Found a missing expiry check in validateToken().
│ I'll send the relevant locations next.
└─ Queued as follow-up · msg-018
```

Distinctive labels and formatting should make peer messages easy to distinguish
from human prompts, assistant responses, and ordinary tool output.

## Proposed interface

- `peer_list`: discover available Pi peers and their tmux locations.
- `peer_send`: send a message to a peer, using a friendly target such as
  `window 2` or an explicit peer/pane ID.
- `/peloton`: show available peers to the human.
- `/peer`: send a message manually without requiring the model to call a tool.

Tool schemas, command syntax, and message rendering will be finalized during
implementation.

## Design direction

### Keep the human editor untouched

A Pi extension receives messages over local IPC and injects them using Pi's
extension APIs. Do not simulate keystrokes, paste into the editor, or submit a
human's unfinished prompt.

The initial transport is intended to be a private Unix-domain socket per Pi
instance, with a local registry for peer discovery. tmux is the first addressing
integration, not a permanent dependency of the messaging protocol.

### Resolve friendly names to stable identities

Map tmux session/window/pane locations to registered Pi instances. Interpret
`window 2` relative to the sender's tmux session. Resolve to stable tmux pane IDs
and explicit peer identities before sending; do not rely on window numbers
remaining unchanged. Report ambiguity when a window contains multiple peers,
rather than choosing one silently. A Pi process can also switch conversations,
so delivery must validate the intended live session rather than reuse a stale
registration.

### Deliver at appropriate boundaries

Routine messages use follow-up delivery: queue while the recipient is busy and
start a turn when idle. Steering is an explicit option for urgent corrections,
not the default. Consider a passive next-turn mode for messages that should not
independently start work.

Received messages should be custom Pi messages with a recognizable peer type and
sender metadata. Sent receipts should be rendered tool results or transcript-only
entries, not additional inbound messages that trigger another turn.

### Make coordination visible and bounded

Include sender, recipient, message ID, and optional reply-to ID in each message.
Distinguish recipient acceptance from model consumption, reply, and task completion.
A transport acknowledgement must not claim that work is finished.

Peer messages are attributed collaborator input, not human or system instructions.
They do not grant permissions. Collaboration should have an explicit task and
stopping condition, with safeguards against endless automatic replies.

## Initial scope

- Local, same-user peer discovery and messaging.
- tmux window/pane addressing with explicit ambiguity handling.
- Model-callable tools and human-facing commands.
- Distinctive sent/received transcript rendering.
- Follow-up delivery, explicit steering, and lifecycle cleanup.
- Tests for routing, delivery, editor preservation, and failure handling.

Initially out of scope: remote/network messaging, replacing Pi's TUI, launching
or supervising subagents, a shared task scheduler, and automatic coordination of
concurrent file edits. Agents sharing a checkout must still agree on ownership of
files and changes.

## Contributing

Read [AGENTS.md](AGENTS.md) for implementation constraints and verification
expectations. Start with a small vertical slice: two Pi instances exchange a
message, both transcripts show it distinctly, and neither human editor changes.

Pi's upstream [extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
and checked examples are the starting point. Verify APIs against the supported Pi
version before implementing; no minimum version has been chosen yet.
