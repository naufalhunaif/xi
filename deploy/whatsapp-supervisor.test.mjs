import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSupervisorStatus, prepareSupervisorRestart } from './whatsapp-supervisor.mjs';

const root = '/www/wwwroot/Project/whatsapp';
const old = `${root}/.deploy/release-old/app`;
const runtime = `${root}/.deploy/release-new/app`;
function fixture({ webFail = false, stuck = false, oldCwd = false, duplicate = false } = {}) {
  const calls = [];
  const pids = new Map([
    [10, { cwd: old, args: ['node', 'bin/server.js'] }],
    [20, { cwd: old, args: ['node', 'ace.js', 'whatsapp:listen'] }],
    [30, { cwd: '/another/app', args: ['node', 'bin/server.js'] }],
  ]);
  let workerPid = 20;
  let webPid = 10;
  const rows = () => [
    `web:web_00 RUNNING pid ${webPid}, uptime 0:00:05`,
    workerPid ? `worker:worker_00 RUNNING pid ${workerPid}, uptime 0:00:05` : 'worker:worker_00 STOPPED Not started',
    'other RUNNING pid 30, uptime 1:00:00',
    ...(duplicate ? ['extra RUNNING pid 20, uptime 0:00:05'] : []),
  ];
  const execute = async (_bin, args) => {
    assert.deepEqual(args.slice(0, 2), ['-c', '/etc/supervisord.conf']);
    args = args.slice(2);
    calls.push(args);
    if (args[0] === 'status') return rows().filter((row) => args.length === 1 || args.slice(1).includes(row.split(' ')[0])).join('\n');
    if (args[0] === 'stop') {
      assert.equal(args[1], 'worker:worker_00');
      workerPid = 0;
      if (!stuck) pids.delete(20);
    } else if (args[0] === 'restart') {
      assert.equal(args[1], 'web:web_00');
      if (webFail) throw new Error('web fixture failure');
      webPid = 11;
      pids.set(11, { cwd: oldCwd ? old : runtime, args: ['node', 'bin/server.js'] });
      pids.delete(10);
    } else if (args[0] === 'start') {
      assert.equal(args[1], 'worker:worker_00');
      workerPid = 21;
      pids.set(21, { cwd: oldCwd ? old : runtime, args: ['node', 'ace.js', 'whatsapp:listen'] });
    } else assert.fail(`Unexpected command ${args}`);
    return '';
  };
  const options = { root, execute, inspect: async (pid) => pids.get(pid) || null,
    options: { executable: '/usr/bin/supervisorctl', config: '/etc/supervisord.conf' },
    platform: 'linux', sleep: async () => {},
  };
  return { options, calls, pids };
}
test('status parsing is strict and accepts qualified names and stopped processes', () => {
  assert.deepEqual(parseSupervisorStatus('wa:worker RUNNING pid 12, uptime 1:00:00'), [{ name: 'wa:worker', status: 'RUNNING', pid: 12 }]);
  assert.equal(parseSupervisorStatus('wa STOPPED Not started')[0].pid, 0);
  assert.throws(() => parseSupervisorStatus('error: authentication failed'), /tidak dapat dibaca/);
});
test('discovers exact app only; stops old worker, restarts web, starts worker and verifies physical release', async () => {
  const f = fixture();
  const restart = await prepareSupervisorRestart(f.options);
  assert.ok(f.calls.every((args) => args[0] === 'status'));
  await restart({ runtime });
  assert.deepEqual(f.calls.filter((args) => args[0] !== 'status'), [
    ['stop', 'worker:worker_00'], ['restart', 'web:web_00'], ['start', 'worker:worker_00'],
  ]);
  assert.ok(f.pids.has(30));
});
test('ambiguous workers abort before any process mutation', async () => {
  const f = fixture({ duplicate: true });
  await assert.rejects(prepareSupervisorRestart(f.options), /tepat satu/);
  assert.ok(f.calls.every((args) => args[0] === 'status'));
});
test('ownership is checked again after a long build', async () => {
  const f = fixture();
  const restart = await prepareSupervisorRestart(f.options);
  f.pids.set(20, { cwd: '/another/app', args: ['node', 'ace.js', 'whatsapp:listen'] });
  await assert.rejects(restart({ runtime }), /tepat satu/);
  assert.ok(f.calls.every((args) => args[0] === 'status'));
});
test('old worker must actually exit before a replacement is allowed', async () => {
  const f = fixture({ stuck: true });
  await assert.rejects((await prepareSupervisorRestart(f.options))({ runtime }), /belum dipastikan berhenti/);
  assert.deepEqual(f.calls.filter((args) => args[0] !== 'status'), [['stop', 'worker:worker_00']]);
});
test('WEB failure still attempts to bring back the stopped WORKER and reports failure', async () => {
  const f = fixture({ webFail: true });
  await assert.rejects((await prepareSupervisorRestart(f.options))({ runtime }), /web fixture failure/);
  assert.ok(f.calls.some((args) => args[0] === 'start'));
});
test('RUNNING on an old release is not considered success', async () => {
  const f = fixture({ oldCwd: true });
  await assert.rejects((await prepareSupervisorRestart(f.options))({ runtime }), /Restart belum terverifikasi/);
});
test('non-Linux refuses automatic restart before probing or changing services', async () => {
  const f = fixture();
  await assert.rejects(prepareSupervisorRestart({ ...f.options, platform: 'darwin' }), /Linux/);
  assert.equal(f.calls.length, 0);
});
