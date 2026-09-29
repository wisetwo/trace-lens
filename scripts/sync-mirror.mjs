import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--commit");
const commit = process.argv.includes("--commit");
const mirror = args[0] ? path.resolve(args[0]) : "";
if (!mirror) {
  throw new Error("Usage: node scripts/sync-mirror.mjs <mirror-repo> [x.y.z] [--commit]");
}

const sourcePackage = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const version = args[1] && !args[1].startsWith("-") ? args[1] : sourcePackage.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Expected a version like 0.1.11, got ${version}`);
}
const tag = `v${version}`;

await capture("git", ["rev-parse", "--verify", `refs/tags/${tag}`], rootDir);
const mirrorTag = (await capture("git", ["tag", "-l", tag], mirror)).trim();
if (mirrorTag === tag) {
  throw new Error(`${mirror} already has ${tag}`);
}

const temp = await mkdtemp(path.join(tmpdir(), "trace-lens-sync-"));
try {
  const archive = path.join(temp, "release.tar");
  const tree = path.join(temp, "tree");
  await mkdir(tree);
  await run("git", ["archive", "--format=tar", `-o`, archive, tag], rootDir);
  await run("tar", ["-xf", archive, "-C", tree], rootDir);

  const sourceName = JSON.parse(await readFile(path.join(tree, "package.json"), "utf8")).name;
  const mirrorPackagePath = path.join(mirror, "package.json");
  const mirrorPackage = JSON.parse(await readFile(mirrorPackagePath, "utf8"));
  const mirrorName = mirrorPackage.name;
  const keepRegistry = Boolean(mirrorPackage.publishConfig?.registry);

  for await (const file of walk(tree)) {
    const relative = path.relative(tree, file);
    if (relative === "LICENSE" || relative === "package.json" || relative === "package-lock.json" || relative === "README.md") continue;
    const target = path.join(mirror, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
  }

  const releasedPackage = JSON.parse(await readFile(path.join(tree, "package.json"), "utf8"));
  const merged = { ...releasedPackage, name: mirrorName };
  if (mirrorPackage.publishConfig) merged.publishConfig = mirrorPackage.publishConfig;
  else delete merged.publishConfig;
  await writeJson(mirrorPackagePath, merged);

  const releasedLock = JSON.parse(await readFile(path.join(tree, "package-lock.json"), "utf8"));
  const mirrorLock = JSON.parse(await readFile(path.join(mirror, "package-lock.json"), "utf8"));
  releasedLock.name = mirrorLock.name;
  releasedLock.version = version;
  if (releasedLock.packages?.[""]) {
    releasedLock.packages[""].name = mirrorLock.packages?.[""]?.name ?? mirrorLock.name;
    releasedLock.packages[""].version = version;
  }
  await writeJson(path.join(mirror, "package-lock.json"), releasedLock);

  let readme = await readFile(path.join(tree, "README.md"), "utf8");
  readme = readme.split(sourceName).join(mirrorName);
  if (!keepRegistry) readme = readme.replace(/ --registry https:\/\/mirrors\.tencent\.com\/npm\//g, "");
  await writeFile(path.join(mirror, "README.md"), readme);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log(`Copied ${tag} into ${mirror}. Package name stays ${JSON.parse(await readFile(path.join(mirror, "package.json"), "utf8")).name}; LICENSE was left untouched.`);
if (!commit) {
  console.log(`Review the mirror, then commit and tag ${tag} there, or re-run with --commit.`);
  process.exit(0);
}

await run("git", ["add", "-A"], mirror);
const pending = (await capture("git", ["status", "--porcelain"], mirror)).trim();
if (pending) {
  await run("git", ["commit", "-m", `chore: sync ${tag}`], mirror);
} else {
  console.log("Mirror tree already matched this tag; tagging the current commit.");
}
await run("git", ["tag", "-a", tag, "-m", tag], mirror);
console.log(`Mirror tagged ${tag}.`);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function writeJson(file, value) {
  return writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) reject(error);
      else resolve();
    });
  });
}

function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
