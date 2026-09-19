# Chat presentation

`ChatView` consumes the same harness-independent `TrajectorySnapshot` as the
ledger. `model.ts` joins calls and results and maps source targets to visible
rows; `flow.ts` groups completed-turn activity and identifies final answers;
`ChatMessage.tsx` renders the contract's node/content variants. `ChatDisclosure`
owns the native expansion bridge used by search, `ToolPresentation` selects
rich cards only for recognized result shapes, and `ChatStats` projects recorded
turn usage/timing into the upstream stat chrome. Routing,
SSE ownership, and search requests remain in the web app. No harness-specific
parsing or controller dependencies belong here.

The following styles are copied **verbatim** from deepseek-harness (MIT,
Copyright © 2026 DeepSeek; see `../../LICENSE.deepseek-harness`):

Source checkout: `ddefc45fbc7f8e46dd73185e68295696d1297887`.

| Local file | Upstream source under `packages/client/` |
| --- | --- |
| `Conversation.module.css` | `ui-chat/src/client/chat/ChatView.module.css` |
| `MessageItem.module.css` | `ui-chat/src/client/chat/MessageItem.module.css` |
| `AssistantMarkdown.module.css` | `ui-chat/src/client/chat/AssistantMarkdown.module.css` |
| `ReasoningRow.module.css` | `ui-chat/src/client/chat/ReasoningRow.module.css` |
| `MessageIconActions.module.css` | `ui-chat/src/client/chat/MessageIconActions.module.css` |
| `DisclosureRow.module.css` | `ui-primitives/src/DisclosureRow.module.css` |
| `ToolRow.module.css` | `ui-tool/src/client/tool/components/ToolRow.module.css` |
| `TurnProcessNodeView.module.css` | `ui-chat/src/client/chat/TurnProcessNodeView.module.css` |
| `TurnTailNodeView.module.css` | `ui-chat/src/client/chat/TurnTailNodeView.module.css` |
| `TurnUsagePanel.module.css` | `ui-chat/src/client/chat/TurnUsagePanel.module.css` |
| `ContextInjectionRow.module.css` | `ui-chat/src/client/chat/ContextInjectionRow.module.css` |
| `stat-dialog.module.css` | `ui-chat/src/client/chat/stat-dialog.module.css` |
| `WidthHandle.module.css` | `ui-conversation/src/client/skeleton/ConversationRoot.module.css` (the `.widthHandle` block; the composer-overlay suppression rule does not apply here) |
| `TurnNavigator.module.css` | `ui-chat/src/client/chat/TurnNavigator.module.css` (the band height is the component's own scrollport measurement rather than host-published viewport/composer vars, and the busy-mark state is dropped) |

The shared theme also loads the verbatim `ui-theme/src/styles/gradient-shadow-text.css`:
the Markdown font ladder and elevation tokens are dependencies of these sheets,
not optional decoration. Markdown's compact variant and the StateDot primitive
are ported from `ui-primitives` with the same license. The `ReadBlock`, `DiffBlock`,
`SearchBlock`, `TerminalBlock`, and `Pill` primitives and their styles also come
from that directory, along with `FoldToggle`, `ansi`, `head-tail-cap`,
`use-copy-feedback`, `file-size`, `useAnchoredPosition`, and
`useDismissOnOutsidePointer`. These files are verbatim except for TerminalBlock's
optional `recordedState` override: a viewer must distinguish missing settlement
from success without manufacturing an exit code. `stat-dialog.ts` is copied
from `ui-chat/src/client/chat` with local primitive imports.

TerminalResult maps recorded command/cwd/status to the primitive; ANSI output
uses the upstream parser. Tool cards fall back to the full IN/OUT text when
their shape is ambiguous or an error is recorded. Read/search previews retain
eight rows and diffs nine, matching the upstream Chat caps.
An argument-derived edit diff is labelled as the requested change and keeps
the full IN/OUT record alongside it; input arguments are not proof of an applied edit.

Keep viewer adaptations in `ChatView.module.css`, so upstream styles can be
compared and refreshed without mixing local changes into them. The viewer
supplies the column width variables normally owned by the conversation host.
`WidthControls.tsx` adapts `ui-conversation`'s `ConversationWidthControls.tsx`
to that role: it installs the same `--dsh-chat-content-width` axis (measured
column plus the `--dsh-chat-user-width` drag preference persisted to
localStorage) and renders the two edge strips. Upstream elects the controls
through a factory slot and gates them on the active phase; this viewer mounts
them unconditionally inside ChatView's root, and the strips' wheel forwarding
targets the sibling marked `data-chat-scroll`.
The committed width lives in memory; storage is best-effort persistence, so a
failed write does not undo a drag or change subsequent cancellation behavior.
`TurnNavigator.tsx` ports `ui-chat`'s turn rail (`TurnNavigator.tsx` with
`turn-rail-items.ts`/`turn-navigation.ts`). `createTurnRailSelector` groups the loaded
nodes by recorded turn instead of reading a host turn outline, and a mark
whose turn starts above the paged window extends `start` rather than fetching
a page — history is local here. The component measures the scrollport band
itself, since the viewer has no composer or viewport publisher. Rows carry
`data-chat-turn` through `chatNodeTurn`, the same resolver `flow.ts` groups
processes with.
Each view retains unchanged navigation arrays and caches previews by immutable
node identity. Unrelated streaming updates therefore leave the rail's manual
scroll position alone. Locations are rechecked on every snapshot to account for
late turn attribution; the scroll observer stays attached and queued animation
frames sample the latest committed navigation data.
New navigation, search, paging, and return-to-latest actions clear older deferred
landings and prepend corrections. The rail observes its actual viewport height
through CSS transitions to keep the active mark visible, except while the reader's
pointer is working the rail.
Only explicitly closed turns whose activity is fully paged in default to the
compact process presentation, including reasoning attached to the final answer;
open and unknown turns remain expanded. Search
reveals both that outer process and the target's own disclosure. User attachments
sit outside the text bubble, and only final assistant answers own action rows.

The upstream chat package exposes a Cordis plugin rather than a standalone
React view. This module shares the project's existing Markdown, image, and
theme primitives without bringing in upstream session controllers.

Search anchors are file-specific non-blank record indexes. Resolve them only
after replay, reveal paged history and commit controlled disclosures before
scrolling, and consume each request once. Native reasoning geometry follows
`details.open` synchronously rather than waiting for React's `toggle` event.
Record anchors align their start; explicit call anchors center the call.
A fresh request object re-arms an identical hit. Live updates
follow the tail only while the reader remains at the bottom.
