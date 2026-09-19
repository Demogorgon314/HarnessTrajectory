/** Private desktop launch protocol: authenticated HTTP and parent-pipe ownership. */
import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

export const DESKTOP_READY_PREFIX = 'HARNESS_TRAJECTORY_READY '
// localStorage is origin-scoped: changing ports on each launch loses UI preferences.
export const DESKTOP_PORT = 43187

export function createDesktopAccess(): { middleware: MiddlewareHandler; launchUrl: (origin: string) => string } {
  const token = randomBytes(32).toString('hex')
  const cookieName = 'harness_trajectory_desktop'
  return {
    launchUrl: origin => `${origin}/?desktop_token=${token}`,
    middleware: async (context, next) => {
      context.header('Referrer-Policy', 'no-referrer')
      if (context.req.path === '/' && context.req.query('desktop_token') === token) {
        // The first navigation comes from Tauri's bootstrap origin. Lax allows
        // its top-level redirect to carry the newly issued session cookie.
        setCookie(context, cookieName, token, { httpOnly: true, sameSite: 'Lax', path: '/' })
        return context.redirect('/', 303)
      }
      if (getCookie(context, cookieName) !== token) return context.text('Unauthorized', 401)
      await next()
    },
  }
}

/** EOF covers both normal app exit and an abruptly terminated desktop parent. */
export function shutdownOnParentExit(input: Readable, shutdown: () => void): void {
  input.once('end', shutdown)
  input.resume()
  if (input.readableEnded) shutdown()
}
