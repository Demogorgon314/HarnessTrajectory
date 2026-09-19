import type { ReactNode } from 'react'
import { asNumber, asString, isRecord, type ToolResultNode } from '@harness-trajectory/core'
import { ReadBlock } from '../primitives/ReadBlock.tsx'
import { DiffBlock } from '../primitives/DiffBlock.tsx'
import { SearchBlock, type SearchFileGroup } from '../primitives/SearchBlock.tsx'
import { IconCodeOutline16, IconEditOutline16, IconSearchOutline16 } from '../primitives/icons/index.tsx'
import { FileTypeIcon } from '../primitives/FileTypeIcon.tsx'
import type { ChatMessageContext } from './ChatMessage.tsx'
import css from './ToolRow.module.css'
import viewerCss from './ChatView.module.css'

export function toolFields(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch { return {} }
}

function toolKind(name: string) {
  const short = name.toLowerCase().split('.').at(-1)
  if (short === 'read' || short === 'read_file') return 'read'
  if (short === 'edit' || short === 'edit_file' || short === 'write' || short === 'write_file') return 'edit'
  if (short === 'grep' || short === 'glob' || short === 'search') return 'search'
  return 'other'
}

export function toolIcon(name: string) {
  switch (toolKind(name)) {
    case 'read': return <FileTypeIcon kind="other" />
    case 'edit': return <IconEditOutline16 />
    case 'search': return <IconSearchOutline16 />
    default: return <IconCodeOutline16 />
  }
}

/** Only project recognized, lossless shapes into rich cards. Tool output may be
 * arbitrary prose (including errors), so ambiguous records retain the IN/OUT view.
 */
export function ToolPresentation({ name, args, result, context, fallback }: {
  name: string; args: string; result: ToolResultNode | undefined; context: ChatMessageContext; fallback: ReactNode
}) {
  const fields = toolFields(args)
  const path = asString(fields['file_path']) ?? asString(fields['path'])
  const kind = toolKind(name)
  const zh = context.locale === 'zh'
  const expand = (count: number) => zh ? `展开 ${count} 行` : `Show ${count} more lines`
  const collapse = zh ? '收起' : 'Collapse'
  const labels = { copy: context.labels.copy, copied: context.labels.copied, collapse, collapseAria: collapse, expand, expandAria: expand }
  if (kind === 'edit' && path !== undefined && result?.isError !== true) {
    const oldText = asString(fields['old_string']) ?? asString(fields['oldText'])
    const newText = asString(fields['new_string']) ?? asString(fields['newText'])
    // Arguments describe intent, not an applied edit. Keep the complete record
    // alongside the preview, including skipped replacements and non-text output.
    if (oldText !== undefined && newText !== undefined) return <>
      <div className={viewerCss.caption}>{zh ? '请求的修改' : 'Requested change'}</div>
      <DiffBlock diffs={[{ path, oldText, newText }]} maxLines={9} className={css.diffBody}
        labels={{ ...labels, files: count => zh ? `${count} 个文件` : `${count} files` }} />
      {fallback}
    </>
  }
  if (result === undefined || result.isError || !result.content.every(block => block.type === 'text')) return fallback
  const output = result.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  const meta = isRecord(result.meta) ? result.meta : {}
  const rows = output.trimEnd().split('\n')
  if (kind === 'read' && path !== undefined) {
    const total = asNumber(meta['totalLines'])
    const recordedLines = meta['lines']
    if (total !== undefined && Number.isInteger(total) && total >= 0 && Array.isArray(recordedLines)
      && recordedLines.every((line): line is { number: number; text: string } => isRecord(line)
        && typeof line['number'] === 'number' && Number.isInteger(line['number']) && line['number'] > 0
        && line['number'] <= total && typeof line['text'] === 'string')) {
      return <ReadBlock label={path} lines={recordedLines} totalLines={total} lang={asString(meta['lang'])}
        maxLines={8} className={css.readBody} labels={{ ...labels, window: (shown, total) => `${shown} / ${total}` }} />
    }
    // Claude's numbered read window is unambiguous. Do not number unstructured
    // prose or an error response as if it were file content.
    const lines = rows.map(row => /^(?:\s*)(\d+)(?:→|\t|\| ?)(.*)$/.exec(row))
    if (lines.length > 0 && lines.every(line => line !== null)) {
      const numbered = lines.flatMap(line => line === null ? [] : [{ number: Number(line[1]), text: line[2] ?? '' }])
      return <ReadBlock label={path} lines={numbered} totalLines={numbered.length} lang={path.split('.').at(-1)}
        maxLines={8} className={css.readBody} labels={{ ...labels, window: (shown, total) => `${shown} / ${total}` }} />
    }
  }
  if (kind === 'search') {
    const searchLabels = { ...labels, noResults: zh ? '无匹配结果' : 'No results',
      pathsSummary: (shown: number) => zh ? `${shown} 个文件` : `${shown} files`,
      matchesSummary: (shown: number, _total: number, files: number) => zh ? `${files} 个文件中 ${shown} 处匹配` : `${shown} matches in ${files} files` }
    const matches = rows.map(row => /^(.+?):(\d+):(.*)$/.exec(row))
    if (matches.every(match => match !== null)) {
      const files = new Map<string, SearchFileGroup>()
      for (const match of matches) {
        if (match === null || match[1] === undefined) continue
        const group = files.get(match[1]) ?? { path: match[1], matches: [] }
        group.matches.push({ lineNumber: Number(match[2]), line: match[3] ?? '' })
        files.set(group.path, group)
      }
      return <SearchBlock kind="matches" files={[...files.values()]} total={matches.length} truncated={false}
        labels={searchLabels} className={css.searchBody} maxLines={8} />
    }
    // Glob's explicit JSON string array is safe to present as paths; free-form
    // output can also contain truncation notices, so leave it intact as fallback.
    try {
      const paths: unknown = JSON.parse(output)
      if (Array.isArray(paths) && paths.every((path): path is string => typeof path === 'string')) return <SearchBlock
        kind="paths" paths={paths} total={paths.length} truncated={false} labels={searchLabels} className={css.searchBody} maxLines={8} />
    } catch { /* Plain-text output remains readable in the generic card. */ }
  }
  return fallback
}
