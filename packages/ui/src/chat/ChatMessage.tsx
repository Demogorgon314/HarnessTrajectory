import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { asString, type AssistantBlock, type ContentBlock, type ConversationNode, type ToolCallBlock } from '@harness-trajectory/core'
import { TrajectoryImages, type MessageImageLoader } from '../images.tsx'
import { MarkdownText } from '../primitives/markdown/MarkdownText.tsx'
import { mermaidLabels } from '../primitives/markdown/MermaidBlock.tsx'
import { IconApiOutline14, IconChevronDownOutline14, IconChevronRightOutline14, IconCheckOutline16, IconCopyOutline16, IconContextInjectionOutline16 } from '../primitives/icons/index.tsx'
import { FileTypeIcon } from '../primitives/FileTypeIcon.tsx'
import { StateDot } from '../primitives/StateDot.tsx'
import { fileSizeText } from '../primitives/file-size.ts'
import { Tooltip } from '../primitives/Tooltip.tsx'
import { writeClipboard } from '../primitives/clipboard.ts'
import type { ChatLabels } from './labels.ts'
import css from './ChatView.module.css'
import messageCss from './MessageItem.module.css'
import assistantCss from './AssistantMarkdown.module.css'
import actionsCss from './MessageIconActions.module.css'
import toolCss from './ToolRow.module.css'
import tailCss from './TurnTailNodeView.module.css'
import { TerminalResult } from './TerminalResult.tsx'
import { ChatDisclosure as Disclosure } from './ChatDisclosure.tsx'
import { ToolPresentation, toolFields, toolIcon } from './ToolPresentation.tsx'
import { ChatStats, messageClock } from './ChatStats.tsx'
import contextCss from './ContextInjectionRow.module.css'

export interface ChatMessageContext {
  labels: ChatLabels
  loadImage: MessageImageLoader
  tools: ReadonlyMap<string, ToolCallBlock>
  locale: 'en' | 'zh'
  nodes: readonly ConversationNode[]
}

function Prose({ text, context, streaming = false, compact = false }: {
  text: string
  context: ChatMessageContext
  streaming?: boolean
  compact?: boolean
}) {
  const { labels } = context
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: labels.copy, copiedLabel: labels.copied },
    footnotes: labels.footnotes,
    mermaid: mermaidLabels[context.locale],
  }), [labels, context.locale])
  return <MarkdownText text={text} streaming={streaming} labels={markdownLabels} variant={compact ? 'compact' : 'body'} />
}

function Content({ blocks, context, plain = false, compactImages = false }: {
  blocks: readonly ContentBlock[]
  context: ChatMessageContext
  plain?: boolean
  compactImages?: boolean
}) {
  return <>{blocks.map((block, index) => {
    switch (block.type) {
      case 'text':
        return plain
          ? <div key={index} className={css.plain}>{block.text}</div>
          : <Prose key={index} text={block.text} context={context} />
      case 'reasoning':
        return (
          <Disclosure key={index} thinking title={context.labels.thinking} preview={block.text.split('\n')[0] ?? ''}>
            <Prose text={block.text} context={context} compact />
          </Disclosure>
        )
      case 'image':
        return (
          <TrajectoryImages key={index} images={[{ attachment: block.attachment }]}
            loadImage={context.loadImage} align={plain ? 'end' : 'start'} compact={compactImages} />
        )
      case 'file':
        return (
          <span key={index} className={messageCss.fileCard}>
            <FileTypeIcon path={block.attachment.name} className={messageCss.fileIcon} />
            <span className={messageCss.fileContent}>
              <span className={messageCss.fileName}>{block.attachment.name}</span>
              <span className={messageCss.fileMeta}>{[
                block.attachment.name.includes('.') ? block.attachment.name.split('.').at(-1)?.toUpperCase().slice(0, 8) : '',
                fileSizeText(block.attachment.bytes),
              ].filter(Boolean).join(' · ')}</span>
            </span>
          </span>
        )
      case 'tool-call':
        return <Tool key={index} id={block.id} name={block.name} args={block.arguments} context={context} />
      case 'tool-result':
        return (
          <Disclosure key={index} title={`${context.labels.output} · ${block.toolCallId}`}>
            <Content blocks={block.content} context={context} />
          </Disclosure>
        )
    }
  })}</>
}

