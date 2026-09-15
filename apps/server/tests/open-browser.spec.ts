import { describe, expect, it } from 'vitest'
import {
  browserUrl, launchedThroughSsh, openBrowserCommand, shouldOpenBrowser,
} from '../src/open-browser.ts'

describe('shouldOpenBrowser', () => {
  it('opens by default on a local launch', () => {
    expect(shouldOpenBrowser(['node', 'main.js'], {})).toBe(true)
  })

  it('honours --no-open and HARNESS_TRAJECTORY_NO_OPEN', () => {
    expect(shouldOpenBrowser(['node', 'main.js', '--no-open'], {})).toBe(false)
    expect(shouldOpenBrowser(['node', 'main.js'], { HARNESS_TRAJECTORY_NO_OPEN: '1' })).toBe(false)
    expect(shouldOpenBrowser(['node', 'main.js'], { HARNESS_TRAJECTORY_NO_OPEN: 'true' })).toBe(false)
    expect(shouldOpenBrowser(['node', 'main.js'], { HARNESS_TRAJECTORY_NO_OPEN: 'on' })).toBe(false)
    expect(shouldOpenBrowser(['node', 'main.js'], { HARNESS_TRAJECTORY_NO_OPEN: '0' })).toBe(true)
  })

  it('never opens under SSH', () => {
    expect(launchedThroughSsh({ SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' })).toBe(true)
    expect(launchedThroughSsh({ SSH_TTY: '/dev/pts/0' })).toBe(true)
    expect(launchedThroughSsh({})).toBe(false)
    expect(shouldOpenBrowser(['node', 'main.js'], { SSH_CONNECTION: '10.0.0.2 55000 10.0.0.9 22' })).toBe(false)
  })
})

describe('browserUrl', () => {
  it('rewrites all-interfaces binds to loopback', () => {
    expect(browserUrl('127.0.0.1', 5170)).toBe('http://127.0.0.1:5170')
    expect(browserUrl('0.0.0.0', 5170)).toBe('http://127.0.0.1:5170')
    expect(browserUrl('::', 8080)).toBe('http://127.0.0.1:8080')
    expect(browserUrl('::1', 8080)).toBe('http://127.0.0.1:8080')
  })
})

describe('openBrowserCommand', () => {
  const url = 'http://127.0.0.1:5170'
  it('uses the platform opener', () => {
    expect(openBrowserCommand('darwin', url)).toEqual({ command: 'open', args: [url] })
    expect(openBrowserCommand('linux', url)).toEqual({ command: 'xdg-open', args: [url] })
    expect(openBrowserCommand('win32', url)).toEqual({ command: 'cmd', args: ['/c', 'start', '', url] })
  })
})
