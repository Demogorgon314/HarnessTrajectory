/**
 * The Context dashboard's client half — the dsh-context Context tab, vendored
 * (Apache-2.0, see ../../NOTICE) and re-fitted onto props.
 *
 * Mount `ContextView` with the values a `ContextSession` produces (see
 * `@harness-trajectory/context`) and import the stylesheet bundle once:
 *
 *   import { ContextView } from '@harness-trajectory/context/client'
 *   import '@harness-trajectory/context/styles.css'
 */

export { ContextView, makeContextView, joinNodesOf, usageOfRequests } from './components/contextView.tsx'
export type { ContextViewProps } from './components/contextView.tsx'
export type { SessionInfo } from './components/sessionInfo.tsx'

export { createContextTranslate, DICT_EN, DICT_ZH } from './i18n.ts'
export type { ContextLocale, Translate } from './i18n.ts'

export { createContextSettings, SETTINGS_KEY } from './settings.ts'
export type {
  ContextSettings, SettingsField, SettingsState,
  DefaultFileSort, DefaultGranularity, DefaultToolSort, DefaultTrendMode,
} from './settings.ts'

export { agentForestOf, layoutForest, fmtDurationCompact, AGENT_TREE_LIMIT } from './agentTree.ts'
export type { AgentForest, AgentNode, AgentNodeInput, AgentStats } from './agentTree.ts'

export { headlineOf } from './headline.ts'
export type { Headline } from './headline.ts'

export { ContextIcon } from './icon.tsx'
export type { ContextIconProps } from './icon.tsx'

export { fmt, fmtDuration, fmtShare, fmtTime } from './format.ts'
export { makeViewKit } from './viewkit.ts'
export type { ViewKit } from './viewkit.ts'

export type { ConversationNodeLike, ImageLoader, ImageRefLike } from './services.ts'
