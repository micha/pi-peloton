import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Inbox } from "./inbox.ts";
import { identity, deliveryOptions, safeText, messageKey, recordingUpdate, sameIdentity, isPid, isToken, LIMITS, type Envelope, type Identity, type Receipt, type RecordedUpdate } from "./protocol.ts";
import { PeerServer, PeerClient } from "./transport.ts";
import { startupConfiguration } from "./configuration.ts";
import { PeerRouting, RouteError } from "./routing.ts";
import { peerHeader, type CardStatus } from "./presentation.ts";
import { Outgoing, RecordingNotifications, waitForRecording } from "./recording.ts";
import { PELOTON_SEND, peerSendResultEvent, PELOTON_DELIVERY, PELOTON_ROUTE, peerRouteResultEvent,
  type PeerRouteRequest, type PeerRouteResponse, type PeerRouteResult, type PeerSendInput, type PeerSendRequest,
  type PeerSendResponse, type PeerSendResult, type PeerSendErrorCode, type PeerDeliveryStatus } from "./api.ts";

const MESSAGE = "peloton.peer";
const STATUS = "peloton.status";
const DELIVERY = "peloton.delivery";
const SENT = "peloton.sent";
const SEND_RESULT = "peloton.send-result";
// Preserve process identity across extension reloads; no sockets/timers start here.
const instanceKey = Symbol.for("pi-peloton.process-instance.v1");
const processGlobals = globalThis as typeof globalThis & { [instanceKey]?: string };
const instance = processGlobals[instanceKey] ??= randomUUID();
interface PeerDetails { envelope: Envelope; recipientSession: string; acceptedAt: number }
interface Status { kind: "queued" | "invalidated" | "error"; text: string; key?: string; envelope?: Envelope; at: number }
interface SendDetails { messageId: string; envelope?: Envelope; receipt?: Receipt; senderSession?: string; error?: string }
interface SkippedSendDetails { pendingFromTarget: ReturnType<Inbox["pendingFrom"]> }
interface DeliveryEvent { kind: "recorded" | "notificationFailed"; update: RecordedUpdate; error?: string; at: number }
interface SentEntry { messageId: string; input: PeerSendInput; senderSession: string; at: number }
interface SendOutcome { result: PeerSendResult; details: SendDetails }

