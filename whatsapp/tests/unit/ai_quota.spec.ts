import { test } from '@japa/runner'
import {
  codexQuotaWindows,
  claudeQuotaWindows,
  quotaPresentation,
} from '#services/ai_quota_contract'
import { readCodexQuota } from '#services/codex_quota_reader'

const now = 1_800_000_000_000
test.group('Account quota telemetry', () => {
  test('reads Codex windows separately, preferring multi-bucket data without duplicates', ({
    assert,
  }) => {
    const bucket = {
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      secondary: { usedPercent: 90, windowDurationMins: 10080 },
    }
    const data = codexQuotaWindows(
      {
        rateLimits: bucket,
        rateLimitsByLimitId: { codex: bucket, premium: { primary: { usedPercent: 100 } } },
      },
      now
    )
    assert.lengthOf(data, 3)
    assert.deepEqual(
      quotaPresentation(data, now).map((w) => w.remainingPercent),
      [75, 10, 0]
    )
    assert.isNull(data[1].resetsAt)
  })
  test('missing, invalid or token/context fields never become a fabricated percentage', ({
    assert,
  }) => {
    assert.deepEqual(codexQuotaWindows({ usage: { input_tokens: 1000 } }), [])
    for (const usedPercent of [null, undefined, '25', -1, NaN, Infinity]) {
      const data = codexQuotaWindows({ rateLimits: { primary: { usedPercent } } }, now)
      assert.isNull(quotaPresentation(data, now)[0].remainingPercent)
    }
    assert.deepEqual(
      claudeQuotaWindows({
        type: 'result',
        usage: { input_tokens: 100 },
        context_window: { used_percentage: 25 },
      }),
      []
    )
  })
  test('Claude uses fractional utilization, retaining all reported windows', ({ assert }) => {
    const data = claudeQuotaWindows(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          rateLimitType: 'seven_day',
          utilization: 0.9,
          resetsAt: now / 1000 + 3600,
          unifiedWindows: {
            five_hour: { utilization: 0.25, resetsAt: now / 1000 + 3600 },
            seven_day: { utilization: 0.9 },
          },
        },
      },
      now
    )
    assert.lengthOf(data, 2)
    assert.deepEqual(
      quotaPresentation(data, now).map((w) => w.remainingPercent),
      [75, 10]
    )
    assert.equal(data[1].status, 'allowed_warning')
    assert.deepEqual(
      claudeQuotaWindows({
        type: 'rate_limit_event',
        rate_limit_info: { rateLimitType: 'unknown' },
      }),
      []
    )
  })
  test('rejection without utilization stays unknown; resets never assume 100% remaining', ({
    assert,
  }) => {
    const data = claudeQuotaWindows(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: now / 1000 + 1,
        },
      },
      now
    )
    assert.isNull(quotaPresentation(data, now)[0].remainingPercent)
    assert.equal(data[0].status, 'rejected')
    data[0].usedPercent = 100
    assert.equal(quotaPresentation(data, now)[0].remainingPercent, 0)
    const expired = quotaPresentation(data, now + 1000)[0]
    assert.isTrue(expired.expired)
    assert.isNull(expired.remainingPercent)
    assert.isTrue(quotaPresentation(data, now + 600_000)[0].stale)
  })
  test('supports older Claude single windows and clamps legitimate over-cap usage', ({
    assert,
  }) => {
    const data = claudeQuotaWindows(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rate_limit_type: 'seven_day_opus',
          utilization: 1.1,
          resets_at: now / 1000 + 3600,
        },
      },
      now
    )
    assert.equal(data[0].minutes, 10080)
    assert.equal(quotaPresentation(data, now)[0].remainingPercent, 0)
  })
  test('Codex reader performs only initialization and account metadata read', async ({
    assert,
  }) => {
    const fake = `
      const readline = require('node:readline');
      const methods = [];
      readline.createInterface({input:process.stdin}).on('line', line => {
        const msg=JSON.parse(line); methods.push(msg.method);
        if(msg.method==='initialize') process.stdout.write('null\\nnoise\\n'+JSON.stringify({id:0,result:{}})+'\\n');
        if(msg.method==='account/rateLimits/read') process.stdout.write(JSON.stringify({id:1,result:{methods,rateLimits:{primary:{usedPercent:25}}}})+'\\n');
        if(!['initialize','initialized','account/rateLimits/read'].includes(msg.method)) process.exit(5);
      });`
    const result: any = await readCodexQuota(
      process.execPath,
      ['-e', fake],
      { PATH: process.env.PATH },
      2000
    )
    assert.deepEqual(result.methods, ['initialize', 'initialized', 'account/rateLimits/read'])
    assert.equal(codexQuotaWindows(result)[0].usedPercent, 25)
  })
  test('reader bounds timeout and redacts provider errors', async ({ assert }) => {
    for (const script of [
      'setInterval(()=>{},1000)',
      `process.stdout.write(JSON.stringify({id:0,error:{message:'SECRET_TOKEN'}})+'\\n');setInterval(()=>{},1000)`,
    ]) {
      try {
        await readCodexQuota(process.execPath, ['-e', script], {}, 150)
        assert.fail('Expected bounded failure')
      } catch (error) {
        assert.equal((error as Error).message, 'QUOTA_UNAVAILABLE')
      }
    }
  })
})
