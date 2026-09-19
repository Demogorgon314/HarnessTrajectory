import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TrajectorySnapshot } from '@harness-trajectory/core'
import type { MessageImageLoader } from '../images.tsx'
import { AssistantContent, ChatMessage } from './ChatMessage.tsx'
import { buildChatModel, chatTargetRow } from './model.ts'
import { chatLabels } from './labels.ts'
import css from './ChatView.module.css'
import conversationCss from './Conversation.module.css'
import processCss from './TurnProcessNodeView.module.css'
import { IconChevronDownOutline14 } from '../primitives/icons/index.tsx'
import { chatFlow, chatNodeTurn } from './flow.ts'
import { createTurnRailSelector, type ChatTurnItem } from './turn-rail.ts'
import { TurnNavigator } from './TurnNavigator.tsx'
import { WidthControls } from './WidthControls.tsx'

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
/** Distance from the tail that still counts as following it. */
const AT_BOTTOM_PX = 48

/** Row position in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** First rendered row carrying a turn tag, in document order. */
function turnRow(element: HTMLElement, turn: number): HTMLElement | null {
  return element.querySelector<HTMLElement>(`[data-chat-turn="${turn}"]`)
}

/**
 * Turn owning the row at a scrollport line. Scroll frames are hot, so this
 * hit-tests the line first and falls back to one row scan when layout cannot
 * answer (jsdom, pre-paint); neither path queries per rail item.
 */
function turnAtLine(element: HTMLElement, line: number): number | null {
  const rect = element.getBoundingClientRect()
  if (typeof document.elementsFromPoint === 'function' && rect.width > 0) {
    for (const hit of document.elementsFromPoint(rect.left + rect.width / 2, line)) {
      const row = hit instanceof HTMLElement ? hit.closest<HTMLElement>('[data-chat-turn]') : null
      const turn = Number(row?.dataset.chatTurn)
      if (row !== null && element.contains(row) && Number.isSafeInteger(turn)) return turn
    }
  }
  let found: number | null = null
  for (const row of element.querySelectorAll<HTMLElement>('[data-chat-turn]')) {
    if (row.getBoundingClientRect().top > line) break
    const turn = Number(row.dataset.chatTurn)
    if (Number.isSafeInteger(turn)) found = turn
  }
  return found
}

/** Land a turn's first rendered row 24px below the scrollport top. A row
   folded into a closed process lands on its summary instead. */
function landOn(element: HTMLElement, row: HTMLElement): void {
  const landing = row.closest<HTMLElement>('details[data-turn-process]:not([open])') ?? row
  element.scrollTop += flowTop(landing, element) - 24
}

