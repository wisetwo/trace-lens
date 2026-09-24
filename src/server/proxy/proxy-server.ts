import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { EndpointConfig, ProxyConfig } from "./config.js";
import { Correlator, HEADER_PREFIX } from "./correlate.js";
import { detectFormat, normalizeCall, type WireFormat } from "./normalize.js";

export interface RunningProxy {
  listeners: { name: string; url: string }[];
  stop: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const STREAM_DONE = /data: ?\[DONE\]|"type": ?"(message_stop|response\.completed|response\.incomplete|response\.failed)"/;

export async function startProxy(config: ProxyConfig, log: (line: string) => void = console.log): Promise<RunningProxy> {
  const correlator = new Correlator({ dataDir: config.dataDir, idleMs: config.sessionIdleMinutes * 60_000 });
  const byName = new Map(config.endpoints.map((endpoint) => [endpoint.name, endpoint]));
  const servers: { name: string; server: http.Server; port: number }[] = [];

  const shared = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const [, first = "", ...rest] = url.pathname.split("/");
    const endpoint = byName.get(first);
    if (!endpoint) {
      const body = {
        service: "trace-lens proxy",
        endpoints: config.endpoints.map((e) => ({ name: e.name, baseUrl: `http://${displayHost(config.host)}:${config.port}/${e.name}`, upstream: e.upstream })),
        ui: config.ui.enabled ? `http://${displayHost(config.host)}:${config.ui.port}` : null,
      };
      res.writeHead(url.pathname === "/" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    forward(endpoint, `/${rest.join("/")}${url.search}`, req, res, correlator, log);
  });
  servers.push({ name: "*", server: shared, port: config.port });

  for (const endpoint of config.endpoints) {
    if (endpoint.port === undefined) continue;
    const server = http.createServer((req, res) => forward(endpoint, req.url ?? "/", req, res, correlator, log));
    servers.push({ name: endpoint.name, server, port: endpoint.port });
  }

  const started: typeof servers = [];
  try {
    for (const entry of servers) {
      await listen(entry.server, entry.port, config.host);
      started.push(entry);
    }
  } catch (error) {
    await Promise.all(started.map((entry) => close(entry.server)));
    throw error;
  }

  const host = displayHost(config.host);
  return {
    listeners: [
      ...config.endpoints.map((e) => ({ name: e.name, url: `http://${host}:${config.port}/${e.name}` })),
      ...config.endpoints.filter((e) => e.port !== undefined).map((e) => ({ name: e.name, url: `http://${host}:${e.port}` })),
    ],
    stop: async () => {
      await Promise.all(servers.map((entry) => close(entry.server)));
    },
  };
}

function forward(
  endpoint: EndpointConfig,
  pathAndQuery: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  correlator: Correlator,
  log: (line: string) => void,
): void {
  const startedAt = new Date();
  const upstreamBase = new URL(endpoint.upstream);
  const target = new URL(upstreamBase.toString());
  const [pathname, search = ""] = splitQuery(pathAndQuery);
  target.pathname = `${upstreamBase.pathname.replace(/\/+$/, "")}${pathname}`;
  target.search = search;

  const hints: Record<string, string> = {};
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    if (key.startsWith(HEADER_PREFIX)) {
      hints[key] = Array.isArray(value) ? value[0] : value;
      continue;
    }
    headers[key] = value;
  }
  headers.host = target.host;
  for (const [key, value] of Object.entries(endpoint.headers ?? {})) headers[key.toLowerCase()] = value;

  const format: WireFormat | null = req.method === "POST" ? endpoint.format ?? detectFormat(target.pathname) : null;
  const capture = format !== null && !target.pathname.endsWith("/count_tokens");
  const reqChunks: Buffer[] = [];
  const resChunks: Buffer[] = [];
  let reqBytes = 0;
  let resBytes = 0;
  let status = 0;
  let resEncoding: string | undefined;
  let recorded = false;

  const record = (error?: string) => {
    if (!capture || recorded) return;
    recorded = true;
    const durationMs = Date.now() - startedAt.getTime();
    void (async () => {
      let requestBody: unknown = null;
      try {
        requestBody = JSON.parse(Buffer.concat(reqChunks).toString("utf8"));
      } catch {
        return;
      }
      const responseText = decode(Buffer.concat(resChunks), resEncoding);
      const call = normalizeCall(format!, requestBody, status || 502, responseText);
      if (error) call.error = call.error ? `${error}; ${call.error}` : error;
      const entry = await correlator.record(call, {
        endpoint: endpoint.name,
        method: req.method ?? "POST",
        url: target.toString(),
        status,
        startedAt,
        durationMs,
        hints,
      });
      const correlation = (entry.capture as { correlation?: string }).correlation;
      log(`${startedAt.toISOString()} ${endpoint.name} ${req.method} ${target.pathname} ${status || "ERR"} ${durationMs}ms -> ${entry.sessionId} #${entry.seq} ${entry.agentId} (${correlation})`);
    })().catch((err: unknown) => log(`capture failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
  };

  const client = target.protocol === "https:" ? https : http;
  const upstreamReq = client.request(target, { method: req.method, headers }, (upstreamRes) => {
    status = upstreamRes.statusCode ?? 502;
    resEncoding = headerValue(upstreamRes.headers["content-encoding"]);
    const outHeaders: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(key)) outHeaders[key] = value;
    }
    res.writeHead(status, outHeaders);
    res.flushHeaders();
    upstreamRes.on("data", (chunk: Buffer) => {
      if (capture && resBytes < MAX_CAPTURE_BYTES) {
        resChunks.push(chunk);
        resBytes += chunk.length;
      }
      res.write(chunk);
    });
    upstreamRes.on("end", () => {
      res.end();
      record();
    });
    upstreamRes.on("error", (err) => {
      res.destroy(err);
      record(`upstream response error: ${err.message}`);
    });
  });

  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `trace-lens proxy: upstream request failed: ${err.message}` } }));
    } else {
      res.destroy(err);
    }
    record(`upstream request failed: ${err.message}`);
  });

  res.on("close", () => {
    if (res.writableFinished) return;
    upstreamReq.destroy();
    // SDKs often drop the connection right after the terminal SSE event, before the upstream ends the body.
    const tail = decode(Buffer.concat(resChunks), resEncoding).slice(-4096);
    record(status && STREAM_DONE.test(tail) ? undefined : "client aborted before the response completed");
  });

  req.on("data", (chunk: Buffer) => {
    if (capture && reqBytes < MAX_CAPTURE_BYTES) {
      reqChunks.push(chunk);
      reqBytes += chunk.length;
    }
    upstreamReq.write(chunk);
  });
  req.on("end", () => upstreamReq.end());
  req.on("error", () => upstreamReq.destroy());
}

function decode(buffer: Buffer, encoding: string | undefined): string {
  try {
    switch ((encoding ?? "").toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
      case "br":
        return zlib.brotliDecompressSync(buffer, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }).toString("utf8");
      case "deflate":
        return zlib.inflateSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString("utf8");
      default:
        return buffer.toString("utf8");
    }
  } catch {
    return buffer.toString("utf8");
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function splitQuery(value: string): [string, string] {
  const index = value.indexOf("?");
  return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index)];
}

function displayHost(host: string): string {
  return host === "0.0.0.0" || host === "::" ? "localhost" : host;
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(new Error(`Cannot listen on ${host}:${port}: ${error.message}`));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
