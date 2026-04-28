import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TraceStore, resolveTraceFile } from "./trace-reader.js";

export interface ServerOptions {
  inputPath: string;
  port: number;
}

export interface RunningServer {
  url: string;
  stop: () => Promise<void>;
}

export async function createServer(options: ServerOptions): Promise<RunningServer> {
  const filePath = await resolveTraceFile(options.inputPath);
  const store = new TraceStore(filePath);
  const app = express();

  app.get("/api/graph", async (_req, res) => {
    try {
      res.json(await store.getGraph());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/entry/:seq", async (req, res) => {
    const seq = Number.parseInt(req.params.seq, 10);
    if (!Number.isFinite(seq)) {
      res.status(400).json({ error: "Invalid seq" });
      return;
    }
    const entry = await store.getEntry(seq);
    if (!entry) {
      res.status(404).json({ error: `Entry #${seq} not found` });
      return;
    }
    res.json({ entry });
  });

  app.post("/api/reload", (_req, res) => {
    store.invalidate();
    res.json({ ok: true });
  });

  const currentFile = fileURLToPath(import.meta.url);
  const serverDir = path.dirname(currentFile);
  const clientDir = path.resolve(serverDir, "../client");
  app.use(express.static(clientDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"), (error) => {
      if (error) {
        res.status(200).send(`
          <h1>Trace Lens</h1>
          <p>UI bundle not found. Run <code>npm run build</code> first.</p>
          <p>Trace file: <code>${path.basename(filePath)}</code></p>
          <p>Graph API: <a href="/api/graph">/api/graph</a></p>
        `);
      }
    });
  });

  const listener = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(options.port, () => resolve(server));
  });

  const address = listener.address();
  const actualPort = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://localhost:${actualPort}`,
    stop: () => new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve()))),
  };
}
