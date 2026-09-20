import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ConversationNode, ToolResultNode } from '@harness-trajectory/core'
import { argumentSummary, executionDiagnostics } from './execution-diagnostics.ts'
import type { FailureGroup, ModelTrouble, SlowTool } from './execution-diagnostics.ts'
import { formatDurationMillis } from './trajectory-record.ts'
import type { TrajectoryTranslate } from './locales.ts'
import { StateDot } from '../primitives/StateDot.tsx'
import css from './ExecutionDiagnostics.module.css'

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function timeLabel(time: number): string | null {
  return Number.isFinite(time)
    ? new Date(time).toLocaleTimeString(undefined, { hour12: false })
    : null
}

function CallPills({ calls, expanded = false, onToggle, onInspect, t }: {
  calls: readonly ToolResultNode[]
  expanded?: boolean
  onToggle?: () => void
  onInspect: (callId: string) => void
  t: TrajectoryTranslate
}) {
  return (
    <>
      {calls.map((call, index) => ({ call, index }))
        .filter(({ index }) => expanded || calls.length <= 4 || index < 2 || index >= calls.length - 2)
        .map(({ call, index }) => (
          <button type="button" className={css.pill} key={call.callId}
            aria-label={t('diagnostics.inspect', { number: index + 1 })}
            onClick={() => { onInspect(call.callId) }}>
            #{index + 1}
          </button>
        ))}
      {calls.length > 4 && onToggle !== undefined && (
        <button type="button" className={css.pill} aria-expanded={expanded} onClick={onToggle}>
          {t(expanded ? 'diagnostics.showLess' : 'diagnostics.allCalls', { count: calls.length })}
        </button>
      )}
    </>
  )
}

function FailureCard({ group, expanded, onToggle, onInspect, t }: {
  group: FailureGroup
  expanded: boolean
  onToggle: () => void
  onInspect: (callId: string) => void
  t: TrajectoryTranslate
}) {
  const first = group.calls[0]
  const recovery = group.recovery
  const tool = first?.call ?? null
  const time = first === undefined ? null : timeLabel(first.time)
  return (
    <article className={css.card}>
      <div className={css.cardHead}>
        <StateDot state={recovery === null ? 'error' : 'warning'} size={8} />
        <strong>{t('diagnostics.failures', { count: group.calls.length })}</strong>
        {time !== null && <span className={css.meta}>{time}</span>}
      </div>
      {tool !== null && (
        <code className={css.call} title={truncate(tool.argsRaw, 400)}>
          {tool.name} · {argumentSummary(tool.argsRaw)}
        </code>
      )}
      {group.errorCodes.length > 0 && (
        <div className={css.badges}>
          {group.errorCodes.map(code => <span className={css.badge} key={code}>{code}</span>)}
        </div>
      )}
      <p className={css.hint}>
        {t(recovery === null ? 'diagnostics.unrecovered' : 'diagnostics.recovered')}
        {group.interleaved ? ` ${t('diagnostics.interleaved')}` : ''}
      </p>
      <div className={css.links}>
        <CallPills calls={group.calls} expanded={expanded} onToggle={onToggle} onInspect={onInspect} t={t} />
        {recovery !== null && (
          <button type="button" className={`${css.pill} ${css.pillSuccess}`}
            onClick={() => { onInspect(recovery.callId) }}>
            {t('diagnostics.inspectRecovery')}
          </button>
        )}
      </div>
    </article>
  )
}

function ModelCard({ trouble, onInspectSeq, t }: {
  trouble: ModelTrouble
  onInspectSeq: (seq: number) => void
  t: TrajectoryTranslate
}) {
  const parts = [
    trouble.retries.length > 0 ? t('diagnostics.retries', { count: trouble.retries.length }) : null,
    trouble.errors.length > 0 ? t('diagnostics.turnErrors', { count: trouble.errors.length }) : null,
    trouble.maxTokens.length > 0 ? t('diagnostics.maxTokens', { count: trouble.maxTokens.length }) : null,
  ].filter((part): part is string => part !== null)
  const lastFailure = trouble.lastFailure
  const time = timeLabel(trouble.time)
  return (
    <article className={css.card}>
      <div className={css.cardHead}>
        <StateDot state={trouble.errors.length > 0 ? 'error' : 'warning'} size={8} />
        <strong>{t('diagnostics.modelTitle')}</strong>
        <span className={css.meta}>
          {[time, t('diagnostics.turnStep', { turn: trouble.turn, step: trouble.step })]
            .filter(part => part !== null).join(' · ')}
        </span>
      </div>
      <p className={css.hint}>{parts.join(' · ')}</p>
      {lastFailure !== null && (
        <code className={css.call} title={lastFailure.message}>
          {lastFailure.code} · {truncate(lastFailure.message, 200)}
        </code>
      )}
      <div className={css.links}>
        <button type="button" className={css.pill} onClick={() => { onInspectSeq(trouble.seq) }}>
          {t('diagnostics.inspectStep')}
        </button>
      </div>
    </article>
  )
}

