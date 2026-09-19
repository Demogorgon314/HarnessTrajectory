import { useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconCodeOutline16, IconThinkOutline14 } from '../primitives/icons/index.tsx'
import { StateDot } from '../primitives/StateDot.tsx'
import css from './ChatView.module.css'
import rowCss from './DisclosureRow.module.css'
import reasoningCss from './ReasoningRow.module.css'
import toolCss from './ToolRow.module.css'

/** Native details let search reveal a destination without a second expansion store.
 * The wrapper and state attributes preserve the upstream reasoning stylesheet contract.
 */
export function ChatDisclosure({ title, preview, callId, failed, running = false, thinking = false,
  icon, bodyClassName, children }: {
  title: string; preview?: string | undefined; callId?: string; failed?: boolean; running?: boolean
  thinking?: boolean; icon?: ReactNode; bodyClassName?: string | undefined; children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const theme = thinking ? reasoningCss : toolCss
  return <div className={`${theme.root} ${thinking ? css.nativeThinking : ''}`} data-variant={thinking ? 'think' : undefined}
    data-state={failed ? 'error' : running ? 'running' : 'ok'} data-expanded={expanded || undefined}>
    <details className={css.disclosure} data-call-id={callId} data-error={failed || undefined}
      data-open={expanded || undefined} data-keep-preview={!thinking || undefined}
      onToggle={event => { setExpanded(event.currentTarget.open) }}>
      <summary className={`${rowCss.row} ${theme.row}`} data-disclosure-row data-expandable>
        <span className={`${rowCss.leading} ${theme.leading}`}>
          <span className={`${rowCss.iconIdle} ${css.idleIcon}`}>
            {failed || (running && !thinking) ? <StateDot state={failed ? 'error' : 'ongoing'} />
              : icon ?? (thinking ? <IconThinkOutline14 /> : <IconCodeOutline16 />)}
          </span>
          <IconChevronDownOutline14 className={`${rowCss.chevronHover} ${css.openIcon} ${reasoningCss.chevron}`} />
        </span>
        <span className={`${rowCss.title} ${theme.title}`}>{title}</span>
        {preview !== undefined && <>
          <span className={`${reasoningCss.separator} ${css.preview}`} aria-hidden />
          <span className={`${reasoningCss.summary} ${css.preview}`} data-follow-end={running || undefined}>
            <span className={reasoningCss.summaryText}>{preview.replaceAll('**', '')}</span>
          </span>
        </>}
      </summary>
      <div className={bodyClassName ?? (thinking ? reasoningCss.thinkBody : toolCss.bodyWrap)}>{children}</div>
    </details>
  </div>
}
