import { LIMITS } from "./protocol.ts";
import { validateRoute, type PeerRouteInput, type PelotonConfiguration } from "./configuration.ts";
import type { PeerEndpoint } from "./transport.ts";
import type { PeerRouteErrorCode } from "./api.ts";

export class RouteError extends Error {
  constructor(readonly code: PeerRouteErrorCode, message: string) { super(message); }
}
interface Route {
  directory: string;
  abort: AbortController;
  stop?: () => void;
}

/** One-shot session-scoped routes. Retired targets remain tombstones, never fallback. */
export class PeerRouting {
  private routes = new Map<number, Route>();
  private lifetime = new AbortController();
  constructor(private config: PelotonConfiguration) {
    for (const route of config.routes) this.add(route);
  }
  register(value: unknown, signal: AbortSignal) {
    if (this.lifetime.signal.aborted) throw new RouteError("unavailable", "Peloton routing is closed");
    let input: PeerRouteInput;
    try { input = validateRoute(value); }
    catch (error) { throw new RouteError("invalid_request", (error as Error).message); }
    if (input.target === this.config.advertisedPid) throw new RouteError("invalid_request", "Cannot route to this Pi instance");
    if (!(signal instanceof AbortSignal)) throw new RouteError("invalid_request", "Route ownership requires an AbortSignal");
    if (signal.aborted) throw new RouteError("cancelled", "Route owner is already cancelled");
    if (this.routes.has(input.target)) throw new RouteError("conflict", "Target already has an active or retired route; no replacement was performed");
    if (this.routes.size >= LIMITS.duplicates) throw new RouteError("limit", "Peloton route limit reached (including retired targets)");
    const route = this.add(input);
    const revoke = () => route.abort.abort(new Error("Peer route revoked; acceptance may be unknown"));
    signal.addEventListener("abort", revoke, { once: true });
    route.stop = () => signal.removeEventListener("abort", revoke);
  }
  private add(input: PeerRouteInput): Route {
    const route = { directory: input.directory, abort: new AbortController() };
    this.routes.set(input.target, route);
    return route;
  }
  resolve(target: number): PeerEndpoint {
    if (this.lifetime.signal.aborted) throw new Error("Peloton routing is closed");
    const route = this.routes.get(target);
    if (route) {
      if (route.abort.signal.aborted) throw new Error("Peer route revoked; no fallback is permitted");
      return { directory: route.directory, signal: route.abort.signal };
    }
    if (this.config.routePolicy === "explicit") throw new Error("No explicit route for this Pi PID");
    return { directory: this.config.runtimeDirectory, signal: this.lifetime.signal };
  }
  close() {
    this.lifetime.abort();
    for (const route of this.routes.values()) {
      route.stop?.();
      route.abort.abort();
    }
    this.routes.clear();
  }
}