function SlowCard({ slow, onInspect, t }: {
  slow: SlowTool
  onInspect: (callId: string) => void
  t: TrajectoryTranslate
}) {
  const tool = slow.call.call
  const time = timeLabel(slow.call.time)
  return (
    <article className={css.card}>
      <div className={css.cardHead}>
        <StateDot state="idle" size={8} />
        <strong>{t('diagnostics.slowest', { duration: formatDurationMillis(slow.durationMs, t) })}</strong>
        {time !== null && <span className={css.meta}>{time}</span>}
      </div>
      {tool !== null && (
        <code className={css.call} title={truncate(tool.argsRaw, 400)}>
          {tool.name} · {argumentSummary(tool.argsRaw)}
        </code>
      )}
      <p className={css.hint}>
        {t(slow.toolSampleCount < 3 ? 'diagnostics.fewSamples' : 'diagnostics.comparison', {
          count: slow.sampleCount, toolCount: slow.toolSampleCount,
          duration: formatDurationMillis(slow.medianMs, t),
        })}
        {slow.batchedExcluded > 0 ? ` ${t('diagnostics.batchedExcluded', { count: slow.batchedExcluded })}` : ''}
      </p>
      <div className={css.links}>
        <CallPills calls={[slow.call]} onInspect={onInspect} t={t} />
      </div>
    </article>
  )
}

export function ExecutionDiagnostics({ nodes, t, open, onClose, onInspect, onInspectSeq }: {
  nodes: readonly ConversationNode[]
  t: TrajectoryTranslate
  open: boolean
  onClose: () => void
  onInspect: (callId: string) => void
  onInspectSeq: (seq: number) => void
}) {
  const report = useMemo(() => open ? executionDiagnostics(nodes) : null, [nodes, open])
  const [showAll, setShowAll] = useState(false)
  const [expandedCalls, setExpandedCalls] = useState<ReadonlySet<string>>(new Set())
  const titleId = useId()
  const failuresId = useId()
  const modelId = useId()
  const timingId = useId()
  const dialogRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!open) { setShowAll(false); setExpandedCalls(new Set()); return }
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return }
      if (event.key !== 'Tab') return
      const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      const first = buttons?.[0]
      const last = buttons?.[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialogRef.current?.contains(event.target)) closeRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('focusin', onFocusIn)
      openerRef.current?.focus()
      openerRef.current = null
    }
  }, [open])
  if (!open || report === null) return null
  const shown = showAll ? report.failures : report.failures.slice(0, 3)
  return (
    <div className={css.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className={css.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className={css.header}>
          <h2 id={titleId}>{t('diagnostics.title')}</h2>
          <div className={css.summary}>
            <span className={css.chip}>{t('diagnostics.summaryFailures', { count: report.failures.length })}</span>
            <span className={css.chip}>{t('diagnostics.summaryModel', { count: report.model.length })}</span>
            {report.slow !== null && (
              <span className={css.chip}>
                {t('diagnostics.summarySlow', { duration: formatDurationMillis(report.slow.durationMs, t) })}
              </span>
            )}
          </div>
          <button ref={closeRef} type="button" className={css.close} aria-label={t('diagnostics.close')} onClick={onClose}>×</button>
        </header>
        <div className={css.body}>
          <section className={css.group} aria-labelledby={failuresId}>
            <h3 id={failuresId}>
              {t('diagnostics.sectionFailures')} <span className={css.count}>{report.failures.length}</span>
            </h3>
            {report.failures.length === 0
              ? <p className={css.empty}>{t('diagnostics.emptyFailures')}</p>
              : <>
                  {report.failures.length > 3 && (
                    <p className={css.hint}>
                      {t('diagnostics.groups', { count: report.failures.length, shown: shown.length })}
                      {' '}
                      <button type="button" className={css.pill} onClick={() => { setShowAll(value => !value) }}>
                        {t(showAll ? 'diagnostics.showLess' : 'diagnostics.showAll')}
                      </button>
                    </p>
                  )}
                  <div className={css.cards}>
                    {shown.map(group => {
                      const key = group.calls[0]?.callId ?? String(group.calls[0]?.seq ?? 0)
                      return (
                        <FailureCard key={key} group={group}
                          expanded={expandedCalls.has(key)} onToggle={() => {
                            setExpandedCalls(previous => {
                              const next = new Set(previous)
                              if (next.has(key)) next.delete(key)
                              else next.add(key)
                              return next
                            })
                          }}
                          onInspect={onInspect} t={t} />
                      )
                    })}
                  </div>
                </>}
          </section>
          <section className={css.group} aria-labelledby={modelId}>
            <h3 id={modelId}>
              {t('diagnostics.sectionModel')} <span className={css.count}>{report.model.length}</span>
            </h3>
            {report.model.length === 0
              ? <p className={css.empty}>{t('diagnostics.emptyModel')}</p>
              : <div className={css.cards}>
                  {report.model.map(trouble => (
                    <ModelCard key={trouble.seq} trouble={trouble} onInspectSeq={onInspectSeq} t={t} />
                  ))}
                </div>}
          </section>
          <section className={css.group} aria-labelledby={timingId}>
            <h3 id={timingId}>{t('diagnostics.sectionTiming')}</h3>
            {report.slow === null
              ? <p className={css.empty}>{t('diagnostics.emptyTiming')}</p>
              : <div className={css.cards}>
                  <SlowCard slow={report.slow} onInspect={onInspect} t={t} />
                </div>}
          </section>
        </div>
        <footer className={css.scope}>{t('diagnostics.scope')}</footer>
      </section>
    </div>
  )
}
