import { safeText } from "./protocol.ts";

export type CardStatus = "sending" | "accepted" | "recorded" | "invalidated" | "error";

export function peerHeader(direction: "←" | "→", pid: unknown, delivery: unknown, status: CardStatus): string {
  return `PEER ${direction} Pi PID ${safeText(pid ?? "?")} · ${safeText(delivery ?? "unknown")} · ${status}`;
}
