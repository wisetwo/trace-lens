import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WireFormat } from "./normalize.js";

export interface EndpointConfig {
  /** Route name; served at `http://<host>:<port>/<name>/...` on the shared port. */
  name: string;
  /** Upstream base URL, e.g. `https://api.openai.com`. The path after `/<name>` is appended to it. */
  upstream: string;
  /** Optional dedicated port, served without the `/<name>` prefix. */
  port?: number;
  /** Force a wire format instead of detecting it from the request path. */
  format?: WireFormat;
  /** Extra headers added to upstream requests (e.g. an API key the client does not send). */
  headers?: Record<string, string>;
}

export interface ProxyConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Conversations idle longer than this start a new trace file. */
  sessionIdleMinutes: number;
  /** `host` defaults to the proxy host; `auth` ("user:password") enables HTTP Basic auth. */
  ui: { enabled: boolean; port: number; host?: string; auth?: string };
  endpoints: EndpointConfig[];
}

export function traceLensHome(): string {
  return process.env.TRACE_LENS_HOME ? path.resolve(process.env.TRACE_LENS_HOME) : path.join(os.homedir(), ".trace-lens");
}

export function defaultConfigPath(): string {
  return path.join(traceLensHome(), "proxy.json");
}

export function defaultConfig(): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 8600,
    dataDir: path.join(traceLensHome(), "captures"),
    sessionIdleMinutes: 30,
    ui: { enabled: true, port: 3117 },
    endpoints: [
      { name: "openai", upstream: "https://api.openai.com" },
      { name: "anthropic", upstream: "https://api.anthropic.com" },
    ],
  };
}

const FORMATS: WireFormat[] = ["openai-chat", "openai-responses", "anthropic-messages"];

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

export async function loadConfig(configPath: string): Promise<ProxyConfig> {
  const text = await fs.readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Config not found: ${configPath}\nRun \`trace-lens proxy init\` to create one.`);
    throw error;
  });
  let raw: Partial<ProxyConfig>;
  try {
    raw = JSON.parse(text) as Partial<ProxyConfig>;
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateConfig(raw, path.dirname(configPath));
}

export function validateConfig(raw: Partial<ProxyConfig>, baseDir: string): ProxyConfig {
  const defaults = defaultConfig();
  const config: ProxyConfig = {
    host: raw.host ?? defaults.host,
    port: raw.port ?? defaults.port,
    dataDir: path.resolve(baseDir, expandHome(raw.dataDir ?? defaults.dataDir)),
    sessionIdleMinutes: raw.sessionIdleMinutes ?? defaults.sessionIdleMinutes,
    ui: { ...defaults.ui, ...(raw.ui ?? {}) },
    endpoints: raw.endpoints ?? [],
  };

  const errors: string[] = [];
  const checkPort = (value: unknown, label: string) => {
    if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > 65535) errors.push(`${label} must be a valid port`);
  };
  checkPort(config.port, "port");
  if (config.ui.enabled) checkPort(config.ui.port, "ui.port");
  if (!Array.isArray(config.endpoints) || config.endpoints.length === 0) errors.push("endpoints must be a non-empty array");

  const names = new Set<string>();
  const ports = new Set<number>([config.port, ...(config.ui.enabled ? [config.ui.port] : [])]);
  if (config.ui.enabled && config.ui.port === config.port) errors.push("ui.port must differ from port");
  if (config.ui.host !== undefined && (typeof config.ui.host !== "string" || !config.ui.host)) errors.push("ui.host must be a non-empty string");
  if (config.ui.auth !== undefined && (typeof config.ui.auth !== "string" || !/^[^:]+:.+$/.test(config.ui.auth))) {
    errors.push('ui.auth must look like "user:password"');
  }
  for (const [i, endpoint] of (Array.isArray(config.endpoints) ? config.endpoints : []).entries()) {
    const label = `endpoints[${i}]`;
    if (!endpoint || typeof endpoint.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(endpoint.name)) {
      errors.push(`${label}.name must match [a-zA-Z0-9_-]+`);
    } else if (names.has(endpoint.name)) {
      errors.push(`${label}.name "${endpoint.name}" is duplicated`);
    } else {
      names.add(endpoint.name);
    }
    try {
      const url = new URL(endpoint?.upstream);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      errors.push(`${label}.upstream must be an http(s) URL`);
    }
    if (endpoint?.port !== undefined) {
      checkPort(endpoint.port, `${label}.port`);
      if (ports.has(endpoint.port)) errors.push(`${label}.port ${endpoint.port} is already in use by another listener`);
      ports.add(endpoint.port);
    }
    if (endpoint?.format !== undefined && !FORMATS.includes(endpoint.format)) {
      errors.push(`${label}.format must be one of ${FORMATS.join(", ")}`);
    }
  }
  if (errors.length) throw new Error(`Invalid proxy config:\n  - ${errors.join("\n  - ")}`);
  return config;
}

export async function writeDefaultConfig(configPath: string): Promise<boolean> {
  const exists = await fs.stat(configPath).then(() => true, () => false);
  if (exists) return false;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const config = defaultConfig();
  await fs.writeFile(configPath, `${JSON.stringify({ ...config, dataDir: "./captures" }, null, 2)}\n`, "utf8");
  return true;
}
