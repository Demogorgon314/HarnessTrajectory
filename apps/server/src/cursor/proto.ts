/**
 * Minimal protobuf wire decoder for a Cursor Agent root blob.
 *
 * The root and the turn chain are decoded. Length-delimited
 * fields stay bytes; the walkers interpret the ones they know. A truncated
 * buffer, a group (wire type 3 or 4), or a varint that does not fit in a safe
 * integer fails the whole buffer. The function never throws: malformed input
 * is `undefined`, and an empty buffer is `[]`.
 */

export interface ProtoField {
  field: number
  varint?: number
  bytes?: Uint8Array
}

export interface CursorUsageBucket {
  key: string
  label: string
  tokens: number
  chars: number
}

export interface CursorRootUsage {
  used: number
  window: number
  buckets: CursorUsageBucket[]
}

export interface CursorRoot {
  /** Hex SHA-256 ids of model-message blobs, in root order. */
  messageIds: string[]
  usage?: CursorRootUsage
  workspaceUri?: string
  repo?: string
  branch?: string
  client?: string
  /** Epoch milliseconds. */
  createdAt?: number
  timezone?: string
  ruleFiles: string[]
  /** Hex ids of field-8 turn-chain nodes, in turn order. */
  turnIds: string[]
}

/** A turn chain node after the nested prompt and item blobs are still refs. */
export interface CursorTurnSkeleton {
  requestId?: string
  /** Hex id of the user-prompt blob. */
  promptId?: string
  /** Hex ids of item blobs, in UI order. */
  itemIds: string[]
  toolNames: string[]
}

export interface CursorUserPrompt {
  text?: string
  /** Field 25, epoch milliseconds. */
  time?: number
  /** Field 26, epoch milliseconds. */
  end?: number
}

export interface CursorThinkingItem {
  kind: 'thinking'
  text?: string
  tokens?: number
  start?: number
  end?: number
}

export interface CursorTextItem {
  kind: 'text'
  text?: string
  start?: number
  end?: number
}

export interface CursorToolItem {
  kind: 'tool'
  toolCallId: string
  start?: number
  end?: number
}

export type CursorTurnItem = CursorThinkingItem | CursorTextItem | CursorToolItem

interface Varint {
  value: number
  next: number
}

function readVarint(buf: Uint8Array, offset: number): Varint | undefined {
  let value = 0
  let shift = 0
  let index = offset
  while (index < buf.length && shift <= 49) {
    const byte = buf[index]
    if (byte === undefined) return undefined
    index += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) return undefined
      return { value, next: index }
    }
    shift += 7
  }
  return undefined
}

/** Decode one protobuf message. `undefined` when the buffer is malformed. */
export function decodeFields(buf: Uint8Array): ProtoField[] | undefined {
  if (buf.length === 0) return []
  const fields: ProtoField[] = []
  let index = 0
  while (index < buf.length) {
    const key = readVarint(buf, index)
    if (key === undefined) return undefined
    index = key.next
    const field = Math.floor(key.value / 8)
    const wire = key.value % 8
    if (field <= 0) return undefined
    if (wire === 0) {
      const value = readVarint(buf, index)
      if (value === undefined) return undefined
      index = value.next
      fields.push({ field, varint: value.value })
    } else if (wire === 1) {
      if (index + 8 > buf.length) return undefined
      index += 8
    } else if (wire === 2) {
      const length = readVarint(buf, index)
      if (length === undefined) return undefined
      index = length.next
      if (length.value > buf.length - index) return undefined
      const bytes = buf.subarray(index, index + length.value)
      index += length.value
      fields.push({ field, bytes })
    } else if (wire === 5) {
      if (index + 4 > buf.length) return undefined
      index += 4
    } else {
      // Groups (3, 4) and unknown wire types cannot be skipped safely.
      return undefined
    }
  }
  return fields
}

function hexOf(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]
    if (byte === undefined) return out
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function fieldString(field: ProtoField): string | undefined {
  return field.bytes === undefined ? undefined : utf8(field.bytes)
}

function decodeBucket(bytes: Uint8Array): CursorUsageBucket | undefined {
  const fields = decodeFields(bytes)
  if (fields === undefined) return undefined
  let key: string | undefined
  let label: string | undefined
  let tokens = 0
  let chars = 0
  for (const field of fields) {
    if (field.field === 1) key = fieldString(field) ?? key
    else if (field.field === 2) label = fieldString(field) ?? label
    else if (field.field === 3 && field.varint !== undefined) tokens = field.varint
    else if (field.field === 4 && field.varint !== undefined) chars = field.varint
  }
  if (key === undefined || key === '') return undefined
  return { key, label: label ?? key, tokens, chars }
}

