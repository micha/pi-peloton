# pi-peloton

Let [Pi](https://pi.dev) agents talk to each other while you keep using the normal
terminal UI. Peloton provides local messaging between already-running Pi
instances without typing into anyone's prompt editor.

**Experimental prototype:** developed and tested with Pi **1.0.3 on Unix** and
Node.js **22.19 or newer**. Other Pi versions are not yet verified.

## Why Peloton?

Provide the channel; let the agents develop the collaboration. Agents can ask
questions, challenge assumptions, share discoveries, and divide work without
prescribed roles or a rigid build → review → fix sequence.

The hypothesis is that low-friction communication during work helps agents catch
mistakes and exchange useful context earlier, improving quality compared with
isolated implementation followed by sequential review. That benefit still needs
to be evaluated.

## Example interaction

An agent-to-agent exchange viewed from the two Pi instances:

| Agent A | Agent B |
| --- | --- |
| ![Agent A's conversation](docs/images/agent-a.png?x=1) | ![Agent B's conversation](docs/images/agent-b.png?x=1) |

## Install

From a local checkout:

```sh
cd /path/to/pi-peloton
npm ci --ignore-scripts
pi install "$PWD"
```

This installs Peloton into your **personal Pi configuration**. Start a new Pi
instance, or run `/reload` in each existing instance where you want to use it.
Pi loads the extension directly from the checkout, so keep that directory around.

For a single run without changing your settings:

```sh
pi -e /path/to/pi-peloton
```

For a project-only installation, run `pi install --local /path/to/pi-peloton` from
that project's directory; Pi requires project trust to load project-local
resources. After updating the checkout, reload **both ends** of a collaboration.
The current wire protocol is v2; instances still running v1 cannot exchange
messages with it.

The pinned development dependencies have upstream npm advisories, including
`minimatch` and `undici`. Run `npm audit` for current details. Installing this
checkout does not patch or upgrade your host Pi installation.

## Use it

1. Prepare two Pi instances on the same machine, under the same user. Choose their
   sessions, models, and thinking levels yourself.
2. Find the receiving instance's **Pi PID** in its status line.
3. Give that PID to your agent and ask it to collaborate in ordinary language.

For example, tell agent A:

> Implementation is GO. I've prepared Pi PID 12345 in a fresh session. Have it
> implement from DESIGN.md, EXAMPLE.md, and HANDOFF.md. Monitor, review, and provide
> feedback until the work is satisfactory.

The agent uses the `peer_send` tool; you do not need to type tool calls yourself.
Agents can also use existing tmux/process tools to find peers. Peloton does not
provide a peer list or resolve friendly names such as “window 3” itself. A tmux
pane PID may belong to a shell rather than the Pi process underneath it.

### Delivery modes

| Mode | When to use it | Behavior |
| --- | --- | --- |
| `followUp` — default | Messages that can wait until the peer finishes its turn | Wakes an idle peer; waits for ongoing work to finish if busy |
| `steer` — explicit | Replies, findings, or corrections that could change the peer's next action | Wakes an idle peer; otherwise arrives at Pi's supported turn/tool boundary |
| `nextTurn` — explicit | Leave context for later | Does not wake the peer; enters the conversation on its next human prompt |

Replies arrive automatically. An agent that has nothing to do but wait can end
its current turn and resume when a follow-up arrives. Sleep/polling loops keep it
busy and can delay those replies. Ending a turn is not declaring the task done;
independent work can continue while a peer is working.

For reference, tool calls look like:

```text
peer_send(target=12345, content="Please review the changes.")
peer_send(target=12345, content="That assumption is incorrect.", delivery="steer")
peer_send(target=12345, content="Context for your next prompt.", delivery="nextTurn")
```

When another send could depend on a queued reply, use
`peer_send(target=12345, content="I'll take the next step.", skipIfPendingFromTarget=true)`.
If this session already has an accepted `followUp` or `steer` from that PID still
pending delivery, the tool reports counts by mode and does not send. `nextTurn`
messages and messages from other peers don't block it. This is a local snapshot;
a reply can still arrive just after the check. The skipped send is not queued or
retried.

`replyTo` optionally identifies a message being answered. Message content must be
nonblank and no larger than 16 KiB in UTF-8.

## From another extension

Extensions can send directly, without asking a model to call `peer_send`:

```ts
import { sendPeerMessage } from "/path/to/pi-peloton/src/api.ts";

const result = await sendPeerMessage(pi.events, { target: 12345, content: "Approved note." });
```

Load Peloton in the sending process too. The API shares the tool's transport,
validation, attribution, and session records. It returns acceptance/errors;
optional content-free events report later recording. A PID addresses the **current
conversation**, not a pinned session or response. See the [consumer example and
API contract](docs/extension-api.md) for lifecycle cleanup and limitations.

Trusted launchers can opt into an advertised host Pi PID, private runtime, and
explicit per-PID routes, including revocable post-launch routes. See the
[bootstrap/routing contract](docs/namespace-routing.md). This does not provide a
sandbox launcher; actual namespace integration needs separate verification.

## What you'll see

The status line shows your Pi PID and tracked delivery backlog:

```text
1234 →0 ←4
```

- **→N**: outgoing messages still sending or accepted, awaiting recording.
- **←N**: accepted incoming messages still pending delivery into the conversation.

These are live delivery counts, not messages awaiting a reply. They reset on
session changes/reload. A lost recording update can leave an outgoing count
positive until its correlation is discarded.

Messages use a consistent card format:

```text
PEER {←|→} Pi PID {pid} · {delivery} · {status}
{message}
```

- **←** means received; **→** means sent.
- Incoming messages are subdued while `accepted`, then show as `recorded` in
  full contrast. The acceptance card hides once the recorded message is visible.
- Outgoing cards update in place: `sending → accepted → recorded`.
- **Ctrl-O** reveals acceptance receipts, message IDs, and reply-to metadata.
- Skipped sends show `not sent`. Failed sends and invalidated pending messages
  are also labelled explicitly.

These are delivery stages, not task-completion states. Recording updates happen
between extensions without prompting either model. They are best-effort: if a
notification is lost or a peer exits, the card keeps its last observed state.

## Scope and safety

- **Local, same-user communication only.** No network listener or remote peers.
- **Prepare peers yourself.** Peloton does not start/reset their sessions, change
  models or thinking levels, launch subagents, or schedule work. Sending `/new`
  as message text does not execute a slash command.
- **Human input stays separate.** Peloton does not simulate typing, replace a
  draft, or submit a human prompt. Peer messages remain attributed collaborator
  input, not human authorization.
- **Same-user peers are not a security sandbox.** Malicious processes running
  under your user can impersonate peers. Load only extensions you trust.
- **No automatic retries.** A timeout can leave acceptance unknown; resending may
  duplicate work.
- **Session changes have limits.** Stale peer content is excluded, but that cannot
  guarantee cancellation of a turn Pi already scheduled.
- **Shared files still need coordination.** Messaging does not make simultaneous
  edits in one checkout safe.

Messages and status metadata stay in normal Pi session records; there is no
separate transport content log. Those structured records could support an
independent read-only evaluator of collaboration quality. That evaluator is not
part of Peloton.

## Verification and contributing

Automated tests and a live TUI smoke test cover the core messaging path. The live
check included real replies, busy follow-up, steering, passive delivery, and one
human-prepared ASCII draft. The latest recording/card changes were also reported
working by the user. Broader editor/lifecycle behavior and the effectiveness of
no-busy-waiting guidance still need verification.

For development:

```sh
npm run check
npm test
```

- [Verification record](docs/verification.md): tested behavior and remaining gaps.
- [Extension API](docs/extension-api.md): programmatic sending and delivery events.
- [Private routing](docs/namespace-routing.md): trusted launcher configuration and route lifetime.
- [Implementation notes](docs/implementation.md): APIs, transport, limits, and
  lifecycle details.
- [AGENTS.md](AGENTS.md): instructions for coding agents working on this repository.
