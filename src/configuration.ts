import { isAbsolute } from "node:path";
import { isPid, LIMITS } from "./protocol.ts";
import { runtimeDirectory, socketPath } from "./transport.ts";

export interface PeerRouteInput { target: number; directory: string }
export interface PelotonConfiguration {
  version: 1;
  advertisedPid: number;
  runtimeDirectory: string;
  routePolicy: "default" | "explicit";
  routes: PeerRouteInput[];
}
export const CONFIG_ENV = "PI_PELOTON_CONFIG";

export function validateRoute(value: unknown): PeerRouteInput {
  const route = value as PeerRouteInput | undefined;
  if (!route || typeof route !== "object" || !isPid(route.target)
    || typeof route.directory !== "string" || !isAbsolute(route.directory) || route.directory.includes("\0")
    || Object.keys(route).some(key => !["target", "directory"].includes(key))) {
    throw new Error("Route requires a Pi PID and an absolute directory, with no extra fields");
  }
  socketPath(route.directory, route.target);
  return { target: route.target, directory: route.directory };
}

/** Trusted launcher configuration only; never read workspace files or peer content. */
export function readConfiguration(env = process.env): PelotonConfiguration {
  const source = env[CONFIG_ENV];
  if (source === undefined) return { version: 1, advertisedPid: process.pid,
    runtimeDirectory: runtimeDirectory(env), routePolicy: "default", routes: [] };
  if (Buffer.byteLength(source) > 64 * 1024) throw new Error(`${CONFIG_ENV} exceeds 64 KiB`);
  let config: PelotonConfiguration;
  try { config = JSON.parse(source); }
  catch { throw new Error(`${CONFIG_ENV} must contain valid JSON`); }
  if (!config || typeof config !== "object" || config.version !== 1 || !isPid(config.advertisedPid)
    || typeof config.runtimeDirectory !== "string" || !isAbsolute(config.runtimeDirectory) || config.runtimeDirectory.includes("\0")
    || !["default", "explicit"].includes(config.routePolicy) || !Array.isArray(config.routes)
    || config.routes.length > LIMITS.duplicates
    || Object.keys(config).some(key => !["version", "advertisedPid", "runtimeDirectory", "routePolicy", "routes"].includes(key))) {
    throw new Error(`Invalid or incomplete ${CONFIG_ENV} v1 configuration`);
  }
  socketPath(config.runtimeDirectory, config.advertisedPid);
  const seen = new Set<number>();
  const routes = config.routes.map(value => {
    const route = validateRoute(value);
    if (route.target === config.advertisedPid || seen.has(route.target)) throw new Error("Duplicate or self-targeted route");
    seen.add(route.target);
    return route;
  });
  return { version: 1, advertisedPid: config.advertisedPid, runtimeDirectory: config.runtimeDirectory,
    routePolicy: config.routePolicy, routes };
}

const bootstrapKey = Symbol.for("pi-peloton.bootstrap.v1");
type Bootstrap = { source: string | undefined; config: PelotonConfiguration };
const globals = globalThis as typeof globalThis & { [bootstrapKey]?: Bootstrap };
/** Freeze explicit bootstrap across reload, including the process's advertised PID. */
export function startupConfiguration(): PelotonConfiguration {
  const source = process.env[CONFIG_ENV];
  const previous = globals[bootstrapKey];
  if (previous && previous.source !== source) throw new Error(`${CONFIG_ENV} cannot change within a Pi process; restart deliberately`);
  const config = previous?.config ?? readConfiguration();
  globals[bootstrapKey] ??= { source, config };
  // Preserve the ordinary, unconfigured XDG runtime behavior on session startup.
  return source === undefined ? readConfiguration() : config;
}