function Tool({ id, name, args, context }: {
  id: string
  name: string
  args: string
  context: ChatMessageContext
}) {
  const tool = context.tools.get(id)
  const result = tool !== undefined && 'kind' in tool ? tool : undefined
  const { labels } = context
  let formatted = args
  const fields = toolFields(args)
  const command = asString(fields['command']) ?? asString(fields['cmd'])
  const summary = asString(fields['description']) ?? command ?? asString(fields['file_path'])
    ?? asString(fields['path']) ?? asString(fields['pattern']) ?? args
  try {
    const value: unknown = JSON.parse(args)
    formatted = JSON.stringify(value, null, 2)
  } catch { /* Streaming arguments may not be complete JSON yet. */ }
  const textOutput = result?.content.every(block => block.type === 'text') === true
    ? result.content.map(block => block.type === 'text' ? block.text : '').join('\n') : undefined
  const terminal = command !== undefined && /(?:bash|shell|exec_command|terminal)/i.test(name)
    && (result === undefined || textOutput !== undefined)
  return (
    <Disclosure callId={id} icon={toolIcon(name)} running={tool !== undefined && !('kind' in tool)} title={result?.isError ? `${name} · ${labels.failed}` : name}
      preview={summary.replace(/\s+/g, ' ')} failed={result?.isError === true}>
      {terminal && command !== undefined ? (
        <TerminalResult command={command} output={textOutput} failed={result?.isError === true} labels={labels}
          running={tool !== undefined && !('kind' in tool)} fields={fields} meta={result?.meta} />
      ) : <ToolPresentation name={name} args={args} result={result} context={context} fallback={<div className={toolCss.ioCard}>
        <div className={toolCss.ioSection}>
          <span className={toolCss.ioLabel}>IN</span>
          <span className={toolCss.ioText}>{formatted}</span>
        </div>
        {result !== undefined && <>
          <span className={toolCss.ioDivider} aria-hidden />
          <div className={toolCss.ioSection}>
            <span className={toolCss.ioLabel}>OUT</span>
            <div className={toolCss.ioText} data-error={result.isError || undefined}>
              <Content blocks={result.content} context={context} plain />
            </div>
          </div>
        </>}
      </div>} />}
      <div>
        {tool?.subCalls.map(child => (
          <Tool key={child.callId} id={child.callId}
            name={'kind' in child ? child.call?.name ?? child.callId : child.name}
            args={'kind' in child ? child.call?.argsRaw ?? '' : child.argsRaw} context={context} />
        ))}
      </div>
    </Disclosure>
  )
}

export function AssistantContent({ blocks, context, streaming = false }: {
  blocks: readonly AssistantBlock[]
  context: ChatMessageContext
  streaming?: boolean
}) {
  return (
    <div className={assistantCss.root}>
      <div className={assistantCss.body}>
        {blocks.map((block, index) => {
          switch (block.kind) {
            case 'text':
              return <Prose key={index} text={block.text} streaming={streaming} context={context} />
            case 'reasoning':
              return (
                <Disclosure key={index} thinking running={streaming && index === blocks.length - 1} title={context.labels.thinking}
                  preview={streaming && index === blocks.length - 1 ? block.text.trimEnd().split('\n').at(-1) : block.text.split('\n')[0]}>
                  <Prose text={block.text} streaming={streaming} context={context} compact />
                </Disclosure>
              )
            case 'image':
              if (blocks[index - 1]?.kind === 'image') return null
              const images = []
              for (let cursor = index; cursor < blocks.length; cursor++) {
                const image = blocks[cursor]
                if (image?.kind !== 'image') break
                images.push({ attachment: image.attachment })
              }
              return (
                <TrajectoryImages key={index} images={images}
                  loadImage={context.loadImage} align="start" />
              )
            case 'tool-call':
              return <Tool key={block.callId} id={block.callId} name={block.name} args={block.argsRaw} context={context} />
            case 'other':
              return (
                <Disclosure key={index} title="JSON">
                  <pre className={css.raw}>{JSON.stringify(block.block, null, 2)}</pre>
                </Disclosure>
              )
          }
        })}
      </div>
    </div>
  )
}

