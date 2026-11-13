import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Inbox } from "./inbox.ts";
import { identity, deliveryOptions, safeText, messageKey, recordingUpdate, sameIdentity, LIMITS, type Envelope, type Identity, type Receipt, type RecordedUpdate } from "./protocol.ts";
import { PeerServer, PeerClient, runtimeDirectory } from "./transport.ts";
import { peerHeader, type CardStatus } from "./presentation.ts";
import { Outgoing, RecordingNotifications, waitForRecording } from "./recording.ts";

const MESSAGE = "peloton.peer";
const STATUS = "peloton.status";
const DELIVERY = "peloton.delivery";
// Preserve process identity across extension reloads; no sockets/timers start here.
const instanceKey = Symbol.for("pi-peloton.process-instance.v1");
const processGlobals = globalThis as typeof globalThis & { [instanceKey]?: string };
const instance = processGlobals[instanceKey] ??= randomUUID();
interface PeerDetails { envelope: Envelope; recipientSession: string; acceptedAt: number }
interface Status { kind: "queued" | "invalidated" | "error"; text: string; key?: string; envelope?: Envelope; at: number }
interface SendDetails { messageId: string; envelope?: Envelope; receipt?: Receipt; senderSession?: string; error?: string }
interface DeliveryEvent { kind: "recorded" | "notificationFailed"; update: RecordedUpdate; error?: string; at: number }

