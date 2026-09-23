// Run from whatsapp/ on the server. Credentials are written to private files, never stdout.
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises'
import { randomBytes, createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('../', import.meta.url))
process.loadEnvFile(join(root, '.env'))
const url = new URL(process.env.APP_URL)
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
  throw new Error('APP_URL must be a clean HTTPS URL')
const directory = join(root, 'storage/diagnostics')
await mkdir(directory, { recursive: true, mode: 0o700 })
const accessPath = join(directory, 'access.json')
if (
  !process.argv.includes('--rotate') &&
  (await readFile(accessPath)
    .then(() => true)
    .catch(() => false))
) {
  console.log(
    'Diagnostics already configured. Use --rotate to replace access. Client file: storage/diagnostics/client.json'
  )
  process.exit(0)
}
// aaPanel installs dependencies inside the immutable release, not the source checkout.
// Resolve current once so a simultaneous deployment cannot mix release dependencies.
const runtime = await realpath(join(root, 'current')).catch((error) => {
  if (error.code === 'ENOENT') return root
  throw error
})
const mysql = createRequire(join(runtime, 'package.json'))('mysql2/promise')
const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  connectTimeout: 3000,
})
let workspaceId
try {
  const [rows] = await connection.query({
    sql: 'SELECT active_id FROM whatsapp_workspace_state WHERE id = 1',
    timeout: 3000,
  })
  workspaceId = Number(rows[0]?.active_id)
} finally {
  connection.destroy()
}
if (!Number.isSafeInteger(workspaceId) || workspaceId < 1)
  throw new Error('Connect/select a WhatsApp workspace before enabling diagnostics')
const token = randomBytes(32).toString('base64url')
const expiresAt = Date.now() + 30 * 24 * 60 * 60_000
const base = url.toString().replace(/\/$/, '') + '/'
const access = {
  tokenHash: createHash('sha256').update(token).digest('hex'),
  workspaceId,
  expiresAt,
}
const client = {
  url: new URL('api/ops/diagnostics', base).toString(),
  token,
  workspaceId,
  expiresAt,
}
for (const [file, value] of [
  ['client.json', client],
  ['access.json', access],
]) {
  const target = join(directory, file)
  await writeFile(`${target}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(`${target}.tmp`, target)
}
console.log(
  `Read-only diagnostics enabled for workspace ${workspaceId}, expires ${new Date(expiresAt).toISOString()}.`
)
console.log(
  'Download storage/diagnostics/client.json through your authenticated server file manager; keep it private. No token was printed.'
)
