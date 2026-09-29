import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const publish = args.includes("--publish");
const rest = args.filter((arg) => arg !== "--publish");
const bump = rest[0] && !rest[0].startsWith("-") ? rest[0] : "patch";
const publishArgs = rest[0] && !rest[0].startsWith("-") ? rest.slice(1) : rest;

const packagePath = path.join(rootDir, "package.json");
const lockPath = path.join(rootDir, "package-lock.json");

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const lockJson = JSON.parse(await readFile(lockPath, "utf8"));
const current = packageJson.version;
const next = nextVersion(current, bump);
const tag = `v${next}`;

const dirty = (await capture("git", ["status", "--porcelain"])).trim();
if (dirty) {
  throw new Error("Working tree is not clean. Commit or stash changes before releasing.");
}
const existing = (await capture("git", ["tag", "-l", tag])).trim();
if (existing === tag) {
  throw new Error(`Tag ${tag} already exists.`);
}

await updateVersion(next);
await run("git", ["add", "package.json", "package-lock.json"]);
try {
  await run("git", ["commit", "-m", `chore: release ${next}`]);
} catch (error) {
  await updateVersion(current);
  console.error(`Commit failed. Version rolled back to ${current}.`);
  throw error;
}
try {
  await run("git", ["tag", "-a", tag, "-m", tag]);
} catch (error) {
  console.error(`Committed ${next} but could not create ${tag}. Tag it with: git tag -a ${tag} -m ${tag}`);
  throw error;
}

console.log(`Released ${tag}. package.json and the tag are the shared version.`);
if (!publish) {
  console.log("Not published. Re-run with --publish, or run npm publish, when this build should go to the registry.");
  process.exit(0);
}

const npmPublishArgs = ["publish", ...publishArgs];
const hasAccessArg = publishArgs.includes("--access") || publishArgs.some((arg) => arg.startsWith("--access="));
const usesCustomRegistry = Boolean(packageJson.publishConfig?.registry) || publishArgs.some((arg) => arg === "--registry" || arg.startsWith("--registry="));
if (!hasAccessArg && !packageJson.publishConfig?.access && !usesCustomRegistry) {
  npmPublishArgs.splice(1, 0, "--access", "public");
}

try {
  await run("npm", npmPublishArgs);
} catch (error) {
  console.error(`Publish failed. ${tag} stays in git; retry with npm publish.`);
  throw error;
}

function nextVersion(current, bumpType) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(bumpType)) {
    return bumpType;
  }

  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) {
    throw new Error(`Unsupported current version: ${current}`);
  }

  const version = match.slice(1).map(Number);
  switch (bumpType) {
    case "major":
      version[0] += 1;
      version[1] = 0;
      version[2] = 0;
      break;
    case "minor":
      version[1] += 1;
      version[2] = 0;
      break;
    case "patch":
      version[2] += 1;
      break;
    default:
      throw new Error("Usage: npm run release -- [patch|minor|major|x.y.z] [--publish] [npm publish args...]");
  }

  return version.join(".");
}

async function updateVersion(version) {
  packageJson.version = version;
  if (lockJson.version !== undefined) lockJson.version = version;
  if (lockJson.packages?.[""]?.version !== undefined) lockJson.packages[""].version = version;

  await writeJson(packagePath, packageJson);
  await writeJson(lockPath, lockJson);
}

function writeJson(file, value) {
  return writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: rootDir }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
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
