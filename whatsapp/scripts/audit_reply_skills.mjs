// Read-only local audit. Run from whatsapp/ with:
// node --import=@poppinss/ts-exec scripts/audit_reply_skills.mjs /path/to/skills
// Reports sizes and selection metadata only; never prints private skill contents.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { selectReplySkills, selectEvaluationSkills } from '../app/services/reply_skill_selection.ts'
import { planSkillRouting } from '../app/services/skill_routing_service.ts'
import { importedSkillInstructions } from '../app/services/skill_runtime_service.ts'
import { estimateTokens } from '../app/services/prompt_size_service.ts'
import { planIndexReply } from '../app/services/index_reply.ts'
import { planConversationLevel } from '../app/services/conversation_levels.ts'

const directory = process.argv[2]
if (!directory) throw new Error('Pass the directory containing exported .md skills')
const files = (await readdir(directory)).filter((name) => name.endsWith('.md')).sort()
const skills = await Promise.all(
  files.map(async (file) => {
    const content = await readFile(join(directory, file), 'utf8')
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
    const name = frontmatter?.match(/^name:\s*["']?([\w-]+)["']?\s*$/m)?.[1] || file.slice(0, -3)
    return { name, content }
  })
)
const active = selectReplySkills(skills)
const before = importedSkillInstructions(skills).length
const after = importedSkillInstructions(active.skills).length
const evaluation = selectEvaluationSkills(skills)
const evaluationChars = importedSkillInstructions(evaluation.skills).length
const indexPlan = planIndexReply(
  active.skills,
  {
    hasCart: false,
    indexContext: 'Fixture: sapaan baru, tidak ada pesanan, cart atau kebutuhan tertunda.',
    activeState: {
      currentText: 'Halo bos',
      currentMessageCount: 1,
      hasMedia: false,
      hasQuote: false,
      cartVersion: 'fixture',
      cartItems: 0,
      orderCount: 0,
      pendingMemory: false,
      lastMessageId: '',
      lastMessageDigest: '',
      lastSender: '',
      previousExternalId: 0,
      lastQuestion: '',
      waitingFor: '',
      checkpoint: null,
    },
  },
  'Halo bos'
)
const scenarios = [
  ['catalog', 'Berapa harga jas?'],
  ['visual', 'Foto referensi jas ini'],
  ['checkout', 'Saya mau checkout pesanan'],
  ['ambiguous', 'iya yang itu'],
  ['cart-followup', 'Sama'],
].map(([scenario, text]) => {
  const context = scenario === 'cart-followup' ? {
    hasCart: true,
    lastQuestion: 'Atas nama siapa bos?',
    waitingFor: 'Nama penerima',
    activeState: {
      currentText: text, currentMessageCount: 1, cartItems: 2,
      lastQuestion: 'Atas nama siapa bos?', waitingFor: 'Nama penerima',
    },
  } : undefined
  const level = planConversationLevel(text, context?.activeState)
  const plan = planSkillRouting(active.skills, text, undefined, scenario === 'visual')
  const cachedPlan = planSkillRouting(
    active.skills,
    text,
    context,
    scenario === 'visual',
    level.level === 4,
    level.indices,
    false,
    true
  )
  return {
    scenario,
    ...plan.detail,
    estimatedSkillPromptTokens: estimateTokens(plan.detail.charsAfter),
    patternPlan: {
      ...cachedPlan.detail,
      estimatedSkillPromptTokens: estimateTokens(cachedPlan.detail.charsAfter),
    },
  }
})
console.log(
  JSON.stringify(
    {
      estimated: true,
      scope:
        'Skill instructions only; excludes conversation, output schema, other app rules, MCP schemas and provider rounds.',
      ...active.detail,
      before: { chars: before, estimatedTokens: estimateTokens(before) },
      fullActive: { chars: after, estimatedTokens: estimateTokens(after) },
      evaluation: {
        ...evaluation.detail,
        chars: evaluationChars,
        estimatedTokens: estimateTokens(evaluationChars),
        reductionPercent: Math.round((1 - evaluationChars / before) * 1000) / 10,
        scope:
          'Complete active business policy and evaluation rubric. Excludes snapshot, schema, provider overhead and rounds.',
      },
      indexReply: indexPlan
        ? {
            chars: indexPlan.characters,
            estimatedTokens: estimateTokens(indexPlan.characters),
            scope:
              'Includes original selected rules, tiny fixture context, output schema and task system prompt; no MCP schemas. Real conversation changes this estimate.',
            businessTools: 0,
            mutatingOutputFields: 0,
          }
        : {
            eligible: false,
            reason: 'Input exceeds bounded index profile; rules are not truncated.',
          },
      reductionPercent: Math.round((1 - after / before) * 1000) / 10,
      scenarios,
    },
    null,
    2
  )
)
