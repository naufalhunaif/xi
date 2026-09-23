import { evidenceKey } from '#services/evidence_cache'
import { TASK_SYSTEM_PROMPT } from '#services/ai_task_prompt'
export { TASK_SYSTEM_PROMPT } from '#services/ai_task_prompt'

/** All business policy remains in the imported skills and task prompt. */
export function claudeTaskArgs(hasImages: boolean) {
  return [
    '--system-prompt',
    TASK_SYSTEM_PROMPT,
    // allowedTools grants permissions; tools actually removes unused built-in schemas.
    '--tools',
    hasImages ? 'Read' : '',
    '--disable-slash-commands',
    '--setting-sources',
    '',
  ]
}

export function phaseAllowsHistory(phase: string) {
  return ['analysis', 'business-recheck-run', 'comparison', 'visual-recheck'].includes(phase)
}

/** No ceiling on useful work. Stop only repeated identical calls/results in one
 * provider process, without intervening new evidence. IDs are scoped per process. */
export class AiLoopGuard {
  calls = 0
  constructor(readonly maximumIdentical = 4) {}

  observer(provider: string) {
    const started = new Set<string>()
    const completed = new Set<string>()
    const pending = new Map<string, { name: string; arguments: unknown }>()
    let previous = ''
    let repetitions = 0
    const reset = () => {
      previous = ''
      repetitions = 0
    }
    const accept = (id: string, call: unknown, result: unknown) => {
      if (completed.has(id)) return true
      completed.add(id)
      if (result === undefined) {
        reset()
        return true
      }
      const fingerprint = evidenceKey([call, result])
      repetitions = fingerprint === previous ? repetitions + 1 : 1
      previous = fingerprint
      return repetitions < this.maximumIdentical
    }
    const count = (id: string) => {
      if (started.has(id)) return
      started.add(id)
      this.calls++
    }
    return (event: Record<string, any>) => {
      if (provider === 'claude') {
        for (const block of event.message?.content || []) {
          if (event.type === 'assistant' && block.type === 'tool_use' && block.id) {
            count(block.id)
            if (block.name?.startsWith('mcp__'))
              pending.set(block.id, { name: block.name, arguments: block.input || {} })
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            const call = pending.get(block.tool_use_id)
            if (!call) reset()
            if (
              call &&
              !accept(block.tool_use_id, call, {
                content: block.content,
                isError: block.is_error === true,
              })
            )
              return false
          }
        }
      } else if (
        ['item.started', 'item.completed'].includes(event.type) &&
        ['mcp_tool_call', 'web_search', 'command_execution'].includes(event.item?.type)
      ) {
        const item = event.item
        const id = item.id || (event.type === 'item.completed' ? `anonymous-${this.calls}` : '')
        if (id) count(id)
        if (event.type === 'item.completed' && item.type !== 'mcp_tool_call') reset()
        if (
          event.type === 'item.completed' &&
          item.type === 'mcp_tool_call' &&
          !accept(
            id,
            { server: item.server, name: item.tool, arguments: item.arguments || {} },
            item.result
          )
        )
          return false
      }
      return true
    }
  }
}
