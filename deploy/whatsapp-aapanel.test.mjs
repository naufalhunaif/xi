import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copySourcePath, deploy as deployApplication } from "./whatsapp-aapanel.mjs";
const deploy = (options) => deployApplication({ restart: false, ...options });
import { cleanupReleases } from "./whatsapp-release-cleanup.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "whatsapp-deploy-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, content = "fixture") => {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  };
  await put(
    "package.json",
    JSON.stringify({
      name: "whatsapp",
      dependencies: { "@openai/codex": "0.154.0" },
    }),
  );
  await put("package-lock.json", "{}");
  await put("app/example.ts");
  await put("public/assets/app.css");
  await put(".env", "TEST_SECRET=not-for-source-build");
  await put("storage/cs-media/example.bin", "private media");
  await put("public/media/photo.jpg", "old photo");
  await put("tmp/worker.log", "existing log");
  await put(".deploy/old/app/bin/server.js", "previous build");
  await symlink(join(root, ".deploy/old/app"), join(root, "current"));
  return { root: await realpath(root), put };
}
function fakeExecutor(calls, fail = "") {
  return async (command, args, cwd, env) => {
    calls.push({ command, args, cwd, env });
    if (args.join(" ").includes(fail) && fail)
      throw new Error("fixture failure");
    if (args.join(" ") !== "run build") return;
    assert.equal(env.NODE_ENV, "development");
    await assert.rejects(readFile(join(cwd, ".env")), /ENOENT/);
    await assert.rejects(
      readFile(join(cwd, "public/media/photo.jpg")),
      /ENOENT/,
    );
    await assert.rejects(
      readFile(join(cwd, "storage/cs-media/example.bin")),
      /ENOENT/,
    );
    for (const path of [
      "bin/server.js",
      "ace.js",
      "resources/views/pages/dashboard.edge",
      "public/assets/app.css",
      "public/lang/en.js",
    ]) {
      const file = join(cwd, "build", path);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, "compiled fixture");
    }
  };
}

test("source filter excludes credentials, dependencies, release trees and uploads, not app assets", () => {
  for (const path of [
    ".env",
    ".env.production",
    ".deploy/release/app",
    "current/foo",
    "build/public",
    "storage/secret",
    "public/media/a.jpg",
    ".claude/settings.json",
    "node_modules/module",
    ".git/config",
    "tmp/log",
  ])
    assert.equal(copySourcePath("/app", `/app/${path}`), false, path);
  for (const path of [
    "app/services/ai_service.ts",
    "package-lock.json",
    "public/assets/app.css",
    "public/lang/en.js",
    "resources/views/a.edge",
  ])
    assert.equal(copySourcePath("/app", `/app/${path}`), true, path);
});

test("successful deploy promotes only after production install/runtime check/init and preserves shared data", async (t) => {
  const { root } = await fixture(t);
  const calls = [];
  await deploy({ root, execute: fakeExecutor(calls) });
  const current = await realpath(join(root, "current"));
  assert.notEqual(current, join(root, ".deploy/old/app"));
  assert.match(current, /release-[^/]+\/app$/);
  assert.equal(
    await readFile(join(current, ".env"), "utf8"),
    "TEST_SECRET=not-for-source-build",
  );
  assert.equal(
    await readFile(join(current, "public/media/photo.jpg"), "utf8"),
    "old photo",
  );
  assert.equal(
    await readFile(join(current, "storage/cs-media/example.bin"), "utf8"),
    "private media",
  );
  assert.equal(
    await readFile(join(root, ".deploy/old/app/bin/server.js"), "utf8"),
    "previous build",
  );
  assert.equal(await readFile(join(root, "app/example.ts"), "utf8"), "fixture");
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 2)),
    [
      ["ci", "--include=dev"],
      ["run", "build"],
      ["ci", "--omit=dev"],
      [calls[3].args[0], calls[3].args[1]],
      ["ace.js", "app:init"],
    ],
  );
  assert.match(calls[4].env.PATH, /node_modules\/\.bin/);
  assert.equal(calls[4].env.NODE_ENV, "production");
  assert.equal((await readdir(join(root, ".deploy"))).includes("lock"), false);
});

for (const fail of [
  "--include=dev",
  "run build",
  "--omit=dev",
  "whatsapp-runtime-check.mjs",
  "app:init",
]) {
  test(`failure at ${fail} leaves current and uploads untouched`, async (t) => {
    const { root } = await fixture(t);
    await assert.rejects(
      deploy({
        root,
        execute: fakeExecutor([], fail),
        cleanup: () => assert.fail("failed deploy must not clean history"),
      }),
      /fixture failure/,
    );
    assert.equal(
      await realpath(join(root, "current")),
      join(root, ".deploy/old/app"),
    );
    assert.equal(
      await readFile(join(root, "public/media/photo.jpg"), "utf8"),
      "old photo",
    );
    assert.equal(
      (await readdir(join(root, ".deploy"))).includes("lock"),
      false,
    );
  });
}