/** Read-only conversation over the shared fold; no harness parsing or routing lives here. */
export function ChatView({ snapshot, loadImage, loading = false, locale = 'en', inspectLine = null, onInspectApplied }: ChatViewProps) {
  const labels = chatLabels[locale]
  const model = useMemo(() => buildChatModel(snapshot), [snapshot])
  const context = useMemo(() => ({ labels, tools: model.tools, loadImage, locale, nodes: model.nodes }), [labels, model.tools, loadImage, locale, model.nodes])
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
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
  const selectTurns = useMemo(createTurnRailSelector, [])
  const turns = useMemo(() => selectTurns(model.nodes, snapshot, first), [selectTurns, model.nodes, snapshot, first])
  const [activeTurn, setActiveTurn] = useState<number | null>(null)
  /** Turn whose window extension is still waiting for its first row to commit. */
  const pendingTurn = useRef<number | null>(null)
  const activeFrame = useRef<number | null>(null)

  const syncActiveTurn = useCallback((): void => {
    const element = scroll.current
    const earliest = turns[0]
    if (element === null || earliest === undefined) {
      setActiveTurn(current => current === null ? current : null)
      return
    }
    if (element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX + 1) {
      const latest = turns.at(-1)?.turn ?? earliest.turn
      setActiveTurn(current => current === latest ? current : latest)
      return
    }
    const readingLine = element.getBoundingClientRect().top + Math.min(96, element.clientHeight * 0.2)
    const reading = turnAtLine(element, readingLine)
    // No row reaches the line yet: the window head still owns the mark.
    // Otherwise the row's turn may not be offered (all its rows hidden), so
    // the newest offered turn at or above it owns the mark.
    let next = earliest.turn
    if (reading !== null) {
      for (const item of turns) {
        if (item.turn > reading) break
        next = item.turn
      }
    }
    setActiveTurn(current => current === next ? current : next)
  }, [turns])

  // A queued frame and the long-lived observer must sample the latest commit,
  // including a new turn arriving before an already queued frame has fired.
  const syncActiveTurnRef = useRef(syncActiveTurn)
  useLayoutEffect(() => { syncActiveTurnRef.current = syncActiveTurn })
  const scheduleActiveTurn = useCallback((): void => {
    if (activeFrame.current !== null) return
    if (typeof requestAnimationFrame === 'undefined') {
      syncActiveTurnRef.current()
      return
    }
    activeFrame.current = requestAnimationFrame(() => {
      activeFrame.current = null
      syncActiveTurnRef.current()
    })
  }, [])

  useEffect(() => () => {
    if (activeFrame.current !== null && typeof cancelAnimationFrame !== 'undefined') {
      // StrictMode's unmount cancels the queued frame; clear the ref so the
      // remount's schedule is not swallowed by a stale id.
      cancelAnimationFrame(activeFrame.current)
      activeFrame.current = null
    }
  }, [])

  // Rows move under the reading line without a scroll event (new turns,
  // paging, opened disclosures), so the active mark resyncs per commit.
  useLayoutEffect(() => { scheduleActiveTurn() }, [snapshot, first, scheduleActiveTurn])

  /** Recompute follow/atBottom after a programmatic landing. */
  const settleScroll = useCallback((element: HTMLElement, turn: number): void => {
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < AT_BOTTOM_PX
    follow.current = bottom
    setAtBottom(bottom)
    setActiveTurn(turn)
  }, [])

  /** A new scroll intent supersedes deferred landings and prepend correction. */
  const cancelPendingScroll = useCallback((): void => {
    pendingTurn.current = null
    prepend.current = null
    setPendingScroll(null)
  }, [])

  // Stable for the memoized rail: everything it touches is a ref or a setter.
  const navigateToTurn = useCallback((item: ChatTurnItem): void => {
    const element = scroll.current
    if (element === null) return
    cancelPendingScroll()
    if (!item.loaded) {
      // Extending the window is leaving the live tail; the layout effect
      // lands the turn once its first row commits.
      pendingTurn.current = item.turn
      follow.current = false
      setAtBottom(false)
      setStart(item.index)
      return
    }
    const row = turnRow(element, item.turn)
    if (row === null) return
    landOn(element, row)
    settleScroll(element, item.turn)
  }, [cancelPendingScroll, settleScroll])

  const renderMessage = (index: number) => {
    const node = model.nodes[index]
    if (node === undefined) return null
    return <article key={node.seq} className={css.message}
      data-chat-flow-kind={node.kind} data-chat-row={index} data-selected={selected === index || undefined}
      data-chat-turn={chatNodeTurn(node, snapshot)}
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
      cancelPendingScroll()
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
    if (pendingTurn.current !== null) {
      // A rail jump into paged-out history owns this commit: land once the
      // turn's first row exists, retrying on later commits while it does not.
      const row = turnRow(element, pendingTurn.current)
      if (row !== null) {
        const turn = pendingTurn.current
        pendingTurn.current = null
        landOn(element, row)
        settleScroll(element, turn)
      }
      return
    }
    if (prepend.current !== null) {
      element.scrollTop = prepend.current.top + element.scrollHeight - prepend.current.height
      prepend.current = null
    } else if (follow.current) element.scrollTop = element.scrollHeight
  }, [first, start, model, snapshot, loading, inspectLine, onInspectApplied, settleScroll, cancelPendingScroll])

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
      if (follow.current && scroll.current !== null) scroll.current.scrollTop = scroll.current.scrollHeight
      scheduleActiveTurn()
    })
    observer.observe(column.current)
    if (scroll.current !== null) observer.observe(scroll.current)
    return () => { observer.disconnect() }
  }, [scheduleActiveTurn])

  return <div ref={setRoot} className={`${conversationCss.root} ${css.root}`}>
    <div ref={scroll} className={`${conversationCss.scroll} ${css.scroll}`} role="region" aria-label={labels.chat} data-chat-scroll="" onScroll={() => {
      const element = scroll.current
      if (element === null) return
      const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < AT_BOTTOM_PX
      follow.current = bottom
      setAtBottom(bottom)
      scheduleActiveTurn()
    }}>
      {/* First scroll child: the zero-height slot's static position is the
          content top, so sticky pins it to the scrollport top for the whole
          scroll range without extending scrollHeight. */}
      <TurnNavigator items={turns} activeTurn={activeTurn} onNavigate={navigateToTurn} labels={labels} />
      <div ref={column} className={conversationCss.column}>
        {first > 0 && <div className={conversationCss.older}><button type="button" onClick={() => {
          cancelPendingScroll()
          const element = scroll.current
          if (element !== null) prepend.current = { height: element.scrollHeight, top: element.scrollTop }
          follow.current = false
          setStart(Math.max(0, first - PAGE_SIZE))
        }}>{labels.earlier}</button></div>}
        {missing && <p role="status" className={conversationCss.hint}>{labels.missing}</p>}
        {loading && <p role="status" className={conversationCss.hint}>{labels.loading}</p>}
        {!loading && model.nodes.length === 0 && snapshot.partial === null && <p className={conversationCss.hint}>{labels.empty}</p>}
        {flow.entries.map(entry => entry.kind === 'message' ? renderMessage(entry.index) : (
          <details key={`process:${entry.turn}:${entry.indexes[0] ?? entry.reasoningIndex}`} className={css.process} data-turn-process={entry.turn} data-chat-turn={entry.turn} data-reasoning-row={entry.reasoningIndex}>
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
          data-chat-turn={snapshot.partial.turn}
          data-selected={selected === model.nodes.length || undefined}>
          <AssistantContent blocks={snapshot.partial.blocks} context={context} streaming />
        </article>}
      </div>
    </div>
    {!atBottom && <div className={conversationCss.toBottomSlot}><button type="button" className={conversationCss.toBottom}
      aria-label={labels.latest} title={labels.latest} onClick={() => {
      cancelPendingScroll()
      follow.current = true
      setAtBottom(true)
      if (scroll.current !== null) scroll.current.scrollTop = scroll.current.scrollHeight
    }}><IconChevronDownOutline14 /></button></div>}
    <WidthControls container={root} label={labels.resizeWidth} />
  </div>
}
