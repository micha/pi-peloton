import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendPeerMessage, onPeerDelivery, registerPeerRoute, type PeerSendInput, type PeerRouteInput } from "../../src/api.ts";

/** Test-only consumer; all sends go to disposable test peers. */
export default function (pi: ExtensionAPI) {
  let stop: (() => void) | undefined;
  const routes = new Map<number, AbortController>();
  pi.on("session_start", () => {
    // Tool allowlists must not gate user-command use of the programmatic API.
    pi.setActiveTools(pi.getActiveTools().filter(name => name !== "peer_send"));
    stop = onPeerDelivery(pi.events, status => pi.appendEntry("peloton.test-status", status));
  });
  pi.on("session_shutdown", () => {
    stop?.(); stop = undefined;
    for (const owner of routes.values()) owner.abort();
    routes.clear();
  });
  pi.registerCommand("peloton-test-route", {
    description: "Register an owned route in disposable test processes only",
    handler: async args => {
      const input = JSON.parse(args) as PeerRouteInput;
      const owner = new AbortController();
      const result = await registerPeerRoute(pi.events, input, { signal: owner.signal });
      if (result.ok) routes.set(input.target, owner);
      pi.appendEntry("peloton.test-route", result);
    },
  });
  pi.registerCommand("peloton-test-revoke", {
    description: "Revoke a test-owned route",
    handler: async args => { routes.get(Number(args))?.abort(); },
  });
  pi.registerCommand("peloton-test-send", {
    description: "Test the process-local Peloton API without a model call",
    handler: async args => {
      pi.appendEntry("peloton.test-tools", {
        registered: pi.getAllTools().map(tool => tool.name), active: pi.getActiveTools(),
      });
      const result = await sendPeerMessage(pi.events, JSON.parse(args) as PeerSendInput);
      pi.appendEntry("peloton.test-send", result);
    },
  });
}
