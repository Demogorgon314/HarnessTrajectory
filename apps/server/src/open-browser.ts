/**
 * Default-browser handoff after listen, matching dsh web: open on a local
 * launch, skip under SSH, and honour `--no-open`.
 */

import { spawn } from 'node:child_process'

/** True when this process was started through an SSH session. */
export function launchedThroughSsh(env: NodeJS.ProcessEnv = process.env): boolean {
  const connection = env['SSH_CONNECTION']
  const tty = env['SSH_TTY']
  return (connection !== undefined && connection !== '') || (tty !== undefined && tty !== '')
}

/**
 * Whether this invocation should open a browser. `--no-open` and
 * `HARNESS_TRAJECTORY_NO_OPEN=1` turn it off; an SSH launch never opens,
 * because the URL the operator uses is a forwarded address this process
 * cannot derive.
 */
export function shouldOpenBrowser(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (argv.includes('--no-open')) return false
  const value = env['HARNESS_TRAJECTORY_NO_OPEN']
  if (value === '1' || value === 'true' || value === 'on') return false
  return !launchedThroughSsh(env)
}

/**
 * Loopback URL for the default browser. A bind of `0.0.0.0` / `::` is not a
 * host the browser can load, so those become `127.0.0.1`.
 */
export function browserUrl(address: string, port: number): string {
  const host = address === '0.0.0.0' || address === '::' || address === '::1'
    ? '127.0.0.1'
    : address.includes(':') ? `[${address}]` : address
  return `http://${host}:${String(port)}`
}

/** Platform command that hands `url` to the default browser. */
export function openBrowserCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] }
  return { command: 'xdg-open', args: [url] }
}

/** Spawn the OS opener; the child is unref'd so it cannot keep this process alive. */
export function openBrowser(url: string): Promise<void> {
  const { command, args } = openBrowserCommand(process.platform, url)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
