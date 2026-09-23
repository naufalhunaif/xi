import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  realpath,
  readdir,
  rm,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupReleases,
  scanReleaseUsage,
} from "./whatsapp-release-cleanup.mjs";

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "wa-release-cleanup-test-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, body = "fixture") => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  };
  await put(
    "package.json",
    JSON.stringify({
      name: "whatsapp",
      dependencies: { "@openai/codex": "test" },
    }),
  );
  await put(".deploy/release-new001/app/bin/server.js");
  await put(".deploy/release-old001/app/bin/server.js");
  await put(".deploy/release-bad001/source/node_modules/dependency.js");
  await put("storage/auth/token", "keep credentials");
  await put("public/media/photo.jpg", "keep media");
  await put(".env", "keep env");
  await symlink(
    join(root, ".deploy/release-new001/app"),
    join(root, "current"),
  );
  return {
    root,
    put,
    cleanup: (scan = async () => new Set()) => cleanupReleases({ root, scan }),
  };
}

test("cleanup removes all unused success/failed releases, not current or linked private data", async (t) => {
  const { root, put, cleanup } = await fixture(t);
  await symlink(
    join(root, "storage"),
    join(root, ".deploy/release-old001/app/storage"),
  );
  await symlink(
    join(root, ".env"),
    join(root, ".deploy/release-old001/app/.env"),
  );
  await mkdir(join(root, ".deploy/release-old001/app/public"));
  await symlink(
    join(root, "public/media"),
    join(root, ".deploy/release-old001/app/public/media"),
  );
  await put(".deploy/notes/do-not-delete");
  const result = await cleanup();
  assert.deepEqual(result.removed.sort(), ["release-bad001", "release-old001"]);
  assert.equal(
    await readFile(join(root, "storage/auth/token"), "utf8"),
    "keep credentials",
  );
  assert.equal(
    await readFile(join(root, "public/media/photo.jpg"), "utf8"),
    "keep media",
  );
  assert.equal(await readFile(join(root, ".env"), "utf8"), "keep env");
  assert.ok(await lstat(join(root, "current/bin/server.js")));
  assert.ok(await lstat(join(root, ".deploy/notes/do-not-delete")));
  assert.deepEqual((await cleanup()).removed, []);
});

test("running release stays until both WEB and WORKER stop using it", async (t) => {
  const { root, cleanup } = await fixture(t);
  for (const role of ["web", "worker"]) {
    const result = await cleanup(async () => new Set(["release-old001"]));
    assert.equal(result.kept[0].name, "release-old001", role);
    assert.ok(await lstat(join(root, ".deploy/release-old001")));
  }
  assert.deepEqual((await cleanup()).removed, ["release-old001"]);
});

test("cleanup refuses inaccessible process inventory and never removes another operation's lock", async (t) => {
  const { root, cleanup } = await fixture(t);
  const result = await cleanup(async () => {
    throw new Error("permission denied");
  });
  assert.equal(result.reason, "permission denied");
  assert.deepEqual(result.removed, []);
  await mkdir(join(root, ".deploy/lock"));
  const locked = await cleanup(() => assert.fail("must not scan"));
  assert.match(locked.reason, /lain masih/);
  assert.ok(await lstat(join(root, ".deploy/lock")));
});

test("unexpected real credentials/uploads and symlink release entries are preserved", async (t) => {
  const { root, put, cleanup } = await fixture(t);
  await put(".deploy/release-old001/app/storage/private", "legacy data");
  await symlink(join(root, "storage"), join(root, ".deploy/release-link01"));
  const result = await cleanup();
  assert.equal(result.kept[0].name, "release-old001");
  assert.equal(
    await readFile(
      join(root, ".deploy/release-old001/app/storage/private"),
      "utf8",
    ),
    "legacy data",
  );
  assert.ok(
    (await lstat(join(root, ".deploy/release-link01"))).isSymbolicLink(),
  );
});

test("invalid current or symlink deploy root stops deletion", async (t) => {
  const { root, cleanup } = await fixture(t);
  await rm(join(root, "current"));
  await symlink(join(root, "storage"), join(root, "current"));
  await assert.rejects(cleanup(), /current bukan release/);
  assert.ok(await lstat(join(root, ".deploy/release-old001")));
  const other = await fixture(t);
  await rm(join(other.root, ".deploy"), { recursive: true });
  await symlink(join(root, ".deploy"), join(other.root, ".deploy"));
  await assert.rejects(other.cleanup(), /symlink/);
});

test("Linux inventory protects cwd, executable, script argument and memory-mapped release files", async (t) => {
  const { root, put } = await fixture(t);
  const procRoot = join(root, "proc");
  const paths = [
    [
      join(root, ".deploy/release-old001/app"),
      "/usr/bin/node",
      "node\0bin/server.js\0",
      "",
    ],
    [
      root,
      join(root, ".deploy/release-old002/app/node_modules/codex"),
      "codex\0",
      "",
    ],
    [
      root,
      "/usr/bin/node",
      `node\0${root}/.deploy/release-old003/app/ace.js\0`,
      "",
    ],
    [
      root,
      "/usr/bin/node",
      "node\0",
      `a-b r-xp 0 00:00 0 ${root}/.deploy/release-old004/app/native.node\n`,
    ],
  ];
  for (const [i, [cwd, exe, command, maps]] of paths.entries()) {
    await put(`proc/${i + 1}/cmdline`, command);
    await put(`proc/${i + 1}/maps`, maps);
    await symlink(cwd, join(procRoot, String(i + 1), "cwd"));
    await symlink(exe, join(procRoot, String(i + 1), "exe"));
  }
  await put("proc/5/cmdline", ""); // Kernel thread.
  await mkdir(join(procRoot, "6")); // Process exited mid-scan.
  const active = await scanReleaseUsage(root, { platform: "linux", procRoot });
  assert.deepEqual([...active].sort(), [
    "release-old001",
    "release-old002",
    "release-old003",
    "release-old004",
  ]);
  await assert.rejects(
    scanReleaseUsage(root, { platform: "darwin", procRoot }),
    /Linux/,
  );
  await assert.rejects(
    scanReleaseUsage(root, {
      platform: "linux",
      procRoot,
      read: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }),
    /memastikan/,
  );
});

test("direct current script without a physical release cwd is treated as uncertain", async (t) => {
  const { root, put } = await fixture(t);
  await put("proc/1/cmdline", "node\0current/bin/server.js\0");
  await put("proc/1/maps", "");
  await symlink(root, join(root, "proc/1/cwd"));
  await symlink("/usr/bin/node", join(root, "proc/1/exe"));
  await assert.rejects(
    scanReleaseUsage(root, { platform: "linux", procRoot: join(root, "proc") }),
    /memastikan/,
  );
  assert.equal((await readdir(join(root, ".deploy"))).length, 3);
});
