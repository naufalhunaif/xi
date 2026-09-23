import { spawn } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupReleases, reportCleanup } from "./whatsapp-release-cleanup.mjs";
import { prepareSupervisorRestart } from "./whatsapp-supervisor.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const appRoot = join(repoRoot, "whatsapp");

export function copySourcePath(sourceRoot, source) {
  const parts = relative(sourceRoot, source).split(/[\\/]/);
  if (!parts[0]) return true;
  if (
    [
      "node_modules",
      "build",
      "current",
      ".deploy",
      ".git",
      ".adonisjs",
      "storage",
      "tmp",
      "logs",
      ".claude",
      ".claude.json",
      ".agents",
      ".codex",
      ".mcp.json",
    ].includes(parts[0])
  )
    return false;
  if (parts[0].startsWith(".env")) return false;
  if (parts[0] === "public" && parts[1] === "media") return false;
  return true;
}

export async function run(command, args, cwd, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} gagal (${signal || code}).`)),
    );
  });
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function deploy({
  root = appRoot,
  verifyOnly = false,
  skipInit = false,
  execute = run,
  cleanup = cleanupReleases,
  restart = true,
  prepareRestart = prepareSupervisorRestart,
} = {}) {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Gunakan Node.js 24+ dari aaPanel.");
  if (
    !["linux", "darwin"].includes(process.platform) ||
    !["x64", "arm64"].includes(process.arch)
  )
    throw new Error("Runtime ini memerlukan Linux/macOS x64 atau arm64.");
  root = await realpath(root);
  const packageFile = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  if (
    packageFile.name !== "whatsapp" ||
    !packageFile.dependencies?.["@openai/codex"]
  )
    throw new Error("Folder WhatsApp atau dependency Codex tidak valid.");
  await access(join(root, "package-lock.json"));
  if (!verifyOnly) {
    await access(join(root, ".env"), constants.R_OK).catch(() => {
      throw new Error(
        "Siapkan whatsapp/.env untuk server terlebih dahulu. File ini tidak ditimpa oleh deploy.",
      );
    });
    if (
      (await exists(join(root, "current"))) &&
      !(await lstat(join(root, "current"))).isSymbolicLink()
    )
      throw new Error(
        "whatsapp/current sudah ada dan bukan symlink; tidak ditimpa.",
      );
    // A manual deployment may still keep uploads inside its disposable build.
    // Refuse rather than silently serving an empty shared media directory.
    if (!(await exists(join(root, "current")))) {
      for (const directory of ["public/media", "storage"]) {
        const legacy = join(root, "build", directory);
        if (
          (await exists(legacy)) &&
          (await realpath(legacy)) !==
            (await realpath(join(root, directory)).catch(() => null)) &&
          (await readdir(legacy)).length
        ) {
          throw new Error(
            `Data lama masih di build/${directory}. Pindahkan dengan backup ke whatsapp/${directory} sebelum deploy pertama.`,
          );
        }
      }
    }
  }
  const deployRoot = join(root, ".deploy");
  await mkdir(deployRoot, { recursive: true, mode: 0o700 });
  if ((await realpath(deployRoot)) !== deployRoot)
    throw new Error(".deploy tidak boleh berupa symlink.");
  const lock = join(deployRoot, "lock");
  await mkdir(lock).catch(() => {
    throw new Error(
      "Deploy lain masih berjalan atau lock tersisa. Periksa proses sebelum menghapus whatsapp/.deploy/lock.",
    );
  });
  let release;
  let promoted = false;
  try {
    const restartServices = restart && !verifyOnly ? await prepareRestart({ root }) : null;
    release = await mkdtemp(join(deployRoot, "release-"));
    const source = join(release, "source");
    const output = join(source, "build");
    console.log("Menyiapkan build terpisah; aplikasi berjalan tidak diubah.");
    await mkdir(source);
    for (const entry of await readdir(root)) {
      const path = join(root, entry);
      if (copySourcePath(root, path))
        await cp(path, join(source, entry), {
          recursive: true,
          filter: (item) => copySourcePath(root, item),
          dereference: false,
        });
    }
    // Build dependencies must be installed even if aaPanel exports NODE_ENV=production.
    const buildEnv = { ...process.env, NODE_ENV: "development" };
    await execute(
      "npm",
      [
        "ci",
        "--include=dev",
        "--include=optional",
        "--ignore-scripts=false",
        "--no-audit",
        "--no-fund",
      ],
      source,
      buildEnv,
    );
    await execute("npm", ["run", "build"], source, buildEnv);
    const productionEnv = { ...process.env, NODE_ENV: "production" };
    await execute(
      "npm",
      [
        "ci",
        "--omit=dev",
        "--include=optional",
        "--ignore-scripts=false",
        "--no-audit",
        "--no-fund",
      ],
      output,
      productionEnv,
    );
    await execute(
      process.execPath,
      [join(repoRoot, "deploy", "whatsapp-runtime-check.mjs"), output],
      output,
      productionEnv,
    );
    for (const required of [
      "bin/server.js",
      "ace.js",
      "resources/views/pages/dashboard.edge",
      "public/assets/app.css",
      "public/lang/en.js",
    ])
      await access(join(output, required));
    if (verifyOnly) {
      // Only our freshly allocated directory; no shared data has been linked yet.
      await rm(release, { recursive: true });
      console.log(
        "Verifikasi selesai. Tidak mengubah current, database, OAuth, atau proses berjalan.",
      );
      return;
    }
    const runtime = join(release, "app");
    await rename(output, runtime);
    // Shared data must be outside the disposable release. Never copy credentials.
    for (const directory of ["storage", "tmp", "public/media"]) {
      const shared = join(root, directory);
      await mkdir(shared, { recursive: true, mode: 0o700 });
      const target = join(runtime, directory);
      if (await exists(target))
        throw new Error(
          `${directory} ikut masuk build; deploy ditahan agar data tidak tertimpa.`,
        );
      await mkdir(dirname(target), { recursive: true });
      await symlink(shared, target, "dir");
    }
    await symlink(join(root, ".env"), join(runtime, ".env"));
    const runtimeEnv = {
      ...productionEnv,
      PATH:
        join(runtime, "node_modules", ".bin") +
        delimiter +
        (process.env.PATH || ""),
    };
    if (!skipInit)
      await execute(
        process.execPath,
        ["ace.js", "app:init"],
        runtime,
        runtimeEnv,
      );
    const previous = await realpath(join(root, "current")).catch(() => null);
    const pending = join(release, "next");
    await symlink(runtime, pending, "dir");
    await rename(pending, join(root, "current"));
    promoted = true;
    // Source here is exclusively the temporary copy, never the checkout or an old release.
    await rm(source, { recursive: true }).catch(() =>
      console.warn(`Salinan build boleh dibersihkan manual: ${source}`),
    );
    console.log(`Build aktif: ${runtime}`);
    if (previous) console.log(`Memeriksa build sebelumnya: ${previous}`);
    if (restartServices) await restartServices({ runtime });
    // Promotion is already successful. A cleanup failure must not be reported as
    // a failed deploy or suggest current still points at the old release.
    try {
      reportCleanup(await cleanup({ root, lockHeld: true }));
    } catch (error) {
      console.warn(
        `Build aktif sudah diperbarui; pembersihan ditunda: ${error.message}`,
      );
    }
    if (!restartServices) console.log("Build selesai tanpa restart. Restart WEB dan WORKER melalui aaPanel/Supervisor.");
  } catch (error) {
    if (release)
      console.error(
        promoted
          ? `Build baru sudah menjadi current, tetapi tahap setelah promosi gagal. Periksa WEB/WORKER; riwayat build tidak dibersihkan. Folder diagnosis: ${release}`
          : `Deploy gagal. Current tetap seperti sebelumnya; folder diagnosis: ${release}`,
      );
    throw error;
  } finally {
    await rm(lock, { recursive: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "bash deploy/build.sh [--verify-only] [--skip-init] [--no-restart] [--cleanup]\nDefault: periksa Supervisor, install, build, cek runtime, init model, ganti current, restart WEB/WORKER, verifikasi proses, bersihkan release lama.\n--no-restart: build/promosi tanpa mengubah proses.\n--verify-only: uji install/build saja, tanpa database/promosi/restart/pembersihan riwayat.\n--skip-init: tunda init model sampai startup aplikasi.\n--cleanup: hanya bersihkan riwayat, tanpa build/database/restart.",
    );
  } else if (
    args.some(
      (arg) => !["--verify-only", "--skip-init", "--cleanup", "--no-restart"].includes(arg),
    ) ||
    (args.includes("--cleanup") && args.length !== 1)
  ) {
    console.error("Opsi tidak dikenal. Gunakan --help.");
    process.exitCode = 1;
  } else if (args.includes("--cleanup")) {
    cleanupReleases()
      .then(reportCleanup)
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  } else {
    deploy({
      verifyOnly: args.includes("--verify-only"),
      skipInit: args.includes("--skip-init"),
      restart: !args.includes("--no-restart"),
    }).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
