import { createEventBus } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js";

export function harness() {
  const handlers = new Map<string, Function[]>();
  const messages: any[] = [];
  const entries: any[] = [];
  const tools: any[] = [];
  const renderers = new Map<string, Function>();
  const statuses = new Map<string, string>();
  const statusHistory: (string | undefined)[] = [];
  let sessionId = "session-1";
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    ui: new Proxy({
      setStatus(key: string, text: string | undefined) {
        if (text === undefined) statuses.delete(key); else statuses.set(key, text);
        statusHistory.push(text);
      },
      notify() {},
    }, {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        throw new Error(`Unexpected editor/UI access: ${String(key)}`);
      },
    }),
  };
  const pi = {
    events: createEventBus(),
    on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
    registerMessageRenderer(name: string, renderer: Function) { renderers.set(name, renderer); },
    registerEntryRenderer(name: string, renderer: Function) { renderers.set(name, renderer); },
    registerTool(tool: any) { tools.push(tool); },
  };
  return {
    pi, ctx, messages, entries, tools, renderers, statuses, statusHistory,
    session(id: string) { sessionId = id; },
    async emit(name: string, event: any = {}) {
      let result;
      for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
      // Match Pi 1.0.3 ordering: extension handlers run before session append.
      if (name === "message_end" && event.message.role === "custom") {
        entries.push({ type: "custom_message", customType: event.message.customType,
          content: event.message.content, details: event.message.details });
      }
      return result;
    },
  };
}
