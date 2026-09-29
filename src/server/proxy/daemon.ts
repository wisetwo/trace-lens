import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProxyConfigSnapshot } from "../../shared/types.js";
import { createServer, type ProxyConfigApi, type RunningServer } from "../index.js";
import { loadConfig, parseConfig, traceLensHome, type ProxyConfig } from "./config.js";
import { startProxy, type RunningProxy } from "./proxy-server.js";

export interface DaemonState {
  pid: number;
  configPath: string;
  startedAt: string;
  dataDir: string;
  logFile: string;
  listeners: { name: string; url: string }[];
  ui: string | null;
  /** Viewer page for editing the config, when editing is allowed. */
  configEditor?: string | null;
  /** E.g. listeners that moved off a busy port. */
  warnings?: string[];
}

export function statePath(): string {
  return path.join(traceLensHome(), "proxy.state.json");
}

export function logPath(): string {
  return path.join(traceLensHome(), "proxy.log");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readState(): Promise<DaemonState | null> {
  const text = await fs.readFile(statePath(), "utf8").catch(() => null);
  if (!text) return null;
  try {
    const state = JSON.parse(text) as DaemonState;
    if (isAlive(state.pid)) return state;
  } catch {
    // Corrupt state file: treat as stopped.
  }
  await fs.rm(statePath(), { force: true });
  return null;
}

/** Run the proxy (and UI) in the current process until SIGINT/SIGTERM. */
export async function runProxy(configPath: string): Promise<void> {
  const existing = await readState();
  if (existing && existing.pid !== process.pid) {
    throw new Error(`trace-lens proxy is already running (pid ${existing.pid}). Use \`trace-lens proxy stop\` first.`);
  }

  let config = await loadConfig(configPath);
  await fs.mkdir(config.dataDir, { recursive: true });
  const log = (line: string) => console.log(line);
  const startedAt = new Date().toISOString();

  let ui: RunningServer | null = null;
  const proxyOptions = { log, uiUrl: () => ui?.url ?? null };
  let proxy: RunningProxy = await startProxy(config, proxyOptions);

  const warnings = () => [...proxy.warnings, ...(ui?.warning ? [`ui: ${ui.warning}`] : [])];
  const snapshot = async (): Promise<ProxyConfigSnapshot> => ({
    path: configPath,
    text: await fs.readFile(configPath, "utf8"),
    listeners: proxy.listeners,
    ui: ui?.url ?? null,
    warnings: warnings(),
  });

  let saving: Promise<unknown> = Promise.resolve();
  const configApi: ProxyConfigApi = {
    read: snapshot,
    save: (text) => {
      const run = saving.then(async () => {
        const { raw, config: next } = parseConfig(text, configPath);
        await fs.mkdir(next.dataDir, { recursive: true });
        await reload(next);
        await fs.writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
        log(`config saved from the viewer and applied`);
        printState(await writeState(), log);
        return snapshot();
      });
      saving = run.catch(() => undefined);
      return run;
    },
  };

  const startUi = async (cfg: ProxyConfig): Promise<RunningServer | null> => {
    if (!cfg.ui.enabled) return null;
    const server = await createServer({
      inputPath: cfg.dataDir,
      port: cfg.ui.port,
      host: cfg.ui.host ?? cfg.host,
      auth: cfg.ui.auth,
      proxyConfig: configEditable(cfg) ? configApi : undefined,
    });
    return server;
  };

  const writeState = async () => {
    const state: DaemonState = {
      pid: process.pid,
      configPath,
      startedAt,
      dataDir: config.dataDir,
      logFile: process.stdout.isTTY ? "(stdout)" : logPath(),
      listeners: proxy.listeners,
      ui: ui?.url ?? null,
      configEditor: ui && configEditable(config) ? `${ui.url}/#config` : null,
      warnings: warnings(),
    };
    await fs.mkdir(traceLensHome(), { recursive: true });
    await fs.writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return state;
  };

  /** Swap listeners to `next`; in-flight requests finish on the old ones. Restores the previous config on failure. */
  const reload = async (next: ProxyConfig) => {
    const previous = { config, proxy, ui };
    const restartUi = uiKey(next) !== uiKey(config);
    const sameCaptures = next.dataDir === config.dataDir && next.sessionIdleMinutes === config.sessionIdleMinutes;
    await proxy.stop({ drain: true });
    if (restartUi) await ui?.stop({ drain: true });
    let started: RunningProxy | null = null;
    try {
      started = await startProxy(next, { ...proxyOptions, correlator: sameCaptures ? previous.proxy.correlator : undefined });
      proxy = started;
      if (restartUi) ui = await startUi(next);
      config = next;
    } catch (error) {
      await started?.stop();
      proxy = await startProxy(previous.config, { ...proxyOptions, correlator: previous.proxy.correlator });
      ui = restartUi ? await startUi(previous.config) : previous.ui;
      throw error;
    } finally {
      await writeState();
    }
  };

  try {
    ui = await startUi(config);
  } catch (error) {
    await proxy.stop();
    throw error;
  }
  const state = await writeState();

  log(`trace-lens proxy started (pid ${process.pid}), config ${configPath}`);
  printState(state, log);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, shutting down`);
    await Promise.allSettled([proxy.stop(), ui?.stop()]);
    removeOwnState();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("exit", removeOwnState);
}

/** The editor can redirect traffic and inject credentials, so it needs a loopback-only viewer or auth. */
function configEditable(config: ProxyConfig): boolean {
  const host = config.ui.host ?? config.host;
  return Boolean(config.ui.auth) || host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Settings that require restarting the viewer server. */
function uiKey(config: ProxyConfig): string {
  return JSON.stringify([config.dataDir, config.host, config.ui.enabled, config.ui.port, config.ui.host, config.ui.auth]);
}

function removeOwnState(): void {
  try {
    const state = JSON.parse(fsSync.readFileSync(statePath(), "utf8")) as DaemonState;
    if (state.pid === process.pid) fsSync.rmSync(statePath(), { force: true });
  } catch {
    // Nothing to clean up.
  }
}

/** Spawn `trace-lens proxy run` as a detached background process. */
export async function startDaemon(configPath: string, cliEntry: string): Promise<DaemonState> {
  const existing = await readState();
  if (existing) return existing;

  await loadConfig(configPath);
  await fs.mkdir(traceLensHome(), { recursive: true });
  const logFd = fsSync.openSync(logPath(), "a");
  const child = spawn(process.execPath, [cliEntry, "proxy", "run", "--config", configPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  fsSync.closeSync(logFd);
  child.unref();

  let exitCode: number | null = null;
  child.once("exit", (code) => {
    exitCode = code ?? 1;
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (exitCode !== null) break;
    const state = await readState();
    if (state && state.pid === child.pid) return state;
  }
  const tail = await tailLog(20);
  throw new Error(`trace-lens proxy failed to start${exitCode !== null ? ` (exit code ${exitCode})` : ""}. Log ${logPath()}:\n${tail}`);
}

export async function stopDaemon(): Promise<DaemonState | null> {
  const state = await readState();
  if (!state) return null;
  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isAlive(state.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isAlive(state.pid)) process.kill(state.pid, "SIGKILL");
  await fs.rm(statePath(), { force: true });
  return state;
}

export async function tailLog(lines: number): Promise<string> {
  const text = await fs.readFile(logPath(), "utf8").catch(() => "");
  return text.split("\n").slice(-lines - 1).join("\n");
}

export function printState(state: DaemonState, log: (line: string) => void = console.log): void {
  log(`  pid:      ${state.pid}`);
  log(`  config:   ${state.configPath}`);
  log(`  captures: ${state.dataDir}`);
  log(`  log:      ${state.logFile}`);
  if (state.ui) log(`  ui:       ${state.ui}`);
  if (state.configEditor) log(`  edit config: ${state.configEditor}`);
  log(`  endpoints (use as base URL):`);
  for (const listener of state.listeners) log(`    ${listener.name.padEnd(12)} ${listener.url}`);
  for (const warning of state.warnings ?? []) log(`  warning: ${warning}`);
}
