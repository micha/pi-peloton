// Test-only driver with a deterministic in-process provider. No credentials,
// network model calls, or tokens are used. Not exposed by the package manifest.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Envelope } from "../../src/protocol.ts";

export default function (pi: ExtensionAPI) {
  let calls = 0;
  pi.registerProvider("peloton-test", {
    api: "peloton-test",
    baseUrl: "http://127.0.0.1:1", // Required metadata; custom stream never connects.
    apiKey: "test-only-placeholder",
    models: [{ id: "model", name: "Deterministic test model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: [], stopReason: "pending",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(() => {
        pi.appendEntry("peloton.test-model", { calls: ++calls });
        stream.push({ type: "start", partial: message });
        message.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        message.content[0] = { type: "text", text: "test turn complete" };
        stream.push({ type: "text_delta", contentIndex: 0, delta: "test turn complete", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "test turn complete", partial: message });
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  pi.registerCommand("peloton-test-record", {
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const queued = [...entries].reverse().find(entry => entry.type === "custom"
        && entry.customType === "peloton.status" && (entry.data as { kind?: string })?.kind === "queued");
      if (!queued || queued.type !== "custom") throw new Error("No accepted test message");
      const envelope = (queued.data as { envelope: Envelope }).envelope;
      pi.sendMessage({
        customType: "peloton.peer", content: envelope.content, display: true,
        details: { envelope, recipientSession: ctx.sessionManager.getSessionId(), acceptedAt: Date.now() },
      }, { triggerTurn: true, deliverAs: "followUp" });
    },
  });
}