function decodeUsage(bytes: Uint8Array): CursorRootUsage | undefined {
  const fields = decodeFields(bytes)
  if (fields === undefined) return undefined
  let used: number | undefined
  let window: number | undefined
  const buckets: CursorUsageBucket[] = []
  for (const field of fields) {
    if (field.field === 1 && field.varint !== undefined) used = field.varint
    else if (field.field === 2 && field.varint !== undefined) window = field.varint
    else if (field.field === 3 && field.bytes !== undefined) {
      const inner = decodeFields(field.bytes)
      if (inner === undefined) continue
      for (const part of inner) {
        if (part.field !== 3 || part.bytes === undefined) continue
        const bucket = decodeBucket(part.bytes)
        if (bucket !== undefined) buckets.push(bucket)
      }
    }
  }
  if (used === undefined && window === undefined && buckets.length === 0) return undefined
  return { used: used ?? 0, window: window ?? 0, buckets }
}

function emptyRoot(): CursorRoot {
  return { messageIds: [], ruleFiles: [], turnIds: [] }
}

function idOf(field: ProtoField): string | undefined {
  return field.bytes !== undefined && field.bytes.length === 32 ? hexOf(field.bytes) : undefined
}

function varintOf(field: ProtoField): number | undefined {
  return field.varint
}

