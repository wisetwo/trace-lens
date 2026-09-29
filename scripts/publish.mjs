import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishArgs = process.argv.slice(2);

const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;

const dirty = (await capture("git", ["status", "--porcelain"])).trim();
const onlyPublishScript = dirty.split("\n").filter(Boolean).every((line) => line.endsWith("scripts/publish.mjs"));
if (dirty && !onlyPublishScript) {
  throw new Error("Working tree is not clean. Publish the tagged commit, not a dirty tree.");
}

const head = (await capture("git", ["rev-parse", "HEAD"])).trim();
let tagged;
try {
  tagged = (await capture("git", ["rev-parse", `${tag}^{}`])).trim();
} catch {
  throw new Error(`Tag ${tag} does not exist. Run npm run release before publishing.`);
}
if (head !== tagged) {
  throw new Error(`HEAD is not ${tag}. Publish does not bump the version; check out ${tag} or run npm run release first.`);
}

const npmPublishArgs = ["publish", ...publishArgs];
const hasAccessArg = publishArgs.includes("--access") || publishArgs.some((arg) => arg.startsWith("--access="));
const usesCustomRegistry = Boolean(packageJson.publishConfig?.registry) || publishArgs.some((arg) => arg === "--registry" || arg.startsWith("--registry="));
if (!hasAccessArg && !packageJson.publishConfig?.access && !usesCustomRegistry) {
  npmPublishArgs.splice(1, 0, "--access", "public");
}

console.log(`Publishing ${packageJson.name}@${version} (${tag}), version unchanged.`);
await run("npm", npmPublishArgs);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: rootDir, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: rootDir, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
