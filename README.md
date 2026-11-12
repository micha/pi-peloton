# pi-peloton

Local peer messaging for [Pi](https://pi.dev) agents, without taking over the
human's prompt editor.

**Status: experimental prototype.** The extension, Unix-socket transport, and
automated tests now exist. The development target is **Pi 1.0.3 on Unix**, with
Node.js 22.19 or newer. A live smoke test covered Pi 1.0.3 TUI messaging and one
human-prepared draft; other Pi versions and broader lifecycle/editor behavior
have not been verified. This is not a published or production-hardened package.

## Collaboration hypothesis

Provide the channel; let the agents develop the collaboration. Peloton does not
prescribe roles, handshakes, task states, or a build → review → fix workflow.
Agents can ask questions, challenge assumptions, share discoveries, and divide
work as useful, within existing permission boundaries.

The hypothesis is that low-friction communication during work lets agents catch
mistakes and exchange context earlier, improving work quality compared with
isolated implementation followed by sequential review. This is a hypothesis to
test, not an established benefit or a claim about intrinsic model motivation.

## Prepare peers separately

The human prepares each peer's session, model, and thinking level before
collaboration. Peloton does not create/reset peer sessions, select their models,
or change thinking levels. It does not simulate keystrokes, paste into editors,
or submit unfinished human prompts. `pi.sendMessage()` treats `/new` as literal
peer content, not an executable TUI command.

## Development and installation

From this checkout:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Host-provided Pi packages are peer dependencies, with Pi 1.0.3 versions also
installed locally for development. npm reports upstream advisories in the pinned
Pi development dependency graph (`minimatch` and `undici`); this does not patch
or upgrade the user's Pi installation. Run `npm audit` for current details. Do
not treat this prototype as a security boundary or published release.

To try the extension for one invocation without changing Pi settings:

```sh
pi -e /absolute/path/to/pi-peloton
```

To install deliberately into personal Pi settings:

```sh
pi install /absolute/path/to/pi-peloton
```

Local packages load directly from that path, without copying. Their dependency
preparation is the checkout owner's responsibility. `--local` selects project
settings instead. Start a new Pi process or use `/reload` to load it in an existing
one. Installation was tested only in disposable settings, not the user's live
configuration.

## Model-facing interface

One tool, `peer_send`, targets the receiving **Pi process's PID**:

```text
peer_send(target=12345, content="Please review the changes.")
peer_send(target=12345, content="That assumption is incorrect.", delivery="steer")
peer_send(target=12345, content="Context for your next prompt.", delivery="nextTurn")
```

Tool arguments:

| Argument | Meaning |
|---|---|
| `target` | Receiving Pi PID, a positive integer |
| `content` | Nonblank message, at most 16 KiB in UTF-8 |
| `delivery` | `followUp` (default), `steer`, or `nextTurn` |
| `replyTo` | Optional message ID being answered |

Each instance displays its PID in the TUI status line. The human can supply it,
or agents can find it using tmux and process-inspection tools. tmux's `pane_pid`
often identifies a shell, not its Pi child; do not assume they are the same.
There is no built-in peer listing or friendly window-name resolver.

### Delivery

| Mode | Pi options | Intended behavior |
|---|---|---|
| Follow-up | `deliverAs: "followUp", triggerTurn: true` | Wake when idle; queue until ongoing work finishes when busy |
| Steering | `deliverAs: "steer", triggerTurn: true` | Wake when idle; deliver at Pi's supported turn/tool boundary when busy |
| Passive | `deliverAs: "nextTurn"` | Wait for the next user prompt; do not independently start work |

`triggerTurn` is an internal per-call choice, not a public Peloton option or a
global Pi setting. These semantics were checked against Pi 1.0.3 source and the
extension's mapping is tested. A live TUI smoke test also verified idle wake-up,
busy follow-up, steering after a tool boundary, and passive delivery on the next
human prompt; see [verification details](docs/verification.md).

## Visible, attributed messages

Received content is a custom `peloton.peer` message with an explicit collaborator
prefix in model context, including sender PID and message ID. Metadata retains
sender/recipient instance and conversation-generation identities, delivery mode,
optional reply-to ID, recipient Pi session ID, and acceptance time.

A transcript-only `peloton.status` entry displays accepted messages immediately,
including passive or queued content. Acceptance cards use the theme's subdued
`dim` tone throughout. Once Pi records the custom message, the acceptance card's
content is hidden in the normal view; **Ctrl-O** shows it in the expanded view.
The recorded message uses an accented `recorded` heading and full-contrast body
text. Explicit accepted/recorded labels distinguish stages without relying on
color. Both records remain in session history. Sent tool calls show content and
direction;
tool results retain the envelope, acceptance receipt, and sender session ID.
Terminal controls and bidi overrides are escaped in peer text and renderers.

Labels identify **SENT →** and **RECEIVED ←**, not just colors. Neither receipts
nor status entries become additional incoming prompts. A tool receipt means only
**accepted by the recipient**—not model consumption, response, or task completion.
The extension does not generate automatic replies.

## Transport and identity

Each running instance listens on a private Unix-domain socket:

```text
$XDG_RUNTIME_DIR/pi-peloton/<pi-pid>.sock
```

Without `XDG_RUNTIME_DIR`, the fallback is `~/.pi/peloton-runtime/<pi-pid>.sock`.
The leaf directory must be owned by the user with no group/other permissions;
sockets are mode `0600`. Paths longer than 100 bytes fail clearly. There is no
network listener or separate discovery registry file: the socket handshake
provides minimal endpoint metadata.

The client resolves the PID internally and obtains a random process-instance
nonce plus a conversation-generation nonce. A bare PID on first contact means
"the Pi currently at this PID." A client remembers up to 256 observed process
identities within its active session and rejects known PID replacements; starting
a new sender session/reloading allows deliberate first contact again. This is not
authentication against hostile same-user processes.

PID targets stay stable across conversation changes. The handshake binds each
send to the recipient generation observed on that connection. Session changes
and reloads restart listeners and invalidate locally tracked pending messages.
A context filter excludes invalidated/stale peer messages while preserving
recorded history. Pi owns its delivery queues: filtering a stale queued message
cannot guarantee cancellation of a turn Pi already scheduled. Invalidation is
recorded locally, not pushed back to the sender as a consumption acknowledgement.

### Bounds and failures

- Versioned JSONL envelopes; at most 24 KiB per frame and 16 KiB message content.
- At most 16 connections, each with a 5-second total deadline.
- At most 64 accepted messages not yet recorded by Pi.
- Last 256 accepted envelopes retained for duplicate detection during the listener
  lifetime. Identical duplicates return the original receipt; ID reuse with
  changed content fails. Evicted entries and listener restarts lose this history.
- No automatic retries. A timeout, abort, or lost acknowledgement can leave
  acceptance unknown; retrying with a new ID may duplicate work.
- Idempotent cleanup, safe stale socket-file checks, and visible protocol errors
  (rate-limited to avoid flooding the recipient).

Same-user peers are a trust boundary, not a strong sandbox. Sender identity is
claimed metadata; peers can impersonate each other if malicious. No received
text is evaluated as code or interpolated into shell commands. Message content
is kept in normal session records, not separate transport logs.

## Independent evaluation

Structured sent/received records permit an independent read-only sidecar to
correlate messages across sessions. It could assess errors caught, decisions
changed, duplicated work, and time/token overhead without participating in or
steering the collaboration. Evaluation tooling is outside this extension's scope.

Transcripts can provide evidence of how collaboration helped or hindered work,
but cannot alone establish an advantage over sequential review. Testing that
claim requires comparable tasks, repeated trials, and independent outcome checks.

## Verification and remaining work

`npm test` covers protocol validation, identity and PID replacement, stale
generations, concurrent senders, duplicate handling, admission bounds, permission
checks, failure handling, cleanup, extension attribution/mapping, and lifecycle
invalidation. It also installs the package in disposable settings and starts two
isolated Pi 1.0.3 RPC subprocesses to verify loading, passive acceptance without a
model call, a recipient conversation switch, and socket cleanup. Those processes
use no provider credentials and do not contact unrelated sessions.

A [live TUI smoke test](docs/verification.md) verified real model replies in both
directions, busy follow-up, steering at a tool boundary, passive delivery, and
preservation of a human-prepared ASCII draft and its cursor position in B. The
extension was loaded temporarily in dedicated windows, not installed globally.

**Not yet verified:** broader editor/focus behavior (including Unicode/multiline
drafts and drafts on both sides), actual extension reload with pending native Pi
queues, live TUI conversation changes/shutdown, or crash recovery under races.
See [AGENTS.md](AGENTS.md) for the full manual verification checklist.

Deferred: built-in discovery, tmux aliases, human send/list commands, automatic
retries, remote transport, peer launching/supervision, scheduling, and automated
session/model setup. Shared-checkout agents still need to coordinate file
ownership; messaging does not make simultaneous edits safe.
