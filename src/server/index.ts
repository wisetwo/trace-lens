import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAgentBundle } from "./agent-bundle.js";
import { drainServer, listenWithFallback } from "./listen.js";
import { ConfigError } from "./proxy/config.js";
import { TraceStore, readTraceEntries, resolveTraceFile } from "./trace-reader.js";
import type { AgentTraceGraph, ProxyConfigSnapshot, TraceEntry } from "../shared/types.js";

export interface ProxyConfigApi {
  read: () => Promise<ProxyConfigSnapshot>;
  /** Validate, apply and persist a new config file text. Throws `ConfigError` for invalid contents. */
  save: (text: string) => Promise<ProxyConfigSnapshot>;
}

export interface ServerOptions {
  inputPath: string;
  port: number;
  basePath?: string;
  host?: string;
  /** "user:password" for HTTP Basic auth on every route. */
  auth?: string;
  /** Enables the proxy config editor (`/api/proxy/config`). */
  proxyConfig?: ProxyConfigApi;
}

export interface RunningServer {
  url: string;
  port: number;
  /** Set when the requested port was busy and another one was used. */
  warning?: string;
  /** `drain` lets in-flight requests finish instead of cutting them off. */
  stop: (options?: { drain?: boolean }) => Promise<void>;
}

export async function createServer(options: ServerOptions): Promise<RunningServer> {
  const resolvedInput = path.resolve(options.inputPath);
  const inputStat = await fs.promises.stat(resolvedInput).catch(() => null);
  const directory = inputStat?.isDirectory() ? resolvedInput : null;
  const fixedFile = directory ? null : await resolveTraceFile(resolvedInput);
  const stores = new Map<string, TraceStore>();

  // In directory mode the newest file is the default and `?file=<name>` selects another one.
  const storeFor = async (req: express.Request): Promise<TraceStore | null> => {
    let file = fixedFile;
    if (directory) {
      const requested = typeof req.query.file === "string" ? path.basename(req.query.file) : "";
      if (requested) {
        file = path.join(directory, requested);
        if (!/\.jsonl?$/.test(requested) || !(await fs.promises.stat(file).catch(() => null))?.isFile()) {
          throw new HttpError(404, `Trace file not found: ${requested}`);
        }
      } else {
        file = (await listTraceFiles(directory))[0]?.path ?? null;
      }
    }
    if (!file) return null;
    let store = stores.get(file);
    if (!store) {
      store = new TraceStore(file);
      stores.set(file, store);
    }
    return store;
  };
  const withStore = (handler: (store: TraceStore, req: express.Request, res: express.Response) => Promise<void>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        const store = await storeFor(req);
        if (!store) {
          res.status(404).json({ error: "No trace files yet" });
          return;
        }
        await handler(store, req, res);
      } catch (error) {
        res.status(error instanceof HttpError ? error.status : 500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    };

  const app = express();
  if (options.auth) {
    const expected = Buffer.from(`Basic ${Buffer.from(options.auth).toString("base64")}`);
    app.use((req, res, next) => {
      const given = Buffer.from(req.headers.authorization ?? "");
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
        next();
        return;
      }
      res.set("WWW-Authenticate", 'Basic realm="trace-lens"').status(401).send("Authentication required");
    });
  }
  const basePath = options.basePath ?? "";
  // Normalise: strip trailing slash, ensure leading slash (unless empty).
  const normalizedBase = basePath.replace(/\/+$/, "");
  const routePrefix = normalizedBase === "" ? "" : normalizedBase.startsWith("/") ? normalizedBase : `/${normalizedBase}`;

  const summaries = new Map<string, { version: string; summary: TraceFileSummary }>();
  const summarize = async (file: TraceFileInfo): Promise<TraceFileSummary> => {
    const version = `${file.mtimeMs}:${file.size}`;
    const cached = summaries.get(file.path);
    if (cached?.version === version) return cached.summary;
    const summary = summarizeEntries(await readTraceEntries(file.path));
    summaries.set(file.path, { version, summary });
    return summary;
  };

  app.get(`${routePrefix}/api/files`, async (_req, res) => {
    try {
      const files = directory ? await listTraceFiles(directory) : fixedFile ? await listFile(fixedFile) : [];
      const withSummary = await Promise.all(files.map(async (file) => ({
        name: file.name,
        mtimeMs: file.mtimeMs,
        size: file.size,
        ...(await summarize(file).catch(() => ({}))),
      })));
      res.json({ directory: Boolean(directory), files: withSummary });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get(`${routePrefix}/api/graph`, async (req, res) => {
    try {
      const store = await storeFor(req);
      res.json(store ? await store.getGraph() : emptyGraph());
    } catch (error) {
      res.status(error instanceof HttpError ? error.status : 500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  const parseSeq = (req: express.Request): number => {
    const seq = Number.parseInt(req.params.seq, 10);
    if (!Number.isFinite(seq)) throw new HttpError(400, "Invalid seq");
    return seq;
  };

  app.get(`${routePrefix}/api/entry/:seq`, withStore(async (store, req, res) => {
    const seq = parseSeq(req);
    const entry = await store.getEntry(seq);
    if (!entry) throw new HttpError(404, `Entry #${seq} not found`);
    res.json({ entry });
  }));

  // GET as well as POST: the harness proxy in front of this server only forwards GET.
  const organizeEntry = withStore(async (store, req, res) => {
    const seq = parseSeq(req);
    const entry = await store.getEntry(seq);
    if (!entry) throw new HttpError(404, `Entry #${seq} not found`);
    res.json(await writeAgentBundle(store.getFilePath(), entry));
  });
  app.get(`${routePrefix}/api/entry/:seq/organize`, organizeEntry);
  app.post(`${routePrefix}/api/entry/:seq/organize`, organizeEntry);

  app.post(`${routePrefix}/api/reload`, (_req, res) => {
    for (const store of stores.values()) store.invalidate();
    res.json({ ok: true });
  });

  const proxyConfig = options.proxyConfig;
  if (proxyConfig) {
    // The config holds upstreams and injected credentials: refuse cross-site requests, and DNS rebinding when there is no auth.
    const guard: express.RequestHandler = (req, res, next) => {
      const origin = req.headers.origin;
      if ((origin && origin !== `${req.protocol}://${req.headers.host}`) || (!options.auth && !isLoopbackHost(req.hostname))) {
        res.status(403).json({ error: "Config editing is only allowed from the viewer itself" });
        return;
      }
      next();
    };
    const respond = async (res: express.Response, action: () => Promise<ProxyConfigSnapshot>) => {
      try {
        res.json(await action());
      } catch (error) {
        res.status(error instanceof ConfigError ? 400 : 500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    };
    app.get(`${routePrefix}/api/proxy/config`, guard, (_req, res) => void respond(res, proxyConfig.read));
    app.put(`${routePrefix}/api/proxy/config`, guard, express.json({ limit: "1mb" }), (req, res) => {
      const text = (req.body as { text?: unknown } | undefined)?.text;
      if (typeof text !== "string") {
        res.status(400).json({ error: 'Expected a JSON body {"text": "<config file contents>"}' });
        return;
      }
      void respond(res, () => proxyConfig.save(text));
    });
  }

  app.all(`${routePrefix}/api/*`, (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const currentFile = fileURLToPath(import.meta.url);
  const serverDir = path.dirname(currentFile);
  const clientDir = path.resolve(serverDir, "../client");

  // Read per request: a long-running daemon must pick up rebuilt, re-hashed UI assets.
  const indexHtmlPath = path.join(clientDir, "index.html");

  app.use(routePrefix || "/", express.static(clientDir, { index: false }));

  // SPA fallback – serve index.html with injected base-path globals.
  app.get("*", (_req, res) => {
    let indexHtmlTemplate: string | null = null;
    try {
      indexHtmlTemplate = fs.readFileSync(indexHtmlPath, "utf-8");
    } catch {
      // UI bundle not built yet – will fall back to error page below.
    }
    if (!indexHtmlTemplate) {
      res.status(200).send(`
        <h1>Trace Lens</h1>
        <p>UI bundle not found. Run <code>npm run build</code> first.</p>
        <p>Trace ${directory ? "directory" : "file"}: <code>${path.basename(directory ?? fixedFile ?? "")}</code></p>
        <p>Graph API: <a href="${routePrefix}/api/graph">${routePrefix}/api/graph</a></p>
      `);
      return;
    }

    const baseTag = basePath ? `<base href="${basePath}">` : "";
    const globalScript = basePath
      ? `<script>window.__TRACE_LENS_BASE__ = ${JSON.stringify(basePath.replace(/\/$/, ""))}</script>`
      : "";
    const html = indexHtmlTemplate
      .replace("<head>", `<head>${baseTag}`)
      .replace(/<script/, `${globalScript}<script`);

    res.type("html").send(html);
  });

  const listener = http.createServer(app);
  const { port: actualPort, warning } = await listenWithFallback(listener, options.port, options.host);

  const displayHost = !options.host
    ? "localhost"
    : options.host === "0.0.0.0" || options.host === "::"
      ? externalIPv4() ?? "localhost"
      : options.host;
  return {
    url: `http://${displayHost}:${actualPort}`,
    port: actualPort,
    warning,
    stop: ({ drain = false } = {}) => new Promise((resolve, reject) => {
      if (drain) {
        drainServer(listener);
        resolve();
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve()));
      listener.closeAllConnections();
    }),
  };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

function externalIPv4(): string | undefined {
  for (const addresses of Object.values(os.networkInterfaces())) {
    const found = addresses?.find((address) => address.family === "IPv4" && !address.internal);
    if (found) return found.address;
  }
  return undefined;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface TraceFileInfo {
  name: string;
  path: string;
  mtimeMs: number;
  size: number;
}

async function listFile(file: string): Promise<TraceFileInfo[]> {
  const stat = await fs.promises.stat(file);
  return [{ name: path.basename(file), path: file, mtimeMs: stat.mtimeMs, size: stat.size }];
}

async function listTraceFiles(directory: string): Promise<TraceFileInfo[]> {
  const names = await fs.promises.readdir(directory).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => {
        const file = path.join(directory, name);
        const stat = await fs.promises.stat(file).catch(() => null);
        return stat?.isFile() ? { name, path: file, mtimeMs: stat.mtimeMs, size: stat.size } : null;
      }),
  );
  return files
    .filter((file): file is TraceFileInfo => file !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

interface TraceFileSummary {
  title?: string;
  lastUser?: string;
  userTurns: number;
  entries: number;
  messages: number;
  agents: number;
  models: string[];
  errors: number;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : typeof part === "string" ? part : ""))
    .join("\n");
}

/**
 * Harnesses inject context as user-role messages: `<tag ...>` blocks, `[Directive · ...]` headers,
 * or `═══`-framed sections. Those make poor session titles.
 */
const INJECTED_USER_TEXT = /^(<[a-zA-Z_][\w:-]*[\s>/]|\[[^\]\n]{2,80}\]\s*$|\[[^\]\n]{2,80}\]\s*\n|[═=─━-]{5,})/;

const LEADING_TAG_BLOCK = /^\s*<([a-zA-Z_][\w:-]*)[^>]*>[\s\S]*?<\/\1>\s*/;

/** The human-typed part of one text chunk, or "" when it is only injected context. */
function typedText(text: string): string {
  let rest = text;
  for (let match = LEADING_TAG_BLOCK.exec(rest); match; match = LEADING_TAG_BLOCK.exec(rest)) rest = rest.slice(match[0].length);
  rest = rest.trim();
  return rest && !INJECTED_USER_TEXT.test(rest) ? rest : "";
}

/** Human-typed user messages of an entry; injected context is dropped part by part. */
function userTexts(entry: TraceEntry): string[] {
  return (entry.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => {
      const parts = Array.isArray(message.content) ? message.content.map((part) => messageText([part])) : [messageText(message.content)];
      return parts.map(typedText).filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .map((text) => text.replace(/\s+/g, " "));
}

function summarizeEntries(entries: TraceEntry[]): TraceFileSummary {
  const mainAgent = entries.find((entry) => entry.agentRole === "lead")?.agentId ?? entries[0]?.agentId;
  const mainEntries = entries.filter((entry) => entry.agentId === mainAgent);
  const last = mainEntries.at(-1) ?? entries.at(-1);
  const users = last ? userTexts(last) : [];
  const clip = (text: string | undefined) => (text && text.length > 120 ? `${text.slice(0, 120)}…` : text);
  const fallbackTitle = () => {
    const first = (last?.messages ?? []).find((message) => message.role === "user" && !messageText(message.content).startsWith("<system-reminder>"));
    const line = messageText(first?.content)
      .split("\n")
      .map((text) => text.replace(/^[\s#>*═=─━\-[\]]+/, "").trim())
      .find((text) => /[\p{L}\p{N}]/u.test(text) && !text.startsWith("<"));
    return line ? `(context) ${line}` : undefined;
  };
  return {
    title: clip(users[0] ?? fallbackTitle()),
    lastUser: users.length > 1 ? clip(users.at(-1)) : undefined,
    userTurns: users.length,
    entries: entries.length,
    messages: Math.max(0, ...entries.map((entry) => entry.messageCount ?? entry.messages?.length ?? 0)),
    agents: new Set(entries.map((entry) => entry.agentId ?? entry.sessionKey ?? "unknown")).size,
    models: [...new Set(entries.map((entry) => entry.modelId).filter((model): model is string => Boolean(model)))],
    errors: entries.filter((entry) => entry.error).length,
  };
}

function emptyGraph(): AgentTraceGraph {
  return { file: "(no traces yet)", totalEntries: 0, totalNodes: 0, agents: [], nodes: [], edges: [] };
}