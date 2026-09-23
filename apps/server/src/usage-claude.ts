import { asArray, asString, classifyInjectedUser, isRecord, parseJsonLine, type SessionFileRef } from '@harness-trajectory/core'

/** Fork prelude is model context, not a request made by the child. */
export function claudeUsageFilter(file: SessionFileRef): (line: string) => boolean {
  let inherited = file.agent?.isFork === true
  return line => {
    const record = parseJsonLine(line)
    if (!isRecord(record)) return true
    if (record.type === 'fork-context-ref') inherited = true
    if (!inherited) return true
    if (record.type === 'assistant') return false
    if (record.type === 'user' && isRecord(record.message)) {
      const content = record.message.content
      const items = asArray(content) ?? []
      const text = typeof content === 'string' ? content : items.flatMap(item =>
        isRecord(item) && item.type === 'text' ? [asString(item.text) ?? ''] : []).join('\n')
      // Fork launch prompts include the parent's synthetic tool receipt.
      // That user record still starts the child's own work.
      if (record.isMeta !== true && record.isCompactSummary !== true && classifyInjectedUser(record, text) === null) {
        inherited = false
      }
    }
    return true
  }
}
