// Read-only: no database, credentials, provider calls, deploy, restart or process signals.
import { readFile, realpath, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function inspectReplyRuntime(root, extension = 'js') {
  try {
    const directory = await realpath(root);
    const service = join(directory, 'app/services');
    const [ai, routing, selection] = await Promise.all([
      readFile(join(service, `ai_service.${extension}`), 'utf8'),
      readFile(join(service, `skill_routing_service.${extension}`), 'utf8'),
      readFile(join(service, `reply_skill_selection.${extension}`), 'utf8').catch(() => ''),
    ]);
    return {
      directory,
      aiFingerprint: createHash('sha256').update(ai).digest('hex').slice(0, 16),
      activeSkillSelection: ai.includes('selectReplySkills(settings.skills)') && selection.includes('superseded_by_available_modules'),
      minimumSavingRatio: Number(routing.match(/minimumSavingRatio\s*=\s*([\d.]+)/)?.[1]) || null,
      turnMcpCache: ai.includes('turnCache: settings.turnMcpCache'),
    };
  } catch (error) {
    return { directory: resolve(root), unavailable: error.code || 'READ_FAILED' };
  }
}

export async function diagnoseReplyRuntime(root) {
  const appRoot = await realpath(root);
  const execute = promisify(execFile);
  const checkout = await execute('git', ['-C', appRoot, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 })
    .then(({ stdout }) => stdout.trim()).catch(() => 'unavailable');
  const workers = [];
  let processInspection = 'unavailable';
  try {
    const pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
    processInspection = 'visible_processes_only';
    for (const pid of pids) {
      try {
        const cwd = await realpath(`/proc/${pid}/cwd`);
        if (cwd !== appRoot && !cwd.startsWith(`${appRoot}${sep}`)) continue;
        const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
        const role = args.includes('whatsapp:listen') ? 'worker' : args.some((arg) => arg.endsWith('bin/server.js')) ? 'web' : null;
        if (role) workers.push({ pid: Number(pid), role, runtime: await inspectReplyRuntime(cwd) });
      } catch { /* Process exited or belongs to an unreadable user. */ }
    }
  } catch { /* /proc is Linux-only. Never infer a stopped worker from absence. */ }
  return {
    checkout,
    source: await inspectReplyRuntime(appRoot, 'ts'),
    current: await inspectReplyRuntime(join(appRoot, 'current')),
    processInspection,
    processes: workers,
    note: 'Files and visible process working directories only; this does not prove AI or database health. No secrets or process arguments are printed.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] || fileURLToPath(new URL('../whatsapp', import.meta.url));
  console.log(JSON.stringify(await diagnoseReplyRuntime(root), null, 2));
}
