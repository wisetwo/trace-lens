import { execFileSync } from "node:child_process";
import type { Server, ServerResponse } from "node:http";

export interface ListenResult {
  port: number;
  /** Set when the preferred port was busy and another one was used. */
  warning?: string;
}

export interface ListenOptions {
  /** Ports that must not be taken when falling back (e.g. reserved by other listeners in the same config). */
  skip?: Iterable<number>;
  attempts?: number;
}

const inFlight = new WeakMap<Server, Set<ServerResponse>>();

/** Listen on `port`, or on the next free port when it is already in use. */
export async function listenWithFallback(server: Server, port: number, host: string | undefined, options: ListenOptions = {}): Promise<ListenResult> {
  trackInFlight(server);
  const skip = new Set(options.skip ?? []);
  const attempts = options.attempts ?? 100;
  for (let candidate = port, tried = 0; tried < attempts && candidate <= 65535; candidate += 1) {
    if (candidate !== port && skip.has(candidate)) continue;
    tried += 1;
    try {
      await listenOnce(server, candidate, host);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw new Error(`Cannot listen on ${host ?? "*"}:${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (candidate === port) return { port };
    const owner = portOwner(port);
    return { port: candidate, warning: `port ${port} is in use${owner ? ` by ${owner}` : ""}, using ${candidate} instead` };
  }
  const owner = portOwner(port);
  throw new Error(`Cannot listen on ${host ?? "*"}:${port}: port is in use${owner ? ` by ${owner}` : ""} and no free port was found after it`);
}

/** Best-effort "command (pid N)" of the process listening on a TCP port. */
export function portOwner(port: number): string | null {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = /^p(\d+)/m.exec(output)?.[1];
    const command = /^c(.+)$/m.exec(output)?.[1];
    return pid ? `${command ?? "process"} (pid ${pid})` : null;
  } catch {
    return null;
  }
}

/**
 * Stop accepting connections but let in-flight requests finish. Their connections are closed afterwards, since
 * Node otherwise keeps serving keep-alive connections of a closed server with its old request handler.
 */
export function drainServer(server: Server): void {
  server.close();
  server.closeIdleConnections();
  server.on("request", (_req, res: ServerResponse) => closeAfterResponse(res));
  for (const res of inFlight.get(server) ?? []) closeAfterResponse(res);
}

function closeAfterResponse(res: ServerResponse): void {
  if (!res.headersSent) res.shouldKeepAlive = false;
  res.once("finish", () => res.socket?.end());
}

function trackInFlight(server: Server): void {
  if (inFlight.has(server)) return;
  const active = new Set<ServerResponse>();
  inFlight.set(server, active);
  server.on("request", (_req, res: ServerResponse) => {
    active.add(res);
    res.once("close", () => active.delete(res));
  });
}

function listenOnce(server: Server, port: number, host: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (host) server.listen(port, host);
    else server.listen(port);
  });
}
