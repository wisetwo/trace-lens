import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const nameArgument = process.argv.slice(2).find((argument) => argument.startsWith("--n="));
const traceName = nameArgument?.slice("--n=".length).trim();
if (!traceName) {
  console.error("Usage: npm run dev:sample -- --n=<trace-name>");
  process.exit(1);
}

if (traceName === "." || traceName === ".." || path.basename(traceName) !== traceName) {
  console.error("Trace name must be a file name without a directory path.");
  process.exit(1);
}

const traceFile = traceName.endsWith(".json") ? traceName : `${traceName}.json`;
const tracePath = path.resolve("temp", traceFile);
if (!existsSync(tracePath)) {
  console.error(`Trace file not found: ${path.relative(process.cwd(), tracePath)}`);
  process.exit(1);
}

const apiPort = process.env.TRACE_LENS_API_PORT || "4117";
const childEnv = { ...process.env, TRACE_LENS_API_PORT: apiPort };
const children = [
  spawn(process.execPath, ["./dist/server/cli.js", tracePath, "--port", apiPort, "--no-open"], {
    env: childEnv,
    stdio: "inherit",
  }),
  spawn("npm", ["run", "dev"], {
    env: childEnv,
    stdio: "inherit",
  }),
];

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) stop(signal ? 1 : (code ?? 0));
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
