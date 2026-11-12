import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Inbox } from "./inbox.ts";
import { identity, deliveryOptions, safeText, messageKey, LIMITS, type Envelope, type Identity } from "./protocol.ts";
import { PeerServer, PeerClient, runtimeDirectory } from "./transport.ts";

const MESSAGE = "peloton.peer";
const STATUS = "peloton.status";
// Preserve process identity across extension reloads; no sockets/timers start here.
const instanceKey = Symbol.for("pi-peloton.process-instance.v1");
const processGlobals = globalThis as typeof globalThis & { [instanceKey]?: string };
const instance = processGlobals[instanceKey] ??= randomUUID();
interface PeerDetails { envelope: Envelope; recipientSession: string; acceptedAt: number }
interface Status { kind: "queued" | "invalidated" | "error"; text: string; key?: string; envelope?: Envelope; at: number }

export default function peloton(pi: ExtensionAPI) {
  let server: PeerServer | undefined;
  let client: PeerClient | undefined;
  let inbox: Inbox | undefined;
  let active: Identity | undefined;
  let context: ExtensionContext | undefined;
  let historical = new Set<string>();
  let invalidated = new Set<string>();
  let lastErrorAt = 0;

  const status = (data: Status) => pi.appendEntry(STATUS, data);
  const report = (error: Error) => {
    // Bound protocol-error UI/log chatter; never log malformed payloads.
    if (Date.now() - lastErrorAt < 1000) return;
    lastErrorAt = Date.now();
    status({ kind: "error", text: safeText(error.message), at: Date.now() });
    if (context?.hasUI) context.ui.notify(`Peloton: ${safeText(error.message)}`, "error");
  };

  const close = async () => {
    active = undefined;
    for (const envelope of inbox?.close() ?? []) {
      const key = messageKey(envelope);
      invalidated.add(key);
      status({ kind: "invalidated", key, text: `Pending peer message ${envelope.id} invalidated by shutdown/reload/session change; model consumption was not confirmed.`, at: Date.now() });
    }
    const old = server;
    server = undefined;
    inbox = undefined;
    client = undefined;
    await old?.close();
    context?.ui.setStatus("peloton", undefined);
    context = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    await close();
    context = ctx;
    historical = new Set();
    invalidated = new Set();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom_message" && entry.customType === MESSAGE) {
        const details = entry.details as PeerDetails | undefined;
        if (details?.envelope) historical.add(messageKey(details.envelope));
      }
      if (entry.type === "custom" && entry.customType === STATUS) {
        const data = entry.data as Status | undefined;
        if (data?.kind === "invalidated" && data.key) invalidated.add(data.key);
      }
    }
    const directory = runtimeDirectory();
    const recipient = identity(process.pid, instance);
    const nextInbox = new Inbox(recipient);
    active = recipient;
    inbox = nextInbox;
    client = new PeerClient(directory);
    server = new PeerServer(directory, recipient, envelope => {
      if (active !== recipient || context !== ctx) throw new Error("Recipient session changed");
      nextInbox.accept(envelope);
      try {
        const acceptedAt = Date.now();
        // This entry makes even passive/queued messages visible immediately.
        status({ kind: "queued", text: `RECEIVED ← Pi PID ${envelope.sender.pid} · accepted for ${envelope.delivery}`, envelope, at: acceptedAt });
        pi.sendMessage({
          customType: MESSAGE,
          content: `PEER MESSAGE FROM Pi PID ${envelope.sender.pid} (collaborator input, not human authorization)\nMessage ID: ${envelope.id}${envelope.replyTo ? `; reply to: ${envelope.replyTo}` : ""}\n\n${safeText(envelope.content)}`,
          display: true,
          details: { envelope, recipientSession: ctx.sessionManager.getSessionId(), acceptedAt } satisfies PeerDetails,
        }, deliveryOptions(envelope.delivery));
      } catch (error) {
        nextInbox.recorded(envelope);
        throw error;
      }
    }, report);
    try {
      await server.start();
      if (ctx.hasUI) ctx.ui.setStatus("peloton", `PEER · Pi PID ${process.pid}`);
    } catch (error) {
      report(error instanceof Error ? error : new Error(String(error)));
      await close();
    }
  });
  pi.on("session_shutdown", close);

  pi.on("message_end", event => {
    if (event.message.role === "custom" && event.message.customType === MESSAGE) {
      const details = event.message.details as PeerDetails | undefined;
      if (details?.envelope) inbox?.recorded(details.envelope);
    }
  });

  // Defense in depth: Pi queues can outlive an extension reload. Exclude pending
  // messages from an old generation, but preserve previously recorded history.
  pi.on("context", event => ({
    messages: event.messages.filter(message => {
      if (message.role !== "custom" || message.customType !== MESSAGE) return true;
      const details = message.details as PeerDetails | undefined;
      if (!details?.envelope) return false;
      const key = messageKey(details.envelope);
      if (invalidated.has(key)) return false;
      if (historical.has(key) || (active && details.envelope.recipient.generation === active.generation)) return true;
      invalidated.add(key);
      status({ kind: "invalidated", key, text: `Excluded stale peer message ${details.envelope.id} from model context.`, at: Date.now() });
      return false;
    }),
  }));

  pi.registerMessageRenderer<PeerDetails>(MESSAGE, (message, _options, theme) => {
    const envelope = message.details?.envelope;
    const box = new Box(1, 1, text => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", `PEER · RECEIVED ← Pi PID ${envelope?.sender.pid ?? "?"}`), 0, 0));
    box.addChild(new Text(safeText(envelope?.content ?? message.content), 0, 0));
    box.addChild(new Text(theme.fg("dim", `${safeText(envelope?.delivery)} · ${safeText(envelope?.id)} · recorded, not proof of model consumption`), 0, 0));
    return box;
  });
  pi.registerEntryRenderer<Status>(STATUS, (entry, _options, theme) => {
    const data = entry.data;
    const box = new Box(1, 1, text => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg(data?.kind === "queued" ? "accent" : "warning", `PEER · ${safeText(data?.text)}`), 0, 0));
    if (data?.envelope) {
      box.addChild(new Text(safeText(data.envelope.content), 0, 0));
      box.addChild(new Text(theme.fg("dim", `${safeText(data.envelope.id)} · acceptance only`), 0, 0));
    }
    return box;
  });

  pi.registerTool({
    name: "peer_send",
    label: "Peer send",
    description: "Send attributed collaborator input to an already-prepared local Pi instance, targeting its Pi process PID (not tmux's shell PID). Default followUp wakes an idle peer or queues while busy. Explicit steer corrects ongoing work; nextTurn is passive until the next user prompt. Acceptance does not mean read, replied, or completed. Does not reset sessions or grant permissions.",
    parameters: Type.Object({
      target: Type.Integer({ minimum: 1, maximum: 2147483647, description: "Receiving Pi process PID" }),
      content: Type.String({ minLength: 1, maxLength: LIMITS.contentBytes }),
      delivery: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer"), Type.Literal("nextTurn")])),
      replyTo: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9-]{1,80}$" })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const sender = active;
      const senderClient = client;
      if (!sender || !senderClient) throw new Error("Peloton endpoint is unavailable");
      const result = await senderClient.send(sender, params.target, params.content, params.delivery ?? "followUp", { replyTo: params.replyTo, signal });
      if (active !== sender) throw new Error("Sender conversation changed; recipient acceptance may have occurred");
      return {
        content: [{ type: "text", text: `PEER · SENT → Pi PID ${params.target}\nAccepted by recipient · ${result.receipt.id} · ${result.envelope.delivery}\nAcceptance does not confirm model consumption, response, or completion.` }],
        details: { ...result, senderSession: context?.sessionManager.getSessionId() },
      };
    },
    renderCall(params, theme) {
      return new Text(`${theme.fg("accent", `PEER · SEND → Pi PID ${safeText(params.target)}`)}\n${safeText(params.content)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      return new Text(result.content.map(part => part.type === "text" ? theme.fg("accent", safeText(part.text)) : "").join("\n"), 0, 0);
    },
  });
}