function validateInput(value: unknown): PeerSendInput {
  if (!value || typeof value !== "object") throw new Error("Invalid send input");
  const input = value as PeerSendInput;
  if (!isPid(input.target) || typeof input.content !== "string" || !input.content.trim()
    || Buffer.byteLength(input.content) > LIMITS.contentBytes
    || (input.delivery !== undefined && !["followUp", "steer", "nextTurn"].includes(input.delivery))
    || (input.replyTo !== undefined && !isToken(input.replyTo))
    || Object.keys(input).some(key => !["target", "content", "delivery", "replyTo"].includes(key))) {
    throw new Error("Invalid target, content, delivery, replyTo, or extra send fields (content limit: 16 KiB UTF-8)");
  }
  return { target: input.target, content: input.content, delivery: input.delivery ?? "followUp",
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}) };
}

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
  let footerText: string | undefined;
  let stopRequests: (() => void) | undefined;
  let stopRoutes: (() => void) | undefined;
  let routing: PeerRouting | undefined;
  const requests = new Set<string>();
  const sends = new Map<string, { abort: AbortController; done: Promise<SendOutcome> }>();

  // Observer failures must not change transport acceptance or fail a model tool.
  const publish = (data: PeerDeliveryStatus) => { try { pi.events.emit(PELOTON_DELIVERY, data); } catch {} };
  const deliveryStatus = (envelope: Envelope, stage: PeerDeliveryStatus["stage"], extra = {}) => {
    publish({ messageId: envelope.id, target: envelope.recipient.pid, delivery: envelope.delivery,
      senderSession: context!.sessionManager.getSessionId(), stage, at: Date.now(), ...extra } as PeerDeliveryStatus);
  };

  // Both entry points own the same validation, transport, cancellation and tracking.
  const send = (value: unknown, messageId: string, signal?: AbortSignal, toolCallId?: string): Promise<SendOutcome> => {
    const sender = active;
    const senderClient = client;
    const senderSession = context?.sessionManager.getSessionId();
    const details: SendDetails = { messageId, senderSession };
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    let input: PeerSendInput | undefined;
    let code: PeerSendErrorCode = "invalid_request";
    let journaled = false;
    const done = (async (): Promise<SendOutcome> => {
      let result: PeerSendResult;
      try {
        input = validateInput(value);
        code = "unavailable";
        if (!sender || !senderClient || !senderSession) throw new Error("Peloton endpoint is unavailable");
        code = "busy";
        if (sends.size >= LIMITS.connections) throw new Error("Peloton active-send limit reached");
        code = "cancelled";
        combined.throwIfAborted();
        code = "send_failed";
        if (toolCallId === undefined) {
          pi.appendEntry<SentEntry>(SENT, { messageId, input, senderSession, at: Date.now() });
          journaled = true;
        }
        const sent = await senderClient.send(sender, input.target, input.content, input.delivery, {
          replyTo: input.replyTo, signal: combined, id: messageId,
          onEnvelope(envelope) {
            if (active !== sender) throw new Error("Sender conversation changed");
            const evicted = outgoing.prepare(envelope);
            if (evicted) deliveryStatus(evicted.envelope, "untracked", { lastStage: evicted.stage, reason: "evicted" });
            details.envelope = envelope;
            const view = toolCallId !== undefined ? sendViews.get(toolCallId) : undefined;
            if (view) outgoing.watch(messageId, view);
            deliveryStatus(envelope, "sending");
            refreshStatus();
          },
        });
        details.receipt = sent.receipt;
        if (active !== sender) throw new Error("Sender conversation changed; recipient acceptance may have occurred");
        outgoing.accepted(messageId); // Never regress an early recording update.
        refreshStatus();
        const stage = outgoing.get(messageId)?.stage === "recorded" ? "recorded" : "accepted";
        if (stage === "accepted") deliveryStatus(sent.envelope, stage);
        result = { messageId, senderSession, ok: true, acceptance: "accepted", stage, acceptedAt: sent.receipt.acceptedAt };
      } catch (error) {
        if (sender && active !== sender) code = "session_changed";
        else if (combined.aborted) code = "cancelled";
        outgoing.failed(messageId);
        refreshStatus();
        details.error = safeText(error instanceof Error ? error.message : String(error));
        const recorded = outgoing.get(messageId)?.stage === "recorded";
        result = { messageId, senderSession, ok: false, stage: recorded ? "recorded" : "error",
          acceptance: recorded || details.receipt ? "accepted" : details.envelope ? "unknown" : "not-sent",
          error: { code, message: details.error } };
        if (details.envelope && !recorded) deliveryStatus(details.envelope, "error", { error: details.error });
      }
      const outcome = { result, details };
      if (journaled) {
        // Keep extension-originated sends durable without adding sender model input.
        try { pi.appendEntry<SendOutcome>(SEND_RESULT, outcome); }
        catch {
          details.error = "Could not persist Peloton send result; recipient acceptance may have occurred";
          outgoing.failed(messageId);
          refreshStatus();
          if (details.envelope && result.stage !== "recorded") deliveryStatus(details.envelope, "error", { error: details.error });
          result = { messageId, senderSession, ok: false, acceptance: result.acceptance, stage: result.stage === "recorded" ? "recorded" : "error",
            error: { code: "send_failed", message: details.error } };
          return { result, details };
        }
      }
      return outcome;
    })().finally(() => { sends.delete(messageId); });
    sends.set(messageId, { abort, done });
    return done;
  };

  const listen = () => {
    const sessionRouting = routing!;
    stopRoutes = pi.events.on(PELOTON_ROUTE, data => {
      const request = data as PeerRouteRequest | undefined;
      if (!request || !isToken(request.requestId)) return;
      let result: PeerRouteResult;
      try {
        sessionRouting.register(request.input, request.signal);
        result = { ok: true, target: request.input.target };
      } catch (error) {
        result = { ok: false, error: { code: error instanceof RouteError ? error.code : "invalid_request",
          message: safeText(error instanceof Error ? error.message : String(error)) } };
      }
      try { pi.events.emit(peerRouteResultEvent(request.requestId), { requestId: request.requestId, result } satisfies PeerRouteResponse); } catch {}
    });
    stopRequests = pi.events.on(PELOTON_SEND, async data => {
      const request = data as PeerSendRequest | undefined;
      // Without a valid correlation ID there is no safe response destination.
      if (!request || !isToken(request.requestId)) return;
      const messageId = request.requestId;
      let result: PeerSendResult;
      if (requests.has(messageId) || sends.has(messageId) || outgoing.get(messageId)) {
        result = { messageId, ok: false, acceptance: "not-sent", stage: "error",
          error: { code: "duplicate_request", message: "Request ID already used; no retry was performed" } };
      } else if (request.signal !== undefined && !(request.signal instanceof AbortSignal)) {
        result = { messageId, ok: false, acceptance: "not-sent", stage: "error",
          error: { code: "invalid_request", message: "signal must be an AbortSignal" } };
      } else {
        requests.add(messageId);
        if (requests.size > LIMITS.duplicates) requests.delete(requests.values().next().value!);
        result = (await send(request.input, messageId, request.signal)).result;
      }
      try { pi.events.emit(peerSendResultEvent(messageId), { requestId: messageId, result } satisfies PeerSendResponse); } catch {}
    });
  };

  const refreshStatus = () => {
    if (!active || !context?.hasUI) return;
    const text = `${active.pid} →${outgoing.pendingCount} ←${inbox?.pending.size ?? 0}`;
    if (text === footerText) return;
    context.ui.setStatus("peloton", text);
    footerText = text;
  };

  const notificationFailed = (update: RecordedUpdate, error: Error) => {
    if (!active || !sameIdentity(active, update.sender)) return;
    pi.appendEntry<DeliveryEvent>(DELIVERY, { kind: "notificationFailed", update, error: safeText(error.message), at: Date.now() });
    if (context?.hasUI && Date.now() - lastErrorAt >= 1000) {
      lastErrorAt = Date.now();
      context.ui.notify(`Peloton recording update for ${update.id} failed: ${safeText(error.message)}`, "warning");
    }
  };

  const status = (data: Status) => pi.appendEntry(STATUS, data);
  const report = (error: Error, force = false) => {
    // Bound protocol-error chatter, but never suppress endpoint startup failure.
    if (!force && Date.now() - lastErrorAt < 1000) return;
    lastErrorAt = Date.now();
    status({ kind: "error", text: safeText(error.message), at: Date.now() });
    if (context?.hasUI) context.ui.notify(`Peloton: ${safeText(error.message)}`, "error");
  };

  const close = async () => {
    stopRequests?.();
    stopRequests = undefined;
    stopRoutes?.();
    stopRoutes = undefined;
    active = undefined;
    routing?.close();
    routing = undefined;
    // Settle and journal old-conversation work before abandoning its context.
    for (const send of sends.values()) send.abort.abort();
    await Promise.all([...sends.values()].map(send => send.done));
    requests.clear();
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
    for (const discarded of outgoing.clear()) {
      deliveryStatus(discarded.envelope, "untracked", { lastStage: discarded.stage, reason: "lifecycle" });
    }
    sendViews.clear();
    await old?.close();
    context?.ui.setStatus("peloton", undefined);
    footerText = undefined;
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
    let config: ReturnType<typeof startupConfiguration>;
    try { config = startupConfiguration(); }
    catch (error) {
      report(error instanceof Error ? error : new Error(String(error)), true);
      await close();
      return;
    }
    const directory = config.runtimeDirectory;
    const recipient = identity(config.advertisedPid, instance);
    const nextInbox = new Inbox(recipient);
    active = recipient;
    inbox = nextInbox;
    const nextRouting = new PeerRouting(config);
    routing = nextRouting;
    const nextClient = new PeerClient(directory, target => nextRouting.resolve(target));
    client = nextClient;
    notifications = new RecordingNotifications(async (update, signal) => {
      const route = nextRouting.resolve(update.recipient.pid);
      const workSignal = route.signal ? AbortSignal.any([signal, route.signal]) : signal;
      // Extension message_end precedes Pi's session append. Do not report
      // recorded until the matching entry is actually observable in this branch.
      await waitForRecording(() => active === recipient && ctx.sessionManager.getBranch().some(entry => {
        if (entry.type !== "custom_message" || entry.customType !== MESSAGE) return false;
        const details = entry.details as PeerDetails | undefined;
        const envelope = details?.envelope;
        return envelope?.id === update.id && sameIdentity(envelope.recipient, update.sender)
          && sameIdentity(envelope.sender, update.recipient);
      }), workSignal);
      return nextClient.sendRecorded(update, workSignal);
    }, notificationFailed);
    server = new PeerServer(directory, recipient, envelope => {
      if (active !== recipient || context !== ctx) throw new Error("Recipient session changed");
      nextInbox.accept(envelope);
      try {
        refreshStatus();
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
        refreshStatus();
        throw error;
      }
    }, report, update => {
      if (active !== recipient || context !== ctx) throw new Error("Recipient session changed");
      if (outgoing.receive(update)) {
        pi.appendEntry<DeliveryEvent>(DELIVERY, { kind: "recorded", update, at: Date.now() });
        outgoing.refresh(update.id);
        refreshStatus();
        const tracked = outgoing.get(update.id)!;
        deliveryStatus(tracked.envelope, "recorded");
      }
    });
    try {
      await server.start();
      listen();
      refreshStatus();
    } catch (error) {
      report(error instanceof Error ? error : new Error(String(error)), true);
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
        refreshStatus();
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

  // One transcript-only card per extension send, updated by normal entry repaints.
  // Both its result and recording proof are restored from the active branch.
  pi.registerEntryRenderer<SentEntry>(SENT, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    return {
      render(width: number) {
        const { messageId, input } = data;
        const branch = context?.sessionManager.getBranch() ?? [];
        let outcome: SendOutcome | undefined;
        for (const record of branch) {
          if (record.type === "custom" && record.customType === SEND_RESULT) {
            const candidate = record.data as SendOutcome;
            if (candidate?.result?.messageId === messageId) outcome = candidate;
          }
        }
        const envelope = outcome?.details.envelope;
        const proof = envelope && branch.some(record => {
          if (record.type !== "custom" || record.customType !== DELIVERY) return false;
          const data = record.data as DeliveryEvent;
          return data?.kind === "recorded" && data.update.id === messageId
            && sameIdentity(data.update.sender, envelope.recipient) && sameIdentity(data.update.recipient, envelope.sender);
        });
        const stage: CardStatus = proof ? "recorded" : outgoing.get(messageId)?.stage ?? outcome?.result.stage ?? "sending";
        const tone = stage === "recorded" ? "accent" : stage === "error" ? "warning" : "dim";
        const box = new Box(1, 1, text => theme.bg("customMessageBg", text));
        box.addChild(new Text(theme.fg(tone, peerHeader("→", input.target, input.delivery, stage)), 0, 0));
        const error = outcome?.result.ok === false ? outcome.result.error.message : "Send failed";
        box.addChild(new Text(theme.fg(stage === "recorded" ? "text" : tone, safeText(stage === "error" ? error : input.content)), 0, 0));
        if (expanded) {
          box.addChild(new Text(theme.fg("dim", `Message ID: ${safeText(messageId)}${input.replyTo ? ` · reply to: ${safeText(input.replyTo)}` : ""}`), 0, 0));
          if (stage === "error") box.addChild(new Text(theme.fg("dim", `Original message: ${safeText(input.content)}`), 0, 0));
        }
        return box.render(width);
      },
      invalidate() {},
    };
  });

  const peerSendParameters = Type.Object({
    target: Type.Integer({ minimum: 1, maximum: 2147483647, description: "Receiving Pi process PID" }),
    content: Type.String({ minLength: 1, maxLength: LIMITS.contentBytes }),
    delivery: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")])),
    replyTo: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9-]{1,80}$" })),
    skipIfPendingFromTarget: Type.Optional(Type.Boolean({
      description: "Do not send if this session already has an accepted followUp or steer from the target PID pending delivery. Reports counts by mode. Does not wait, queue, or retry this send. Default: false.",
    })),
  }, { additionalProperties: false });

  pi.registerTool<typeof peerSendParameters, SendDetails | SkippedSendDetails>({
    name: "peer_send",
    label: "Peer send",
    description: "Send attributed collaborator input to an already-prepared local Pi instance, targeting its Pi process PID (not tmux's shell PID). Default followUp wakes an idle peer; for a busy peer it waits until the receiving agent yields (ends its current run with a final response), not merely finishes a tool or subtask. Use explicit steer for messages that could change the peer's next action. Replies arrive automatically; if only waiting for one, yield by ending your current run with a final response instead of polling or sleeping. Acceptance does not mean read, replied, or completed. Does not reset sessions or grant permissions.",
    promptGuidelines: [
      "If a reply, finding, or correction could change the peer's next action, use peer_send with delivery: \"steer\". This includes design/review findings needed during ongoing work, even if not urgent. Example: \"Acknowledged; I'll leave that file to you.\" uses steer when the peer needs that acknowledgement to proceed.",
      "Use peer_send with delivery: \"followUp\" only if the message can safely wait until the receiving agent yields (ends its current run with a final response). Finishing a tool or subtask does not deliver it; newer steer messages may overtake it. The receiver must yield, not the sender. An idle receiver wakes immediately. Example: \"After you finish your current run and yield, please start a separate review of these unrelated documentation changes.\"",
      "For a peer_send that could depend on a queued reply, set skipIfPendingFromTarget: true. If skipped, let pending steer messages arrive at the next supported boundary; if you need a pending followUp to proceed, yield by ending your current run instead of retrying or polling.",
      "Default follow-up replies to peer_send arrive automatically through Peloton. No polling or sleep loop is needed to receive a reply; keeping your own run busy delays incoming follow-up delivery.",
      "When collaborating via peer_send, continue independent work when available. If only waiting for a peer response, yield by ending your current run with a final response instead of more tool calls, so queued follow-ups can be delivered and later follow-up replies can wake you. Ending the run is not declaring the task complete.",
    ],
    parameters: peerSendParameters,
    async execute(_id, params, signal) {
      const { skipIfPendingFromTarget, ...input } = params;
      // Fail closed for old/direct tool calls too; never silently change delivery.
      if ((input as PeerSendInput).delivery === "nextTurn") {
        throw new Error("peer_send supports only followUp or steer; nextTurn is available only through the extension API.");
      }
      if (skipIfPendingFromTarget === true && active && inbox && !signal?.aborted) {
        const pendingFromTarget = inbox.pendingFrom(input.target);
        const { followUp, steer } = pendingFromTarget;
        if (followUp || steer) {
          validateInput(input); // A skipped call must still have valid send arguments.
          const modes = [followUp && `followUp: ${followUp}`, steer && `steer: ${steer}`].filter(Boolean).join(", ");
          return {
            content: [{ type: "text", text: `Not sent: accepted messages from Pi PID ${input.target} are pending delivery (${modes}).` }],
            details: { pendingFromTarget } satisfies SkippedSendDetails,
          };
        }
      }
      const { result, details } = await send(input, randomUUID(), signal, _id);
      if (!result.ok) {
        if (result.error.code === "unavailable" || result.error.code === "session_changed") throw new Error(result.error.message);
        return { content: [{ type: "text", text: result.error.message }], details, isError: true };
      }
      return {
        content: [{ type: "text", text: `${peerHeader("→", params.target, params.delivery ?? "followUp", "accepted")}\nMessage ID: ${result.messageId}` }],
        details,
      };
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
          const showNotice = stage === "error" || stage === "not sent";
          const tone = showNotice ? "warning" : stage === "recorded" ? "accent" : "dim";
          const body = showNotice ? ctx.state.peerNotice : params.content;
          return new Text(`${theme.fg(tone, peerHeader("→", params.target, params.delivery ?? "followUp", stage))}\n${theme.fg(stage === "recorded" ? "text" : tone, safeText(body))}`, 0, 0).render(width);
        },
        invalidate() {},
      };
    },
    renderResult(result, options, theme, ctx) {
      const toolDetails = result.details;
      const skipped = toolDetails != null && "pendingFromTarget" in toolDetails;
      const details = skipped ? undefined : toolDetails;
      ctx.state.peerStatus = skipped ? "not sent" : ctx.isError ? "error" : options.isPartial ? "sending" : "accepted";
      ctx.state.peerNotice = details?.error ?? result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
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
      const text = skipped || ctx.isError
        ? `Original message: ${safeText(ctx.args.content)}`
        : `Message ID: ${safeText(id)}${details?.envelope?.replyTo ? ` · reply to: ${safeText(details.envelope.replyTo)}` : ""}`;
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}