export default function peloton(pi: ExtensionAPI) {
  let server: PeerServer | undefined;
  let client: PeerClient | undefined;
  let inbox: Inbox | undefined;
  let active: Identity | undefined;
  let context: ExtensionContext | undefined;
  let historical = new Set<string>();
  let recorded = new Set<string>();
  let invalidated = new Set<string>();
  let lastErrorAt = 0;
  const outgoing = new Outgoing();
  const sendViews = new Map<string, () => void>();
  let notifications: RecordingNotifications | undefined;

  const notificationFailed = (update: RecordedUpdate, error: Error) => {
    if (!active || !sameIdentity(active, update.sender)) return;
    pi.appendEntry<DeliveryEvent>(DELIVERY, { kind: "notificationFailed", update, error: safeText(error.message), at: Date.now() });
    if (context?.hasUI && Date.now() - lastErrorAt >= 1000) {
      lastErrorAt = Date.now();
      context.ui.notify(`Peloton recording update for ${update.id} failed: ${safeText(error.message)}`, "warning");
    }
  };

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
      status({ kind: "invalidated", key, envelope, text: `Pending peer message ${envelope.id} invalidated by shutdown/reload/session change.`, at: Date.now() });
    }
    const old = server;
    server = undefined;
    inbox = undefined;
    client = undefined;
    await notifications?.close();
    notifications = undefined;
    outgoing.clear();
    sendViews.clear();
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
    recorded = new Set(historical);
    const directory = runtimeDirectory();
    const recipient = identity(process.pid, instance);
    const nextInbox = new Inbox(recipient);
    active = recipient;
    inbox = nextInbox;
    const nextClient = new PeerClient(directory);
    client = nextClient;
    notifications = new RecordingNotifications(async (update, signal) => {
      // Extension message_end precedes Pi's session append. Do not report
      // recorded until the matching entry is actually observable in this branch.
      await waitForRecording(() => active === recipient && ctx.sessionManager.getBranch().some(entry => {
        if (entry.type !== "custom_message" || entry.customType !== MESSAGE) return false;
        const details = entry.details as PeerDetails | undefined;
        const envelope = details?.envelope;
        return envelope?.id === update.id && sameIdentity(envelope.recipient, update.sender)
          && sameIdentity(envelope.sender, update.recipient);
      }), signal);
      return nextClient.sendRecorded(update, signal);
    }, notificationFailed);
    server = new PeerServer(directory, recipient, envelope => {
      if (active !== recipient || context !== ctx) throw new Error("Recipient session changed");
      nextInbox.accept(envelope);
      try {
        const acceptedAt = Date.now();
        // This entry makes even passive/queued messages visible immediately.
        status({ kind: "queued", text: "Accepted by recipient.", envelope, at: acceptedAt });
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
    }, report, update => {
      if (active !== recipient || context !== ctx) throw new Error("Recipient session changed");
      if (outgoing.receive(update)) {
        pi.appendEntry<DeliveryEvent>(DELIVERY, { kind: "recorded", update, at: Date.now() });
        outgoing.refresh(update.id);
      }
    });
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
      if (details?.envelope) {
        const envelope = details.envelope;
        const key = messageKey(envelope);
        const firstRecording = !recorded.has(key);
        recorded.add(key);
        inbox?.recorded(envelope);
        if (firstRecording && !invalidated.has(key) && active && sameIdentity(active, envelope.recipient)) {
          const update = recordingUpdate(envelope);
          try { notifications?.enqueue(update); }
          catch (error) { notificationFailed(update, error instanceof Error ? error : new Error(String(error))); }
        }
      }
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
      status({ kind: "invalidated", key, envelope: details.envelope, text: `Excluded stale peer message ${details.envelope.id} from model context.`, at: Date.now() });
      return false;
    }),
  }));

  pi.registerMessageRenderer<PeerDetails>(MESSAGE, (message, { expanded }, theme) => {
    const envelope = message.details?.envelope;
    const box = new Box(1, 1, text => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", peerHeader("←", envelope?.sender.pid, envelope?.delivery, "recorded")), 0, 0));
    box.addChild(new Text(theme.fg("text", safeText(envelope?.content ?? message.content)), 0, 0));
    if (expanded) {
      box.addChild(new Text(theme.fg("dim", `Message ID: ${safeText(envelope?.id)}${envelope?.replyTo ? ` · reply to: ${safeText(envelope.replyTo)}` : ""}`), 0, 0));
    }
    return box;
  });
  pi.registerEntryRenderer<Status>(STATUS, (entry, { expanded }, theme) => {
    const data = entry.data;
    const envelope = data?.envelope;
    const stage: CardStatus = data?.kind === "queued" ? "accepted" : data?.kind === "invalidated" ? "invalidated" : "error";
    const tone = stage === "accepted" ? "dim" : "warning";
    const box = new Box(1, 1, text => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg(tone, peerHeader("←", envelope?.sender.pid, envelope?.delivery, stage)), 0, 0));
    box.addChild(new Text(theme.fg(tone, safeText(envelope?.content ?? data?.text)), 0, 0));
    if (expanded && envelope) {
      const metadata = `Message ID: ${safeText(envelope.id)}${envelope.replyTo ? ` · reply to: ${safeText(envelope.replyTo)}` : ""}`;
      box.addChild(new Text(theme.fg("dim", stage === "invalidated" ? `${metadata} · ${safeText(data?.text)}` : metadata), 0, 0));
    }
    // Always retain a component: Pi omits entries whose renderer returns
    // undefined, which would also make them unavailable to Ctrl-O on resume.
    // Check visibility at render time so an already-displayed acceptance card
    // disappears on the normal repaint when its custom message is recorded.
    const key = data?.kind === "queued" && data.envelope ? messageKey(data.envelope) : undefined;
    return {
      render(width: number) {
        if (key && recorded.has(key) && !expanded) return [];
        return box.render(width);
      },
      invalidate() { box.invalidate(); },
    };
  });

  pi.registerTool({
    name: "peer_send",
    label: "Peer send",
    description: "Send attributed collaborator input to an already-prepared local Pi instance, targeting its Pi process PID (not tmux's shell PID). Default followUp wakes an idle peer or queues while busy. Explicit steer corrects ongoing work; nextTurn is passive until the next user prompt. Replies arrive automatically; if only waiting for one, finish your turn instead of polling or sleeping. Acceptance does not mean read, replied, or completed. Does not reset sessions or grant permissions.",
    promptGuidelines: [
      "Default follow-up replies to peer_send arrive automatically through Peloton. No polling or sleep loop is needed to receive a reply; keeping your turn busy delays follow-up delivery.",
      "When collaborating via peer_send, continue independent work when available. If only waiting for a peer response, finish the current turn so queued follow-ups can be delivered and later follow-up replies can wake you. Ending the turn is not declaring the task complete.",
    ],
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
      const messageId = randomUUID();
      const details: SendDetails = { messageId, senderSession: context?.sessionManager.getSessionId() };
      try {
        const result = await senderClient.send(sender, params.target, params.content, params.delivery ?? "followUp", {
          replyTo: params.replyTo, signal, id: messageId,
          onEnvelope(envelope) {
            if (active !== sender) throw new Error("Sender conversation changed");
            outgoing.prepare(envelope);
            details.envelope = envelope;
            const view = sendViews.get(_id);
            if (view) outgoing.watch(messageId, view);
          },
        });
        if (active !== sender) throw new Error("Sender conversation changed; recipient acceptance may have occurred");
        outgoing.accepted(messageId); // Never regress an early recording update.
        details.receipt = result.receipt;
        return {
          content: [{ type: "text", text: `${peerHeader("→", params.target, result.envelope.delivery, "accepted")}\nMessage ID: ${messageId}` }],
          details,
        };
      } catch (error) {
        if (active !== sender) throw error;
        outgoing.failed(messageId);
        details.error = safeText(error instanceof Error ? error.message : String(error));
        return { content: [{ type: "text", text: details.error }], details, isError: true };
      }
    },
    renderCall(params, theme, ctx) {
      // A callback can update this row even before its acceptance response arrives.
      const view = () => { ctx.state.peerRecorded = true; ctx.invalidate(); };
      sendViews.delete(ctx.toolCallId);
      sendViews.set(ctx.toolCallId, view);
      if (sendViews.size > LIMITS.outgoing) sendViews.delete(sendViews.keys().next().value!);
      return {
        render(width: number) {
          const stage: CardStatus = ctx.state.peerRecorded ? "recorded" : ctx.state.peerStatus ?? "sending";
          const tone = stage === "error" ? "warning" : stage === "recorded" ? "accent" : "dim";
          const body = stage === "error" ? ctx.state.peerError : params.content;
          return new Text(`${theme.fg(tone, peerHeader("→", params.target, params.delivery ?? "followUp", stage))}\n${theme.fg(stage === "recorded" ? "text" : tone, safeText(body))}`, 0, 0).render(width);
        },
        invalidate() {},
      };
    },
    renderResult(result, options, theme, ctx) {
      ctx.state.peerStatus = ctx.isError ? "error" : options.isPartial ? "sending" : "accepted";
      ctx.state.peerError = result.details?.error ?? result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const details = result.details;
      const id = details?.messageId ?? details?.receipt?.id;
      if (id) {
        if (outgoing.get(id)?.stage === "recorded") ctx.state.peerRecorded = true;
        const view = sendViews.get(ctx.toolCallId);
        if (view) outgoing.watch(id, view);
        if (!ctx.state.peerHistoryChecked) {
          ctx.state.peerHistoryChecked = true;
          if (details?.envelope) {
            const envelope = details.envelope;
            ctx.state.peerRecorded ||= context?.sessionManager.getBranch().some(entry => {
              if (entry.type !== "custom" || entry.customType !== DELIVERY) return false;
              const data = entry.data as DeliveryEvent | undefined;
              return data?.kind === "recorded" && data.update.id === id
                && sameIdentity(data.update.sender, envelope.recipient) && sameIdentity(data.update.recipient, envelope.sender);
            });
          }
        }
      }
      if (!options.expanded) return { render: () => [], invalidate() {} };
      const text = ctx.isError
        ? `Original message: ${safeText(ctx.args.content)}`
        : `Message ID: ${safeText(id)}${details?.envelope?.replyTo ? ` · reply to: ${safeText(details.envelope.replyTo)}` : ""}`;
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}
