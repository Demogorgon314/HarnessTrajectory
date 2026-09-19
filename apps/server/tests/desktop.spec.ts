import { PassThrough } from 'node:stream'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopAccess, shutdownOnParentExit } from '../src/desktop.ts'

function desktopApp() {
  const access = createDesktopAccess()
  const app = new Hono().use('*', access.middleware)
  app.get('/api/sessions', context => context.json({ sessions: [] }))
  app.get('/assets/app.js', context => context.text('app'))
  return { app, access }
}

describe('desktop HTTP access', () => {
  it('exchanges the launch secret for a cookie used by API and asset requests', async () => {
    const { app, access } = desktopApp()
    expect((await app.request('/api/sessions')).status).toBe(401)
    expect((await app.request('/assets/app.js')).status).toBe(401)
    const launch = await app.request(access.launchUrl('http://127.0.0.1:1234'))
    expect(launch.status).toBe(303)
    expect(launch.headers.get('location')).toBe('/')
    expect(launch.headers.get('referrer-policy')).toBe('no-referrer')
    const cookie = launch.headers.get('set-cookie')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    const headers = { cookie: cookie ?? '' }
    expect((await app.request('/api/sessions', { headers })).status).toBe(200)
    expect((await app.request('/assets/app.js', { headers })).status).toBe(200)
  })

  it('rejects stale launch URLs and cookies from another app process', async () => {
    const first = desktopApp()
    const second = desktopApp()
    const url = first.access.launchUrl('http://127.0.0.1:1234')
    const launch = await first.app.request(url)
    expect((await second.app.request(url)).status).toBe(401)
    expect((await second.app.request('/api/sessions', {
      headers: { cookie: launch.headers.get('set-cookie') ?? '' },
    })).status).toBe(401)
  })
})

it('shuts down once when the parent pipe closes, without treating data as commands', async () => {
  const pipe = new PassThrough()
  const shutdown = vi.fn()
  shutdownOnParentExit(pipe, shutdown)
  pipe.write('ignored input')
  expect(shutdown).not.toHaveBeenCalled()
  await new Promise<void>(resolve => {
    pipe.once('end', resolve)
    pipe.end()
  })
  expect(shutdown).toHaveBeenCalledOnce()
})
