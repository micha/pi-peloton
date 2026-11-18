import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendPeerMessage, onPeerDelivery, type PeerSendInput } from "../../src/api.ts";

/** Test-only consumer; all sends go to disposable test peers. */
export default function (pi: ExtensionAPI) {
  let stop: (() => void) | undefined;
  pi.on("session_start", () => {
    // Tool allowlists must not gate user-command use of the programmatic API.
    pi.setActiveTools(pi.getActiveTools().filter(name => name !== "peer_send"));
    stop = onPeerDelivery(pi.events, status => pi.appendEntry("peloton.test-status", status));
  });
  pi.on("session_shutdown", () => { stop?.(); stop = undefined; });
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
