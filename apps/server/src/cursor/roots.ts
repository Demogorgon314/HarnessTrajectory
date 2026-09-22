/** Where Cursor Agent keeps its per-session stores. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * `~/.cursor/chats`, or `$CURSOR_CONFIG_DIR/chats` when that variable is set
 * (the same override Cursor uses for its config home).
 * `HARNESS_TRAJECTORY_CURSOR_CHATS` replaces the directory outright.
 */
export function cursorChatsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['HARNESS_TRAJECTORY_CURSOR_CHATS']
  if (override !== undefined && override !== '') return resolve(override)
  const config = env['CURSOR_CONFIG_DIR']
  const home = config === undefined || config === '' ? join(homedir(), '.cursor') : config
  return resolve(join(home, 'chats'))
}
