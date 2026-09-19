import { asNumber, asString, isRecord } from '@harness-trajectory/core'
import { TerminalBlock } from '../primitives/TerminalBlock.tsx'
import type { ChatLabels } from './labels.ts'
import css from './ToolRow.module.css'

/** Adapt recorded facts to the upstream card without inventing settlement. */
export function TerminalResult({ command, output, failed, labels, running, fields, meta }: {
  command: string; output: string | undefined; failed: boolean; labels: ChatLabels
  running: boolean; fields: Record<string, unknown>; meta: unknown
}) {
  const metadata = isRecord(meta) ? meta : {}
  const exitCode = asNumber(metadata['exitCode']) ?? asNumber(metadata['exit_code'])
  const signal = asString(metadata['signal'])
  const zh = labels.chat === '对话'
  const expand = (count: number) => zh ? `展开 ${count} 行` : `Show ${count} more lines`
  const done = zh ? '已完成' : 'Done'
  const active = zh ? '运行中' : 'Running'
  const isFailure = failed || signal !== undefined || (exitCode !== undefined && exitCode !== 0)
  return <TerminalBlock command={command} output={output} running={running} exitCode={exitCode} signal={signal}
    cwd={asString(fields['cwd']) ?? asString(fields['workdir'])} maxLines={Infinity} className={css.terminalBody}
    recordedState={{ state: running ? 'ongoing' : isFailure ? 'error' : output === undefined ? 'idle' : 'done',
      label: running ? active : isFailure ? labels.failed : output === undefined ? labels.pending : done }}
    labels={{ ...labels, signal: value => `${zh ? '信号' : 'Signal'} ${value}`,
      exitCode: value => `${zh ? '退出码' : 'Exit'} ${value}`, noExitCode: labels.pending,
      running: active, done, collapse: zh ? '收起' : 'Collapse', collapseAria: zh ? '收起' : 'Collapse', expand, expandAria: expand }} />
}