test("verify-only never initializes database or promotes and removes only its own staging copy", async (t) => {
  const { root } = await fixture(t);
  const calls = [];
  await deploy({
    root,
    verifyOnly: true,
    execute: fakeExecutor(calls),
    cleanup: () => assert.fail("verification must not clean history"),
  });
  assert.equal(
    calls.some((call) => call.args.includes("app:init")),
    false,
  );
  assert.equal(
    await realpath(join(root, "current")),
    join(root, ".deploy/old/app"),
  );
  assert.deepEqual(await readdir(join(root, ".deploy")), ["old"]);
});

test("lock refuses concurrent deployment without deleting the other deployment lock", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, ".deploy/lock"));
  await assert.rejects(
    deploy({ root, execute: () => assert.fail("must not install") }),
    /Deploy lain/,
  );
  assert.equal((await readdir(join(root, ".deploy"))).includes("lock"), true);
});

test("legacy uploads inside manual build stop first deploy instead of hiding them", async (t) => {
  const { root, put } = await fixture(t);
  await rm(join(root, "current"));
  await put("build/public/media/legacy.jpg", "do not lose");
  await assert.rejects(
    deploy({ root, execute: () => assert.fail("must not install") }),
    /Data lama masih/,
  );
  assert.equal(
    await readFile(join(root, "build/public/media/legacy.jpg"), "utf8"),
    "do not lose",
  );
});

test("missing env or non-symlink current fails before install and without overwriting files", async (t) => {
  const { root } = await fixture(t);
  await rm(join(root, ".env"));
  await assert.rejects(
    deploy({ root, execute: () => assert.fail("must not install") }),
    /Siapkan whatsapp\/\.env/,
  );
  await writeFile(join(root, ".env"), "unchanged");
  await rm(join(root, "current"));
  await mkdir(join(root, "current"));
  await assert.rejects(
    deploy({ root, execute: () => assert.fail("must not install") }),
    /bukan symlink/,
  );
  assert.equal(await readFile(join(root, ".env"), "utf8"), "unchanged");
});

test("successful deploy automatically prunes all unused managed releases after promotion", async (t) => {
  const { root, put } = await fixture(t);
  await put(".deploy/release-old001/app/bin/server.js");
  await put(".deploy/release-bad001/source/node_modules/dependency.js");
  let promoted = false;
  await deploy({
    root,
    execute: fakeExecutor([]),
    cleanup: async (options) => {
      promoted = (await realpath(join(root, "current"))).includes("release-");
      return cleanupReleases({ ...options, scan: async () => new Set() });
    },
  });
  assert.equal(promoted, true);
  await assert.rejects(lstat(join(root, ".deploy/release-old001")), /ENOENT/);
  await assert.rejects(lstat(join(root, ".deploy/release-bad001")), /ENOENT/);
});

test("cleanup failure after promotion does not turn a successful deployment into failure", async (t) => {
  const { root } = await fixture(t);
  await deploy({
    root,
    execute: fakeExecutor([]),
    cleanup: () => {
      throw new Error("fixture cleanup permissions");
    },
  });
  assert.match(await realpath(join(root, "current")), /release-[^/]+\/app$/);
  await assert.rejects(lstat(join(root, ".deploy/lock")), /ENOENT/);
});

test('automatic restart happens after build/init/promotion and before cleanup', async (t) => {
  const { root } = await fixture(t);
  const events = [];
  await deploy({ root, restart: true, execute: fakeExecutor([]),
    prepareRestart: async () => {
      assert.equal(await realpath(join(root, 'current')), join(root, '.deploy/old/app'));
      events.push('preflight');
      return async ({ runtime }) => {
        assert.equal(await realpath(join(root, 'current')), runtime);
        events.push('restart');
      };
    }, cleanup: async () => { events.push('cleanup'); return { deleted: [], kept: [] }; },
  });
  assert.deepEqual(events, ['preflight', 'restart', 'cleanup']);
});
test('restart preflight failure stops before install and leaves current intact', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(deploy({ root, restart: true,
    execute: () => assert.fail('must not build'),
    prepareRestart: async () => { throw new Error('supervisor missing'); },
  }), /supervisor missing/);
  assert.equal(await realpath(join(root, 'current')), join(root, '.deploy/old/app'));
});
test('failed build never restarts services', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(deploy({ root, restart: true, execute: fakeExecutor([], 'run build'),
    prepareRestart: async () => () => assert.fail('must not restart'),
  }), /fixture failure/);
});
test('restart failure retains promoted current and old release, skips cleanup, releases lock', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(deploy({ root, restart: true, execute: fakeExecutor([]),
    prepareRestart: async () => async () => { throw new Error('restart fixture failure'); },
    cleanup: () => assert.fail('must retain previous release'),
  }), /restart fixture failure/);
  assert.notEqual(await realpath(join(root, 'current')), join(root, '.deploy/old/app'));
  assert.ok(await lstat(join(root, '.deploy/old/app/bin/server.js')));
  await assert.rejects(lstat(join(root, '.deploy/lock')), /ENOENT/);
});
test('verify-only and explicit no-restart never probe Supervisor', async (t) => {
  for (const verifyOnly of [true, false]) {
    const { root } = await fixture(t);
    await deploy({ root, restart: verifyOnly, verifyOnly, execute: fakeExecutor([]),
      prepareRestart: () => assert.fail('must not access Supervisor'),
    });
  }
});
