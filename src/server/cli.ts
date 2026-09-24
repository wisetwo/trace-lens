import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import open from "open";
import { createServer } from "./index.js";
import { defaultConfigPath, loadConfig, writeDefaultConfig } from "./proxy/config.js";
import { logPath, printState, readState, runProxy, startDaemon, stopDaemon, tailLog } from "./proxy/daemon.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

const program = new Command();

program
  .name("trace-lens")
  .description("View multi-agent LLM JSONL traces as an interactive graph")
  .version(version, "-v, --version", "Print version number")
  .argument("<path>", "Path to a trace JSONL file or a directory containing JSONL files")
  .option("-p, --port <port>", "Port to listen on", "3117")
  .option("--no-open", "Do not open the browser automatically")
  .option("--base-path <path>", "Base path for the UI and API (e.g. /proxy/session-123/)", "")
  .action(async (inputPath: string, options: { port: string; open: boolean; basePath: string }) => {
    const port = Number.parseInt(options.port, 10);
    if (!Number.isFinite(port)) {
      console.error(`Invalid port: ${options.port}`);
      process.exit(1);
    }

    let basePath = options.basePath.trim();
    if (basePath && !basePath.startsWith("/")) basePath = `/${basePath}`;
    if (basePath && !basePath.endsWith("/")) basePath = `${basePath}/`;

    try {
      const server = await createServer({ inputPath, port, basePath });
      console.log(`Trace Lens: ${server.url}`);
      console.log(`Press Ctrl+C to stop.`);
      if (options.open) await open(server.url);

      const shutdown = async () => {
        await server.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

const proxy = program
  .command("proxy")
  .description("Capture LLM API traffic through a local reverse proxy and view it as traces");

const configOption = (command: Command) =>
  command.option("-c, --config <file>", "Proxy config file", defaultConfigPath());

const fail = (error: unknown): never => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
};

const cliEntry = fileURLToPath(import.meta.url);

configOption(proxy.command("init"))
  .description("Create a default config file")
  .action(async (options: { config: string }) => {
    const file = path.resolve(options.config);
    const created = await writeDefaultConfig(file).catch(fail);
    console.log(created ? `Created ${file}` : `Config already exists: ${file}`);
  });

configOption(proxy.command("run"))
  .description("Run the proxy in the foreground")
  .action(async (options: { config: string }) => {
    const file = path.resolve(options.config);
    await writeDefaultConfig(file);
    await runProxy(file).catch(fail);
  });

configOption(proxy.command("start"))
  .description("Start the proxy as a background service")
  .action(async (options: { config: string }) => {
    const file = path.resolve(options.config);
    try {
      if (await writeDefaultConfig(file)) console.log(`Created default config ${file}`);
      const running = await readState();
      if (running) {
        console.log("trace-lens proxy is already running:");
        printState(running);
        return;
      }
      const state = await startDaemon(file, cliEntry);
      console.log("trace-lens proxy started:");
      printState(state);
    } catch (error) {
      fail(error);
    }
  });

proxy
  .command("stop")
  .description("Stop the background proxy")
  .action(async () => {
    const state = await stopDaemon().catch(fail);
    console.log(state ? `trace-lens proxy stopped (pid ${state.pid})` : "trace-lens proxy is not running");
  });

configOption(proxy.command("restart"))
  .description("Restart the background proxy (reloads the config)")
  .action(async (options: { config: string }) => {
    try {
      const previous = await stopDaemon();
      const file = path.resolve(previous?.configPath ?? options.config);
      await loadConfig(file);
      const state = await startDaemon(file, cliEntry);
      console.log("trace-lens proxy restarted:");
      printState(state);
    } catch (error) {
      fail(error);
    }
  });

proxy
  .command("status")
  .description("Show whether the background proxy is running")
  .action(async () => {
    const state = await readState();
    if (!state) {
      console.log("trace-lens proxy is not running");
      process.exitCode = 1;
      return;
    }
    console.log(`trace-lens proxy is running since ${state.startedAt}:`);
    printState(state);
  });

proxy
  .command("log")
  .description("Print the tail of the background proxy log")
  .option("-n, --lines <n>", "Number of lines", "50")
  .action(async (options: { lines: string }) => {
    console.log(`# ${logPath()}`);
    console.log(await tailLog(Number.parseInt(options.lines, 10) || 50));
  });

program.parse();
