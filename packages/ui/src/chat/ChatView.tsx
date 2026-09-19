import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TrajectorySnapshot } from '@harness-trajectory/core'
import type { MessageImageLoader } from '../images.tsx'
import { AssistantContent, ChatMessage } from './ChatMessage.tsx'
import { buildChatModel, chatTargetRow } from './model.ts'
import { chatLabels } from './labels.ts'
import css from './ChatView.module.css'
import conversationCss from './Conversation.module.css'
import processCss from './TurnProcessNodeView.module.css'
import { IconChevronDownOutline14 } from '../primitives/icons/index.tsx'
import { chatFlow } from './flow.ts'

export interface ChatInspectLine { line: number; fileId?: string }

export interface ChatViewProps {
  snapshot: TrajectorySnapshot
  loadImage: MessageImageLoader
  loading?: boolean
  locale?: 'en' | 'zh'
  /** New object identity re-arms even the same search hit. Apply after replay. */
  inspectLine?: ChatInspectLine | null
  onInspectApplied?: () => void
}

const PAGE_SIZE = 100

/** Read-only conversation over the shared fold; no harness parsing or routing lives here. */
export function ChatView({ snapshot, loadImage, loading = false, locale = 'en', inspectLine = null, onInspectApplied }: ChatViewProps) {
  const labels = chatLabels[locale]
  const model = useMemo(() => buildChatModel(snapshot), [snapshot])
  const context = useMemo(() => ({ labels, tools: model.tools, loadImage, locale, nodes: model.nodes }), [labels, model.tools, loadImage, locale, model.nodes])
  const root = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)
  const follow = useRef(inspectLine === null)
  const applied = useRef<ChatInspectLine | null>(null)
  const prepend = useRef<{ height: number; top: number } | null>(null)
  const [start, setStart] = useState<number | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [selected, setSelected] = useState<number | null>(null)
  const [missing, setMissing] = useState(false)
  const [pendingScroll, setPendingScroll] = useState<{ element: HTMLElement; block: ScrollLogicalPosition } | null>(null)
  const first = start ?? Math.max(0, model.nodes.length - PAGE_SIZE)
  const flow = useMemo(() => chatFlow(model.nodes, snapshot, first), [model.nodes, snapshot, first])
  const latestAnswer = [...flow.answers].at(-1)

  const renderMessage = (index: number) => {
    const node = model.nodes[index]
    if (node === undefined) return null
    return <article key={node.seq} className={css.message}
      data-chat-flow-kind={node.kind} data-chat-row={index} data-selected={selected === index || undefined}
      data-actions-reveal={node.kind === 'assistant' && index !== latestAnswer ? 'hover' : undefined}>
      <ChatMessage node={node} context={context} hideReasoning={flow.hiddenReasoning.has(index)} showActions={node.kind !== 'assistant' || flow.answers.has(index)} />
    </article>
  }

  useLayoutEffect(() => {
    if (loading) return
    if (start === null) setStart(first)
    const element = scroll.current
    if (element === null) return
    if (inspectLine !== null && applied.current !== inspectLine) {
      follow.current = false
      const target = snapshot.sourceLines?.targetAt(inspectLine.line, inspectLine.fileId)
      const row = target === undefined ? undefined : chatTargetRow(model, target)
      if (row !== undefined && row < first) {
        setStart(row)
        return
      }
      setMissing(row === undefined)
      setSelected(row ?? null)
      if (row !== undefined) {
        const message = element.querySelector<HTMLElement>(`[data-chat-row="${row}"]`)
        const process = message?.closest('details[data-turn-process]')
        if (process instanceof HTMLDetailsElement) process.open = true
        const reasoning = element.querySelector<HTMLDetailsElement>(`[data-reasoning-row="${row}"]`)
        if (reasoning !== null) {
          reasoning.open = true
          reasoning.querySelectorAll('details').forEach(detail => { detail.open = true })
        }
        // A search may address reasoning, context, or a nested tool. Reveal
        // disclosures before measuring so the destination cannot stay hidden.
        message?.querySelectorAll('details').forEach(detail => { detail.open = true })
        message?.querySelectorAll<HTMLButtonElement>('[data-chat-disclosure][aria-expanded="false"]')
          .forEach(button => { button.click() })
        const call = target?.kind === 'call'
          ? [...(message?.querySelectorAll<HTMLElement>('[data-call-id]') ?? [])]
            .find(element => element.dataset.callId === target.callId)
          : undefined
        const destination = call ?? message
        // Controlled disclosures (such as compaction) commit their expanded
        // body in the next render. Scroll only after that commit's layout.
        // A record can contain pages of reasoning and several tools. Centering
        // that entire article lands in its middle, hiding its start. Only an
        // explicitly addressed call is narrow enough to center reliably.
        setPendingScroll(destination === undefined || destination === null ? null
          : { element: destination, block: call === undefined ? 'start' : 'center' })
      }
      applied.current = inspectLine
      setAtBottom(false)
      if (row === undefined) onInspectApplied?.()
      return
    }
    if (prepend.current !== null) {
      element.scrollTop = prepend.current.top + element.scrollHeight - prepend.current.height
      prepend.current = null
    } else if (follow.current) element.scrollTop = element.scrollHeight
  }, [first, start, model, snapshot, loading, inspectLine, onInspectApplied])

  useLayoutEffect(() => {
    if (pendingScroll === null) return
    if (pendingScroll.element.isConnected) pendingScroll.element.scrollIntoView?.({ block: pendingScroll.block })
    setPendingScroll(null)
    onInspectApplied?.()
  }, [pendingScroll, onInspectApplied])

  useEffect(() => {
    if (column.current === null || typeof ResizeObserver === 'undefined') return
    // Images and Markdown can grow after a stream update. Follow only while
    // the reader remains at the tail, never while reading a search hit/history.
    const observer = new ResizeObserver(() => {
      if (scroll.current !== null) {
        root.current?.style.setProperty('--dsh-conversation-column-width', `${scroll.current.clientWidth}px`)
      }
      if (follow.current && scroll.current !== null) scroll.current.scrollTop = scroll.current.scrollHeight
    })
    observer.observe(column.current)
    if (scroll.current !== null) observer.observe(scroll.current)
    return () => { observer.disconnect() }
  }, [])

  return <div ref={root} className={`${conversationCss.root} ${css.root}`}>
    <div ref={scroll} className={`${conversationCss.scroll} ${css.scroll}`} role="region" aria-label={labels.chat} onScroll={() => {
      const element = scroll.current
      if (element === null) return
      const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
      follow.current = bottom
      setAtBottom(bottom)
    }}>
      <div ref={column} className={conversationCss.column}>
        {first > 0 && <div className={conversationCss.older}><button type="button" onClick={() => {
          const element = scroll.current
          if (element !== null) prepend.current = { height: element.scrollHeight, top: element.scrollTop }
          follow.current = false
          setStart(Math.max(0, first - PAGE_SIZE))
        }}>{labels.earlier}</button></div>}
        {missing && <p role="status" className={conversationCss.hint}>{labels.missing}</p>}
        {loading && <p role="status" className={conversationCss.hint}>{labels.loading}</p>}
        {!loading && model.nodes.length === 0 && snapshot.partial === null && <p className={conversationCss.hint}>{labels.empty}</p>}
        {flow.entries.map(entry => entry.kind === 'message' ? renderMessage(entry.index) : (
          <details key={`process:${entry.turn}:${entry.indexes[0] ?? entry.reasoningIndex}`} className={css.process} data-turn-process={entry.turn} data-reasoning-row={entry.reasoningIndex}>
            <summary className={processCss.root}>
              <span className={processCss.label}>
                {[
                  entry.tools > 0 ? (locale === 'zh' ? `${entry.tools} 次工具调用` : `${entry.tools} tool ${entry.tools === 1 ? 'call' : 'calls'}`) : '',
                  entry.messages > 0 ? (locale === 'zh' ? `${entry.messages} 条消息` : `${entry.messages} ${entry.messages === 1 ? 'message' : 'messages'}`) : '',
                ].filter(Boolean).join(' · ') || (locale === 'zh' ? '思考了一会儿' : 'Thought for a while')}
              </span>
              <IconChevronDownOutline14 className={processCss.chevron} />
            </summary>
            <div className={css.processBody}>{entry.indexes.map(renderMessage)}
              {entry.reasoningIndex !== undefined && (() => {
                const answer = model.nodes[entry.reasoningIndex]
                return answer?.kind === 'assistant' ? <AssistantContent blocks={answer.blocks.filter(block => block.kind === 'reasoning')} context={context} /> : null
              })()}
            </div>
          </details>
        ))}
        {snapshot.partial !== null && <article className={css.message} data-chat-row={model.nodes.length}
          data-selected={selected === model.nodes.length || undefined}>
          <AssistantContent blocks={snapshot.partial.blocks} context={context} streaming />
        </article>}
      </div>
    </div>
    {!atBottom && <div className={conversationCss.toBottomSlot}><button type="button" className={conversationCss.toBottom}
      aria-label={labels.latest} title={labels.latest} onClick={() => {
      follow.current = true
      setAtBottom(true)
      if (scroll.current !== null) scroll.current.scrollTop = scroll.current.scrollHeight
    }}><IconChevronDownOutline14 /></button></div>}
  </div>
}
