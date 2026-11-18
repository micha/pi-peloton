# Trusted advertised identity and private routes

Experimental integration contract, developed against Pi **1.0.3**. This adds
identity/routing configuration, not a launcher, namespace sandbox, peer discovery,
or session setup. Ordinary unconfigured Peloton use is unchanged. See the
[extension API](extension-api.md) for sending and association limits and the
[verification record](verification.md) for evidence and gaps.

## Launcher bootstrap

A trusted launcher can set `PI_PELOTON_CONFIG` to a JSON object **before Pi starts
its session**, preferably before importing the CLI in the verified application
process:

```json
{
  "version": 1,
  "advertisedPid": 12345,
  "runtimeDirectory": "/private/state/peloton",
  "routePolicy": "explicit",
  "routes": [{ "target": 67890, "directory": "/selected-parent" }]
}
```

All five fields are required when the variable is present; extra fields,
unsupported versions, relative/NUL-containing paths, invalid PIDs, duplicate or
self routes, and excessive bounds fail. JSON is limited to 64 KiB; the complete
socket path must fit the existing 100-byte limit. An empty variable is invalid,
not equivalent to absence. Configuration is not read from workspace files,
project settings, collaborator content, or model tool parameters.

- `advertisedPid` is the verified **host Pi application PID**, not the namespace
  init/reaper, launcher, shell, or inner PID. The launcher must establish that
  mapping; Peloton trusts it and does not authenticate or discover it. Peloton
  does **not** mutate `process.pid`.
- `runtimeDirectory` is the private writable owner-only local endpoint leaf.
  Peloton creates `<advertisedPid>.sock` there with mode `0600`.
- Each route names an existing owner-only directory containing `<target>.sock`.
  Routes are directory-based, not aliases or identity rewrites. Routed directories
  are checked, **never created** by the client; an already-existing read-only
  selected-peer export works. Existing socket type, ownership, permissions,
  path-length, handshake, instance, and generation checks still apply.
- `routePolicy: "explicit"` rejects every unrouted PID without consulting a default
  runtime. The namespace-local PID is not an alias. `"default"` permits ordinary
  PID lookup in `runtimeDirectory` only for targets without an explicit or retired
  route.

Configuration is first read during `session_start`, after extension factories,
not during factory registration. The first valid selection is captured
process-locally before endpoint binding. Its **exact environment string** must
remain unchanged across reload/session replacement. Adding configuration after
an unconfigured startup, or changing/removing an established configuration,
disables the endpoint with a visible error; it never silently selects a new
identity or default policy. A deliberately restarted process can select a new
configuration. The process-instance nonce survives reload; conversation generation
still rotates. Unconfigured XDG/fallback runtime lookup retains its previous
startup behavior.

Malformed/incomplete configuration leaves the endpoint/tool unavailable and no
API listener active. Registering a route does not probe readiness: filesystem and
handshake checks occur on an actual send. The launcher must separately verify
readiness and enforce a bounded bootstrap deadline.

## Post-launch parent route

An already-running ordinary parent needs a route to a new child's private
host-backed endpoint without rebinding its own socket. From a trusted extension,
after Peloton startup:

```ts
import { registerPeerRoute, sendPeerMessage } from "/path/to/pi-peloton/src/api.ts";

const lifetime = new AbortController();
const route = await registerPeerRoute(pi.events, {
  target: childHostPiPid, directory: childPrivateHostDirectory,
}, { signal: lifetime.signal });
if (!route.ok) throw new Error(route.error.message);

// Registration is not delivery or an application-association check.
const result = await sendPeerMessage(pi.events, {
  target: childHostPiPid, content: "Approved collaborator note.",
});
// On consumer/session shutdown, launch failure, or application invalidation:
lifetime.abort();
```

Register the consumer's `session_shutdown` handler to abort ownership, including
while registration is pending. Do not retain a disposed bus/context. The helper
requires an `AbortSignal`; aborting it after success is the revocation handle.
A signal already aborted before registration creates **no route**. A helper
timeout, cancellation, or disposed-bus failure revokes any registration whose
reply might have been lost; there are no retries. The reply listener/timer is
removed after the result, while successful route ownership remains alive.

```ts
registerPeerRoute(events, { target, directory }, { signal, timeoutMs? })
  // Promise<{ ok: true; target: number } |
  //   { ok: false; error: { code: PeerRouteErrorCode; message: string } }>
```

Error codes are `invalid_request`, `unavailable`, `conflict`, `limit`, `cancelled`,
and `timeout`. The default helper deadline is 6000 ms (positive, at most
2147483647). A missing/stopped listener times out. Success means the route was
installed, **not** that its endpoint exists, accepted a message, or recorded it.
Registration/revocation do not add model input or start turns.

Raw bus exports are `PELOTON_ROUTE` (`peloton:route:v1`),
`peerRouteResultEvent(requestId)` (`peloton:route-result:v1:<id>`),
`PeerRouteRequest` (`{requestId,input,signal}`), and `PeerRouteResponse`
(`{requestId,result}`). As with sending, use fresh request IDs and bounded waits.
Signals are process-local objects: this is not cross-process bootstrap or RPC.

## Routing and lifecycle guarantees

- One client and routing policy serve model-tool sends, extension API sends,
  **and reversed recorded notifications**. Known process-instance memory is not
  reset by registering a route. Identity/correlation checks and wire v2 are
  unchanged. Paths/nonces remain outside model-facing send arguments.
- A target can be registered only once per Peloton lifecycle, including configured
  static routes. Duplicate/conflicting registrations fail, even for the same
  directory. There are at most **256 explicit targets, including retired ones**.
- Revocation aborts active route transports and recording-observation waits.
  Queued recording notifications fail closed when reached. The target remains a
  **tombstone**: it cannot fall back to the ordinary runtime or be re-registered
  until a fresh lifecycle. An accepted message cannot be retracted; recording or
  acceptance already observed is not undone. No resend, reconnect, or retargeting
  is performed.
- Register before admitting traffic. Work already started using an ordinary
  default route is not moved to a newly registered override. Routing is outbound
  address selection, **not an incoming-sender allowlist** or authorization check.
- Shutdown/reload/session replacement cancels and discards dynamic registrations,
  without persistence or replay. Static bootstrap routes are recreated from the
  same configuration. A delayed old owner abort cannot affect a new lifecycle's
  registration. Old sends are settled/journaled before their context is abandoned.
- Ordinary sends still address the recipient's **current conversation**. A route
  is not a session/response/branch association or a promise of consumption.
  Consumers must enforce those associations independently; `replyTo` does not.

## Namespace/export policy

Give the child a private writable local runtime and only the selected parent's
socket in a narrowly scoped read-only export. Give the host an explicit route to
the child's private host-backed directory. Do not mount a global writable Peloton
runtime or unrelated host control sockets. A read-only socket file bind grants
**active messaging capability**, not read-only RPC. Same-user peers remain trusted
code, not a strong authentication boundary.

A per-file socket bind pins its inode. Parent endpoint shutdown/rebind (including
reload/session replacement) invalidates that export: recreate the sandbox after
explicit application validation. Do not automatically reconnect an outstanding
resolution, even if a PID or another route remains reachable. Export-directory
rebinding designs, launchers, host PID mapping, provider networking/credentials,
and interactive popup integration are outside this implementation.

Automated configured-PID/private-route integration is not proof of actual PID
namespaces, safe launcher bootstrap, Pi 1.5.2 compatibility, or live editor/focus
behavior. Keep any separate namespace fixture's evidence distinct.