/** Decode a root blob. Malformed input yields an empty root and never throws. */
export function decodeRoot(bytes: Uint8Array): CursorRoot {
  try {
    const fields = decodeFields(bytes)
    if (fields === undefined) return emptyRoot()
    const messageIds: string[] = []
    const ruleFiles: string[] = []
    let usage: CursorRootUsage | undefined
    let workspaceUri: string | undefined
    let repo: string | undefined
    let branch: string | undefined
    let client: string | undefined
    let createdAt: number | undefined
    let timezone: string | undefined
    const turnIds: string[] = []
    for (const field of fields) {
      if (field.field === 1 && field.bytes !== undefined && field.bytes.length === 32) {
        messageIds.push(hexOf(field.bytes))
      } else if (field.field === 8) {
        const id = idOf(field)
        if (id !== undefined) turnIds.push(id)
      } else if (field.field === 5 && field.bytes !== undefined) {
        usage = decodeUsage(field.bytes) ?? usage
      } else if (field.field === 9) {
        workspaceUri = fieldString(field) ?? workspaceUri
      } else if (field.field === 18) {
        const rule = fieldString(field)
        if (rule !== undefined && rule !== '') ruleFiles.push(rule)
      } else if (field.field === 21 && field.bytes !== undefined) {
        const repoFields = decodeFields(field.bytes)
        if (repoFields === undefined) continue
        for (const part of repoFields) {
          if (part.field === 1) repo = fieldString(part) ?? repo
          else if (part.field === 2) branch = fieldString(part) ?? branch
        }
      } else if (field.field === 22) {
        client = fieldString(field) ?? client
      } else if (field.field === 26 && field.varint !== undefined) {
        createdAt = field.varint
      } else if (field.field === 27) {
        timezone = fieldString(field) ?? timezone
      }
    }
    return {
      messageIds,
      ruleFiles,
      turnIds,
      ...(usage === undefined ? {} : { usage }),
      ...(workspaceUri === undefined ? {} : { workspaceUri }),
      ...(repo === undefined ? {} : { repo }),
      ...(branch === undefined ? {} : { branch }),
      ...(client === undefined ? {} : { client }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(timezone === undefined ? {} : { timezone }),
    }
  } catch {
    return emptyRoot()
  }
}

function turnFrom(fields: readonly ProtoField[]): CursorTurnSkeleton {
  let requestId: string | undefined
  let promptId: string | undefined
  const itemIds: string[] = []
  const toolNames: string[] = []
  for (const field of fields) {
    if (field.field === 1) promptId = idOf(field) ?? promptId
    else if (field.field === 2) {
      const id = idOf(field)
      if (id !== undefined) itemIds.push(id)
    } else if (field.field === 3) requestId = fieldString(field) ?? requestId
    else if (field.field === 9) {
      const name = fieldString(field)
      if (name !== undefined && name !== '') toolNames.push(name)
    }
  }
  return {
    itemIds,
    toolNames,
    ...(requestId === undefined || requestId === '' ? {} : { requestId }),
    ...(promptId === undefined ? {} : { promptId }),
  }
}

/**
 * Decode one field-8 blob. It is a chain node `{1: turn}`; a blob that is
 * already the turn (field 1 is a 32-byte prompt ref) is accepted too.
 * Malformed input is `undefined`.
 */
export function decodeTurn(bytes: Uint8Array): CursorTurnSkeleton | undefined {
  try {
    const fields = decodeFields(bytes)
    if (fields === undefined) return undefined
    const nested = fields.find(field =>
      field.field === 1 && field.bytes !== undefined && field.bytes.length !== 32)
    if (nested?.bytes !== undefined) {
      const inner = decodeFields(nested.bytes)
      if (inner === undefined) return undefined
      return turnFrom(inner)
    }
    return turnFrom(fields)
  } catch {
    return undefined
  }
}

/** User-prompt node. Field 25 is the prompt's epoch milliseconds. */
export function decodeUserPrompt(bytes: Uint8Array): CursorUserPrompt | undefined {
  try {
    const fields = decodeFields(bytes)
    if (fields === undefined) return undefined
    let text: string | undefined
    let time: number | undefined
    let end: number | undefined
    for (const field of fields) {
      if (field.field === 1) text = fieldString(field) ?? text
      else if (field.field === 25) time = varintOf(field) ?? time
      else if (field.field === 26) end = varintOf(field) ?? end
    }
    if (text === undefined && time === undefined && end === undefined) return undefined
    return {
      ...(text === undefined ? {} : { text }),
      ...(time === undefined ? {} : { time }),
      ...(end === undefined ? {} : { end }),
    }
  } catch {
    return undefined
  }
}

function thinkingOf(bytes: Uint8Array): CursorThinkingItem | undefined {
  const fields = decodeFields(bytes)
  if (fields === undefined) return undefined
  let text: string | undefined
  let tokens: number | undefined
  let start: number | undefined
  let end: number | undefined
  for (const field of fields) {
    if (field.field === 1) text = fieldString(field) ?? text
    else if (field.field === 2) tokens = varintOf(field) ?? tokens
    else if (field.field === 3) start = varintOf(field) ?? start
    else if (field.field === 4) end = varintOf(field) ?? end
  }
  if (text === undefined && tokens === undefined && start === undefined && end === undefined) return undefined
  return {
    kind: 'thinking',
    ...(text === undefined ? {} : { text }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  }
}

function textItemOf(bytes: Uint8Array): CursorTextItem | undefined {
  const fields = decodeFields(bytes)
  if (fields === undefined) return undefined
  let text: string | undefined
  let start: number | undefined
  let end: number | undefined
  for (const field of fields) {
    if (field.field === 1) text = fieldString(field) ?? text
    else if (field.field === 2) start = varintOf(field) ?? start
    else if (field.field === 3) end = varintOf(field) ?? end
  }
  if (text === undefined && start === undefined && end === undefined) return undefined
  return {
    kind: 'text',
    ...(text === undefined ? {} : { text }),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  }
}

function toolItemOf(bytes: Uint8Array): CursorToolItem | undefined {
  const fields = decodeFields(bytes)
  if (fields === undefined) return undefined
  let toolCallId: string | undefined
  let start: number | undefined
  let end: number | undefined
  const take = (list: readonly ProtoField[]): void => {
    for (const field of list) {
      if (field.field === 57) toolCallId = fieldString(field) ?? toolCallId
      else if (field.field === 59) start = varintOf(field) ?? start
      else if (field.field === 60) end = varintOf(field) ?? end
    }
  }
  take(fields)
  if (toolCallId === undefined) {
    for (const field of fields) {
      if (field.bytes === undefined) continue
      const nested = decodeFields(field.bytes)
      if (nested !== undefined) take(nested)
      if (toolCallId !== undefined) break
    }
  }
  if (toolCallId === undefined || toolCallId === '') return undefined
  return {
    kind: 'tool',
    toolCallId,
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
  }
}

/**
 * One turn item. Field 3 is thinking, field 1 is assistant text, field 2 is
 * a tool call. Any other shape is ignored (`undefined`). Never throws.
 */
export function decodeItem(bytes: Uint8Array): CursorTurnItem | undefined {
  try {
    const fields = decodeFields(bytes)
    if (fields === undefined) return undefined
    const tool = fields.find(field => field.field === 2 && field.bytes !== undefined)
    if (tool?.bytes !== undefined) return toolItemOf(tool.bytes)
    const thinking = fields.find(field => field.field === 3 && field.bytes !== undefined)
    if (thinking?.bytes !== undefined) return thinkingOf(thinking.bytes)
    const text = fields.find(field => field.field === 1 && field.bytes !== undefined)
    if (text?.bytes !== undefined) return textItemOf(text.bytes)
    return undefined
  } catch {
    return undefined
  }
}
