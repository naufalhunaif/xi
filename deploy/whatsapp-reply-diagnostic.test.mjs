import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectReplyRuntime } from './whatsapp-reply-diagnostic.mjs';

test('diagnostic identifies active policy code without loading app, secrets or providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reply-diagnostic-'));
  try {
    const service = join(root, 'app/services');
    await mkdir(service, { recursive: true });
    await writeFile(join(service, 'ai_service.js'), 'selectReplySkills(settings.skills); const options = { turnCache: settings.turnMcpCache };');
    await writeFile(join(service, 'skill_routing_service.js'), 'const minimumSavingRatio = 0.25;');
    await writeFile(join(service, 'reply_skill_selection.js'), 'superseded_by_available_modules');
    await writeFile(join(root, '.env'), 'SECRET_MUST_NOT_BE_READ');
    const current = await inspectReplyRuntime(root);
    assert.equal(current.activeSkillSelection, true);
    assert.equal(current.minimumSavingRatio, 0.25);
    assert.equal(current.turnMcpCache, true);
    assert.match(current.aiFingerprint, /^[a-f0-9]{16}$/);
    assert.equal(JSON.stringify(current).includes('SECRET_MUST_NOT_BE_READ'), false);
    await writeFile(join(service, 'ai_service.js'), 'old release');
    const old = await inspectReplyRuntime(root);
    assert.equal(old.activeSkillSelection, false);
    assert.equal(old.turnMcpCache, false);
    assert.notEqual(old.aiFingerprint, current.aiFingerprint);
    assert.equal((await inspectReplyRuntime(join(root, 'absent'))).unavailable, 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
