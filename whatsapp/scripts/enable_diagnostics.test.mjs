import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, symlink, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const execute = promisify(execFile)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'diagnostic-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await copyFile(
    new URL('./enable_diagnostics.mjs', import.meta.url),
    join(root, 'scripts/enable_diagnostics.mjs')
  )
  await writeFile(join(root, '.env'), 'APP_URL=https://keepbelanja.com/whatsapp\n')
  return root
}
async function fakeMysql(root, workspaceId) {
  const directory = join(root, 'node_modules/mysql2')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'mysql2', type: 'commonjs' })
  )
  await writeFile(
    join(directory, 'promise.js'),
    `
    exports.createConnection = async () => ({
      async query({sql}) {
        if (sql !== 'SELECT active_id FROM whatsapp_workspace_state WHERE id = 1') throw Error('Unexpected query');
        return [[{ active_id: ${workspaceId} }]];
      },
      destroy() {}
    });
  `
  )
}
async function run(root, args = []) {
  // Deliberately outside the checkout: paths must follow the script, not the shell cwd.
  return execute(process.execPath, [join(root, 'scripts/enable_diagnostics.mjs'), ...args], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
  })
}
async function checkAccess(root, workspaceId, stdout) {
  const directory = join(root, 'storage/diagnostics')
  const client = JSON.parse(await readFile(join(directory, 'client.json'), 'utf8'))
  const access = JSON.parse(await readFile(join(directory, 'access.json'), 'utf8'))
  assert.equal(client.workspaceId, workspaceId)
  assert.equal(client.url, 'https://keepbelanja.com/whatsapp/api/ops/diagnostics')
  assert.equal(access.tokenHash, createHash('sha256').update(client.token).digest('hex'))
  assert.equal(stdout.includes(client.token), false)
  assert.equal((await stat(join(directory, 'client.json'))).mode & 0o777, 0o600)
  return client
}

test('source checkout without dependencies uses current release and shared storage', async (t) => {
  const root = await fixture(t)
  const release = join(root, '.deploy/release-fixture/app')
  await fakeMysql(release, 2)
  await mkdir(join(root, 'storage'))
  await symlink(join(root, 'storage'), join(release, 'storage'))
  await symlink(release, join(root, 'current'))
  const first = await run(root)
  const original = await checkAccess(root, 2, first.stdout)
  assert.deepEqual(await checkAccess(join(root, 'current'), 2, first.stdout), original)
  // A source install must not override the active release's dependencies.
  await fakeMysql(root, 9)
  const rotated = await run(root, ['--rotate'])
  const replacement = await checkAccess(root, 2, rotated.stdout)
  assert.notEqual(replacement.token, original.token)
})

test('local checkout without current uses its own dependencies', async (t) => {
  const root = await fixture(t)
  await fakeMysql(root, 3)
  const { stdout } = await run(root)
  await checkAccess(root, 3, stdout)
})

test('existing access is preserved without loading mysql or changing credentials', async (t) => {
  const root = await fixture(t)
  const directory = join(root, 'storage/diagnostics')
  await mkdir(directory, { recursive: true })
  const original = JSON.stringify({ tokenHash: 'fixture-only' })
  await writeFile(join(directory, 'access.json'), original)
  const { stdout } = await run(root)
  assert.match(stdout, /already configured/)
  assert.equal(await readFile(join(directory, 'access.json'), 'utf8'), original)
})
