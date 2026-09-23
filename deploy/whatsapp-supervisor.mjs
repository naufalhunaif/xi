import { execFile } from 'node:child_process';
import { access, readFile, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';

// Capture diagnostics without dumping Supervisor configuration, passwords, or environments.
export function supervisorCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 180000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error && !(args.includes('status') && error.code === 3))
        return reject(new Error(`Supervisor gagal pada ${args.includes('status') ? 'status' : args.at(-2)}. Periksa log Supervisor.`));
      resolve(stdout);
    });
  });
}

export function parseSupervisorStatus(text) {
  const rows = [];
  for (const line of text.trim().split('\n')) {
    const match = line.match(/^(\S+)\s+(RUNNING|STARTING|STOPPING|STOPPED|EXITED|FATAL|BACKOFF|UNKNOWN)\b(.*)$/);
    if (!match) throw new Error('Status Supervisor tidak dapat dibaca. Periksa konfigurasi supervisorctl.');
    const pid = Number(match[3].match(/\bpid\s+(\d+)/)?.[1] || 0);
    rows.push({ name: match[1], status: match[2], pid });
  }
  return rows;
}
const safeName = (name) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/.test(name) && name !== 'all';
export async function processInfo(pid) {
  try {
    return { cwd: await readlink(`/proc/${pid}/cwd`), args: (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean) };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw new Error(`Tidak dapat memeriksa PID ${pid}; jalankan dengan izin membaca proses WEB/WORKER.`);
  }
}
function roleOf(root, info) {
  if (!info) return null;
  const path = relative(root, info.cwd).replaceAll('\\', '/');
  if (!/^(?:\.deploy\/release-[A-Za-z0-9_-]+\/app|build)$/.test(path)) return null;
  const args = info.args;
  if (args.some((arg) => arg === 'ace.js' || arg === join(info.cwd, 'ace.js')) && args.includes('whatsapp:listen')) return 'worker';
  if (args.some((arg) => arg === 'bin/server.js' || arg === join(info.cwd, 'bin/server.js'))) return 'web';
  return null;
}
async function firstAccessible(paths, mode) {
  for (const path of paths.filter(Boolean)) {
    try { await access(path, mode); return path; } catch {}
  }
  return null;
}
export async function supervisorOptions(env = process.env) {
  const executable = env.WHATSAPP_SUPERVISORCTL
    ? await firstAccessible([env.WHATSAPP_SUPERVISORCTL], constants.X_OK)
    : await firstAccessible([
        ...String(env.PATH || '').split(delimiter).filter(isAbsolute).map((path) => join(path, 'supervisorctl')),
        '/www/server/panel/pyenv/bin/supervisorctl', '/usr/bin/supervisorctl', '/usr/local/bin/supervisorctl',
      ], constants.X_OK);
  const config = await firstAccessible(env.WHATSAPP_SUPERVISOR_CONFIG ? [env.WHATSAPP_SUPERVISOR_CONFIG] : [
    '/www/server/panel/plugin/supervisor/supervisord.conf', '/etc/supervisord.conf', '/etc/supervisor/supervisord.conf',
  ], constants.R_OK);
  if (!executable || !config || !isAbsolute(executable) || !isAbsolute(config))
    throw new Error('Supervisor belum ditemukan. Atur WHATSAPP_SUPERVISORCTL dan WHATSAPP_SUPERVISOR_CONFIG ke path absolut, atau gunakan --no-restart.');
  return { executable, config };
}

/** Discovery is read-only. No restart-all, guessed names, or broad PID killing. */
export async function prepareSupervisorRestart({
  root, options, execute = supervisorCommand, inspect = processInfo,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), platform = process.platform,
} = {}) {
  if (platform !== 'linux') throw new Error('Restart otomatis memerlukan Supervisor Linux. Gunakan --no-restart untuk build lokal.');
  const { executable, config } = options || await supervisorOptions();
  const call = (...args) => execute(executable, ['-c', config, ...args]);
  async function discover() {
    const rows = parseSupervisorStatus(await call('status'));
    const found = { web: [], worker: [] };
    for (const row of rows) {
      if (row.status !== 'RUNNING' || !row.pid) continue;
      const role = roleOf(root, await inspect(row.pid));
      if (role) {
        if (!safeName(row.name)) throw new Error('Nama proses Supervisor tidak aman untuk restart otomatis.');
        found[role].push(row);
      }
    }
    if (found.web.length !== 1 || found.worker.length !== 1 || found.web[0].name === found.worker[0].name)
      throw new Error('Harus ditemukan tepat satu WEB dan satu WORKER WhatsApp yang RUNNING. Periksa Supervisor dan launcher deploy/run.sh; tidak ada proses yang dihentikan.');
    return { web: found.web[0], worker: found.worker[0] };
  }
  const selected = await discover();
  console.log(`Restart otomatis: WEB ${selected.web.name}, WORKER ${selected.worker.name}.`);
  return async ({ runtime }) => {
    // Building takes time: resolve PIDs and ownership again before any mutation.
    const current = await discover();
    if (current.web.name !== selected.web.name || current.worker.name !== selected.worker.name)
      throw new Error('Target Supervisor berubah selama build. Restart otomatis dibatalkan.');
    await call('stop', current.worker.name);
    const stopped = parseSupervisorStatus(await call('status', current.worker.name));
    if (stopped.length !== 1 || stopped[0].name !== current.worker.name || stopped[0].status !== 'STOPPED' || await inspect(current.worker.pid))
      throw new Error('WORKER lama belum dipastikan berhenti. Tidak menjalankan WORKER baru. Periksa Supervisor.');
    let webError;
    try { await call('restart', current.web.name); } catch (error) { webError = error; }
    // Even if WEB fails, attempt to bring back the explicitly stopped WORKER.
    await call('start', current.worker.name);
    if (webError) throw webError;
    let stable = 0;
    let previousPids = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      const rows = parseSupervisorStatus(await call('status', current.web.name, current.worker.name));
      let valid = rows.length === 2;
      const pids = [];
      for (const role of ['web', 'worker']) {
        const row = rows.find((item) => item.name === current[role].name);
        const info = row?.pid ? await inspect(row.pid) : null;
        valid &&= row?.status === 'RUNNING' && info?.cwd === runtime && roleOf(root, info) === role && row.pid !== current[role].pid;
        pids.push(row?.pid || 0);
      }
      const signature = pids.join(':');
      stable = valid ? signature === previousPids ? stable + 1 : 1 : 0;
      previousPids = signature;
      if (stable >= 3) {
        console.log('WEB dan WORKER RUNNING pada build current terbaru.');
        return;
      }
      await sleep(1000);
    }
    throw new Error('Restart belum terverifikasi: WEB/WORKER tidak stabil atau masih memakai release lama. Periksa launcher dan log Supervisor.');
  };
}
