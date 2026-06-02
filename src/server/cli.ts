import { Command } from "commander";
import open from "open";
import { createServer } from "./index.js";

const program = new Command();

program
  .name("trace-lens")
  .description("View multi-agent LLM JSONL traces as an interactive graph")
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

program.parse();
