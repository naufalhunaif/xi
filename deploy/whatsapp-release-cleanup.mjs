import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = fileURLToPath(new URL("../whatsapp", import.meta.url));
const releaseName = /^release-[A-Za-z0-9]{6}$/;

function referencedRelease(deployRoot, path) {
  const name = relative(deployRoot, path.replace(/ \(deleted\)$/, "")).split(
    "/",
  )[0];
  return releaseName.test(name) ? name : null;
}

/** Fail closed if process inspection is unavailable; never infer "unused" from access denied. */
export async function scanReleaseUsage(
  root,
  {
    platform = process.platform,
    procRoot = "/proc",
    read = readFile,
    link = readlink,
  } = {},
) {
  if (platform !== "linux")
    throw new Error("Pemeriksaan proses otomatis hanya tersedia di Linux.");
  const deployRoot = join(root, ".deploy");
  const active = new Set();
  for (const pid of await readdir(procRoot)) {
    if (!/^\d+$/.test(pid)) continue;
    const directory = join(procRoot, pid);
    try {
      const command = await read(join(directory, "cmdline"), "utf8");
      // Kernel threads and zombies have no userspace command/files to load.
      if (!command) continue;
      const cwd = await link(join(directory, "cwd"));
      const exe = await link(join(directory, "exe"));
      const maps = await read(join(directory, "maps"), "utf8");
      const paths = [
        cwd,
        exe,
        ...command
          .split("\0")
          .filter(Boolean)
          .map((arg) => resolve(cwd, arg)),
      ];
      for (const line of maps.split("\n")) {
        const start = line.indexOf("/");
        if (start >= 0) paths.push(line.slice(start));
      }
      const references = paths
        .map((path) => referencedRelease(deployRoot, path))
        .filter(Boolean);
      for (const name of references) active.add(name);
      // A direct `node current/bin/server.js` from the checkout may have loaded an
      // older symlink target. Without a physical release cwd, its identity is unknown.
      if (
        !references.length &&
        paths.some(
          (path) =>
            path === join(root, "current") ||
            path.startsWith(join(root, "current") + "/"),
        )
      ) {
        throw new Error(
          "Proses memakai current tanpa cwd release fisik. Gunakan deploy/run.sh.",
        );
      }
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error.code)) continue; // Process exited during scan.
      throw new Error(
        "Belum dapat memastikan build yang dipakai proses. Jalankan cleanup dengan izin pemeriksaan proses yang cukup.",
        { cause: error },
      );
    }
  }
  return active;
}

async function hasPrivateData(release) {
  // Standard releases contain only links to shared data. Preserve unexpected real
  // data from a manual/legacy setup instead of deleting it as build history.
  for (const base of ["app", "source", "source/build"]) {
    for (const name of [
      ".env",
      "storage",
      "tmp",
      "public/media",
      ".codex",
      ".claude",
      ".claude.json",
    ]) {
      const path = join(release, base, name);
      const stat = await lstat(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat || stat.isSymbolicLink()) continue;
      if (!stat.isDirectory() || (await readdir(path)).length) return true;
    }
  }
  return false;
}

/** Only disposable release-* children are targets. Shared directories are never traversed. */
export async function cleanupReleases({
  root = appRoot,
  lockHeld = false,
  scan = scanReleaseUsage,
} = {}) {
  root = await realpath(root);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== "whatsapp" || !pkg.dependencies?.["@openai/codex"])
    throw new Error("Folder WhatsApp tidak valid.");
  const deployRoot = join(root, ".deploy");
  if ((await realpath(deployRoot)) !== deployRoot)
    throw new Error(".deploy tidak boleh berupa symlink.");
  const lock = join(deployRoot, "lock");
  let acquired = false;
  const result = { removed: [], kept: [], reason: "" };
  try {
    if (!lockHeld) {
      try {
        await mkdir(lock);
        acquired = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        result.reason =
          "Deploy/cleanup lain masih berjalan; pembersihan ditunda.";
        return result;
      }
    }
    const currentLink = join(root, "current");
    if (!(await lstat(currentLink)).isSymbolicLink())
      throw new Error("current harus berupa symlink release.");
    const current = await realpath(currentLink);
    const currentRelease = dirname(current);
    if (
      dirname(currentRelease) !== deployRoot ||
      !releaseName.test(relative(deployRoot, currentRelease)) ||
      current !== join(currentRelease, "app")
    ) {
      throw new Error(
        "Target current bukan release yang dikelola deploy; pembersihan ditunda.",
      );
    }
    let active;
    try {
      active = await scan(root);
    } catch (error) {
      result.reason = error.message;
      return result;
    }
    for (const entry of await readdir(deployRoot, { withFileTypes: true })) {
      if (
        !releaseName.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        continue;
      const target = join(deployRoot, entry.name);
      if (target === currentRelease) continue;
      if (active.has(entry.name)) {
        result.kept.push({ name: entry.name, reason: "Masih dipakai proses" });
        continue;
      }
      if (
        (await realpath(target)) !== target ||
        (await hasPrivateData(target))
      ) {
        result.kept.push({
          name: entry.name,
          reason: "Berisi data lokal atau path tidak aman",
        });
        continue;
      }
      // The shared lock excludes normal deployments/startup cleanup. Recheck even
      // so, to refuse an externally changed current before a destructive operation.
      if ((await realpath(currentLink)) !== current)
        throw new Error("current berubah; pembersihan dihentikan.");
      await rm(target, { recursive: true });
      result.removed.push(entry.name);
    }
    return result;
  } finally {
    if (acquired) await rm(lock, { recursive: true });
  }
}

export function reportCleanup(result, quiet = false) {
  if (result.removed.length)
    console.log(`Build lama dihapus permanen: ${result.removed.join(", ")}.`);
  if (!quiet && result.kept.length)
    console.log(
      `Pembersihan ditunda: ${result.kept.map((item) => `${item.name} (${item.reason})`).join(", ")}.`,
    );
  if (!quiet && result.reason) console.warn(result.reason);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  cleanupReleases()
    .then((result) => reportCleanup(result, process.argv.includes("--quiet")))
    .catch((error) => {
      console.warn(`Pembersihan build ditunda: ${error.message}`);
      // Cleanup must never prevent the WEB/WORKER launcher from starting.
      process.exitCode = 0;
    });
}
