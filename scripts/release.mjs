import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const bump = args[0] && !args[0].startsWith("-") ? args[0] : "patch";
const publishArgs = args[0] && !args[0].startsWith("-") ? args.slice(1) : args;

const packagePath = path.join(rootDir, "package.json");
const lockPath = path.join(rootDir, "package-lock.json");

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const lockJson = JSON.parse(await readFile(lockPath, "utf8"));
const current = packageJson.version;
const next = nextVersion(current, bump);

await updateVersion(next);

const npmPublishArgs = ["publish", ...publishArgs];
if (!publishArgs.includes("--access") && !publishArgs.some((arg) => arg.startsWith("--access="))) {
  npmPublishArgs.splice(1, 0, "--access", "public");
}

console.log(`Version updated to ${next}`);
try {
  await run("npm", npmPublishArgs);
} catch (error) {
  await updateVersion(current);
  console.error(`Publish failed. Version rolled back to ${current}.`);
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
      throw new Error(`Usage: npm run release -- [patch|minor|major|x.y.z] [npm publish args...]`);
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
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
