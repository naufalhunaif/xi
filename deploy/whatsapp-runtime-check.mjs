import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";

const execute = promisify(execFile);
const root = resolve(process.argv[2] || process.cwd());
const require = createRequire(join(root, "package.json"));
const environment = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
async function cli(name, args) {
  const { stdout, stderr } = await execute(
    join(root, "node_modules", ".bin", name),
    args,
    { cwd: root, env: environment, timeout: 30000, maxBuffer: 100000 },
  );
  return `${stdout}\n${stderr}`;
}
try {
  for (const name of ["codex", "claude"])
    console.log((await cli(name, ["--version"])).trim());
  const help = await cli("codex", ["exec", "--help"]);
  for (const flag of [
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-schema",
    "--image",
    "--json",
  ]) {
    if (!help.includes(flag))
      throw new Error(
        `Codex terpasang belum mendukung ${flag}; jangan jalankan worker dengan versi ini.`,
      );
  }
  const sharp = require("sharp");
  await sharp({
    create: { width: 1, height: 1, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  const ffmpeg = require("ffmpeg-static");
  if (!ffmpeg)
    throw new Error(
      "ffmpeg-static tidak menyediakan biner untuk platform ini.",
    );
  await access(ffmpeg);
  await execute(ffmpeg, ["-version"], { timeout: 10000, maxBuffer: 100000 });
  require("mysql2/promise");
  const ace = await readFile(join(root, "ace.js"), "utf8");
  if (ace.includes("import '@poppinss/ts-exec'"))
    throw new Error("Ace belum ter-compile untuk produksi.");
  console.log(
    "Runtime OK: Codex, Claude, Sharp, FFmpeg, MySQL driver, dan Ace produksi. Tidak memanggil AI/login/database.",
  );
} catch (error) {
  console.error(`Runtime check gagal: ${error.message}`);
  process.exitCode = 1;
}
