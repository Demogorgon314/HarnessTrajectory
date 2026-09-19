import type { AssistantMessageNode } from '@harness-trajectory/core'
import { Fragment, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconClockOutline16, IconDatabaseOutline16 } from '../primitives/icons/index.tsx'
import type { ChatMessageContext } from './ChatMessage.tsx'
import css from './TurnUsagePanel.module.css'
import dialogCss from './stat-dialog.module.css'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'

/** Calendar formatting follows upstream, with the locale supplied by the viewer. */
export function messageClock(time: number, locale: 'en' | 'zh', now = Date.now()) {
  const date = new Date(time)
  const today = new Date(now)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === today.toDateString()) return clock
  const md = locale === 'zh' ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getMonth() + 1}/${date.getDate()}`
  const year = date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}${locale === 'zh' ? '年' : '/'}`
  return `${year}${md} ${clock}`
}

export function ChatStats({ node, context }: { node: AssistantMessageNode; context: ChatMessageContext }) {
  const steps = context.nodes.filter((item): item is AssistantMessageNode => item.kind === 'assistant' && item.turn === node.turn)
  const usages = steps.flatMap(step => step.usage === undefined ? [] : [step.usage])
  // Some harnesses report cumulative turn usage. Its latest sample supersedes
  // per-step samples; summing both would double-count the same generated tokens.
  const cumulative = usages.findLast(usage => usage.scope === 'turn')
  const counted = cumulative === undefined ? usages : [cumulative]
  const input = counted.reduce((sum, usage) => sum + usage.inputTokens, 0)
  const cacheRead = counted.reduce((sum, usage) => sum + (usage.cacheReadTokens ?? 0), 0)
  const cacheWrite = counted.reduce((sum, usage) => sum + (usage.cacheWriteTokens ?? 0), 0)
  const output = counted.reduce((sum, usage) => sum + usage.outputTokens, 0)
  const total = counted.reduce((sum, usage) => sum + (usage.totalTokens ?? usage.inputTokens + usage.outputTokens
    + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)), 0)
  const starts = steps.flatMap(step => step.timing?.stepStartTime == null ? [] : [step.timing.stepStartTime])
  const duration = starts.length > 0 && node.timing !== undefined ? Math.max(0, node.timing.completedTime - Math.min(...starts)) : undefined
  const zh = context.locale === 'zh'
  const seconds = Math.floor((duration ?? 0) / 1000)
  const elapsed = seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m ${String(seconds % 60).padStart(2, '0')}s`
    : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
  const routes = [...new Set(steps.flatMap(step => step.provenance === undefined ? [] : [`${step.provenance.provider}/${step.provenance.model}`]))]
  const usageRows: [string, string][] = []
  if (routes.length > 0) usageRows.push([zh ? '模型' : 'Model', routes.join(', ')])
  usageRows.push([zh ? '未缓存输入' : 'Uncached input', input.toLocaleString()])
  if (counted.some(usage => usage.cacheReadTokens !== undefined)) usageRows.push([zh ? '缓存读取' : 'Cache read', cacheRead.toLocaleString()])
  if (counted.some(usage => usage.cacheWriteTokens !== undefined)) usageRows.push([zh ? '缓存写入' : 'Cache write', cacheWrite.toLocaleString()])
  usageRows.push([zh ? '输出' : 'Output', output.toLocaleString()])
  const timingRows: [string, string][] = [[zh ? '耗时' : 'Duration', elapsed]]
  const first = steps[0]?.timing
  if (first?.firstTokenTime != null && first.stepStartTime !== null) {
    timingRows.push([zh ? '首字延迟' : 'Time to first token', `${((first.firstTokenTime - first.stepStartTime) / 1000).toFixed(1)}s`])
  }
  return <>
    {counted.length > 0 && <StatPanel title={zh ? '回合用量' : 'Turn usage'} icon={<IconDatabaseOutline16 />}
      label={`${zh ? '消耗 ' : ''}${total < 1000 ? total : `${(total / 1000).toFixed(1)}K`} tokens`}
      value={`${total.toLocaleString()} tokens`} rows={usageRows} />}
    {duration !== undefined && <StatPanel title={zh ? '回合耗时' : 'Turn time'} icon={<IconClockOutline16 />}
      label={zh ? `用时 ${elapsed}` : `Ran for ${elapsed}`} rows={timingRows} />}
  </>
}

function StatPanel({ title, icon, label, value, rows }: {
  title: string; icon: ReactNode; label: string; value?: string; rows: [string, string][]
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  return <span ref={rootRef} className={css.root}>
    <button type="button" className={css.trigger} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { setOpen(!open) }}>{icon}<span className={css.label}>{label}</span></button>
    {open && createPortal(<div ref={panelRef} className={dialogCss.panel} role="dialog" aria-label={title} style={pos ?? MEASURE_STYLE}>
      <div className={dialogCss.title}><span className={dialogCss.titleLabel}>{icon}{title}</span>
        {value !== undefined && <span className={dialogCss.titleValue}>{value}</span>}</div>
      <div className={dialogCss.titleRule} aria-hidden />
      <dl className={dialogCss.details}>{rows.map(([name, value]) => <Fragment key={name}><dt>{name}</dt><dd>{value}</dd></Fragment>)}</dl>
    </div>, document.body)}
  </span>
}