function MessageBody({ node, context, hideReasoning }: { node: ConversationNode; context: ChatMessageContext; hideReasoning: boolean }): ReactNode {
  const { labels } = context
  switch (node.kind) {
    case 'user':
    case 'steering':
      const attachments = node.content.filter(block => block.type === 'image' || block.type === 'file')
      const content = node.content.filter(block => block.type !== 'image' && block.type !== 'file')
      return (
        <div className={messageCss.userStack}>
          {attachments.length > 0 && <div className={messageCss.attachmentRow}>
            <Content blocks={attachments} context={context} plain compactImages={attachments.length > 1} />
          </div>}
          {content.length > 0 && <div className={messageCss.bubble}><Content blocks={content} context={context} plain /></div>}
        </div>
      )
    case 'assistant':
      return (
        <>
          <AssistantContent blocks={hideReasoning ? node.blocks.filter(block => block.kind !== 'reasoning') : node.blocks} context={context} />
          {node.interrupted && <span className={assistantCss.stopped}>{labels.interrupted}</span>}
        </>
      )
    case 'tool-result':
      return <Tool id={node.callId} name={node.call?.name ?? node.callId} args={node.call?.argsRaw ?? ''} context={context} />
    case 'context':
      return (
        <Disclosure title={node.provenance.role === 'recall' ? (context.locale === 'zh' ? '回忆' : 'Recall') : labels.context}
          icon={<IconContextInjectionOutline16 />} preview={node.provenance.label ?? node.form ?? undefined} bodyClassName={contextCss.body}>
          <Content blocks={node.content} context={context} plain />
        </Disclosure>
      )
    case 'compaction':
      return (
        <Compaction node={node} context={context} />
      )
    case 'model-retry':
      return (
        <details className={messageCss.retryRow}>
          <summary className={messageCss.retrySummary}><span className={messageCss.retryText}>
            {labels.retry} {node.retry}/{node.maxRetries} · {node.retryState}
          </span></summary>
          <div className={messageCss.retryDetails}>
            <span>{node.failure.message}</span><code>{node.failure.code}</code>
            <span>{node.provider}{node.delayMs === undefined ? '' : ` · ${node.delayMs / 1000}s`}</span>
          </div>
        </details>
      )
    case 'turn-error':
      return <div className={messageCss.turnErrorRow} role="status">
        <StateDot state="error" className={messageCss.turnErrorDot} />
        <div className={messageCss.turnErrorCopy}><span className={messageCss.turnErrorTitle}>{labels.failed}</span>
          <span className={messageCss.turnErrorMessage}>{node.message}</span></div>
        {node.code !== undefined && <code className={messageCss.turnErrorCode}>{node.code}</code>}
      </div>
    case 'turn-max-tokens':
      return <div className={messageCss.turnErrorRow} role="status"><StateDot state="warning" className={messageCss.turnErrorDot} />
        <span className={messageCss.maxTokensTitle}>{labels.limit}</span></div>
    case 'command':
      return (
        <Disclosure title={`/${node.name ?? node.commandId} ${node.args ?? ''}`}>
          <pre className={css.raw}>{node.outcome?.text}</pre>
        </Disclosure>
      )
    case 'unknown':
      return (
        <Disclosure title={node.type}>
          <pre className={css.raw}>{JSON.stringify(node.data, null, 2)}</pre>
        </Disclosure>
      )
  }
}

export const ChatMessage = memo(function ChatMessage({ node, context, showActions = true, hideReasoning = false }: {
  node: ConversationNode
  context: ChatMessageContext
  showActions?: boolean
  hideReasoning?: boolean
}) {
  const [copyState, setCopyState] = useState<'copy' | 'copied' | 'copyFailed'>('copy')
  useEffect(() => {
    if (copyState === 'copy') return
    const timer = setTimeout(() => { setCopyState('copy') }, 1000)
    return () => { clearTimeout(timer) }
  }, [copyState])
  const user = node.kind === 'user' || node.kind === 'steering'
  const text = node.kind === 'assistant'
    ? node.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n\n')
    : user ? node.content.filter(block => block.type === 'text').map(block => block.text).join('\n\n') : ''
  const date = new Date(node.time)
  const clock = <time className={user ? actionsCss.timeStart : actionsCss.timeEnd} dateTime={date.toISOString()}>
    {messageClock(node.time, context.locale)}
  </time>
  return (
    <div className={user ? messageCss.userRow : undefined}>
      <MessageBody node={node} context={context} hideReasoning={hideReasoning} />
      {showActions && (user || node.kind === 'assistant') && (
        <div className={user ? undefined : css.assistantTail}>
        <footer className={`${actionsCss.actions} ${user ? '' : tailCss.actions}`}>
          {user && clock}
          {text !== '' && <Tooltip label={context.labels[copyState]} side="bottom">
          <button type="button" className={actionsCss.action}
            aria-label={context.labels[copyState]} title={context.labels[copyState]}
            onClick={() => {
              void writeClipboard(text).then(ok => { setCopyState(ok ? 'copied' : 'copyFailed') })
            }}>
            {copyState === 'copied' ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
          </button>
          </Tooltip>}
          {node.kind === 'assistant' && <ChatStats node={node} context={context} />}
          {!user && clock}
        </footer>
        </div>
      )}
    </div>
  )
})

function Compaction({ node, context }: { node: Extract<ConversationNode, { kind: 'compaction' }>; context: ChatMessageContext }) {
  const [open, setOpen] = useState(false)
  return <div className={messageCss.compactionRow}>
    <button type="button" data-chat-disclosure className={messageCss.compactionButton} disabled={node.summary === null}
      aria-expanded={open} onClick={() => { setOpen(!open) }}>
      <span className={messageCss.compactionLeading} aria-hidden>
        <span className={messageCss.compactionContextIcon}><IconApiOutline14 /></span>
        <span className={messageCss.compactionDisclosureIcon}>{open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}</span>
      </span>
      <span className={messageCss.compactionTitle}>{context.labels.compaction}</span>
      <span className={messageCss.compactionSep} />
      <span className={messageCss.compactionSummary}>{node.shadowedItemCount !== null && node.shadowedTokenCount !== null
        ? `${node.shadowedItemCount} ${context.locale === 'zh' ? '条记录' : 'records'} · ${node.shadowedTokenCount} tokens`
        : node.summary === null ? (context.locale === 'zh' ? '摘要不可用' : 'Summary unavailable') : (context.locale === 'zh' ? '展开摘要' : 'Show summary')}</span>
    </button>
    {open && <div className={messageCss.compactionBody}><Prose text={node.summary ?? ''} context={context} compact /></div>}
  </div>
}
