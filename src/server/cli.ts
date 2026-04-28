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
  .action(async (inputPath: string, options: { port: string; open: boolean }) => {
    const port = Number.parseInt(options.port, 10);
    if (!Number.isFinite(port)) {
      console.error(`Invalid port: ${options.port}`);
      process.exit(1);
    }

    try {
      const server = await createServer({ inputPath, port });
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
