import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "../index.js";
import { loadConfig, traceLensHome } from "./config.js";
import { startProxy } from "./proxy-server.js";

export interface DaemonState {
  pid: number;
  configPath: string;
  startedAt: string;
  dataDir: string;
  logFile: string;
  listeners: { name: string; url: string }[];
  ui: string | null;
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

  const config = await loadConfig(configPath);
  await fs.mkdir(config.dataDir, { recursive: true });
  const log = (line: string) => console.log(line);

  const proxy = await startProxy(config, log);
  let ui: Awaited<ReturnType<typeof createServer>> | null = null;
  try {
    if (config.ui.enabled) {
      ui = await createServer({ inputPath: config.dataDir, port: config.ui.port, host: config.ui.host ?? config.host, auth: config.ui.auth });
    }
  } catch (error) {
    await proxy.stop();
    throw error;
  }

  const state: DaemonState = {
    pid: process.pid,
    configPath,
    startedAt: new Date().toISOString(),
    dataDir: config.dataDir,
    logFile: process.stdout.isTTY ? "(stdout)" : logPath(),
    listeners: proxy.listeners,
    ui: ui?.url ?? null,
  };
  await fs.mkdir(traceLensHome(), { recursive: true });
  await fs.writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");

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
  log(`  endpoints (use as base URL):`);
  for (const listener of state.listeners) log(`    ${listener.name.padEnd(12)} ${listener.url}`);
}
