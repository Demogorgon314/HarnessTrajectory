/**
 * The sidebar's "Content matches" section: the debounce/abort gate in front of
 * `/api/search`, the states the server can put it in, highlighting straight
 * from the server's offsets, and the address a hit opens.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  HarnessKind, SearchHit, SearchResponse, SearchSessionGroup,
} from '@harness-trajectory/core'
import type { Route } from '../src/App.tsx'
import { SessionSearch, hitRoute, snippetSegments } from '../src/SessionSearch.tsx'

const DEBOUNCE = 200
const NO_KINDS: ReadonlySet<HarnessKind> = new Set()

// -- doubles -----------------------------------------------------------------

interface PendingCall {
  url: string
  signal: AbortSignal | null
  resolve: (body: SearchResponse) => void
  /** Answer with a status (and optionally a non-JSON body) instead of a result. */
  fail: (status: number, statusText: string, contentType?: string) => void
  reject: (error: Error) => void
}

let calls: PendingCall[] = []

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

/** A fetch that parks every request until the spec answers it. */
function stubFetch(): void {
  calls = []
  vi.stubGlobal('fetch', (input: unknown, init?: { signal?: AbortSignal | null }) => {
    const signal = init?.signal ?? null
    return new Promise<unknown>((resolve, reject) => {
      const call: PendingCall = {
        url: String(input),
        signal,
        resolve: body => {
          resolve({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => Promise.resolve(body),
          })
        },
        fail: (status, statusText, contentType = 'application/json') => {
          resolve({
            ok: status >= 200 && status < 300,
            status,
            statusText,
            headers: new Headers({ 'content-type': contentType }),
            json: () => Promise.reject(new Error('no body')),
          })
        },
        reject,
      }
      // A real fetch rejects the moment its signal fires.
      signal?.addEventListener('abort', () => { reject(abortError()) })
      calls.push(call)
    })
  })
}

function body(over: Partial<SearchResponse> = {}): SearchResponse {
  return {
    enabled: true,
    query: 'needle',
    minLength: 3,
    groups: [],
    totalHits: 0,
    truncated: false,
    indexing: { pendingFiles: 0, ready: true, filesDone: 0, filesTotal: 0 },
    ...over,
  }
}

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    kind: 'claude',
    sessionId: 'sess-1',
    fileId: 'sess-1',
    line: 12,
    role: 'human',
    snippet: 'port the needle view',
    matches: [{ start: 9, end: 15 }],
    score: 1,
    ...over,
  }
}

function group(over: Partial<SearchSessionGroup> = {}): SearchSessionGroup {
  return {
    kind: 'claude',
    sessionId: 'sess-1',
    title: 'Port the Context tab',
    cwd: '/Users/me/repos/harness-trajectory',
    hitCount: 1,
    hits: [hit()],
    ...over,
  }
}

/** Mount the section with a controllable query; returns a setter for the query. */
function mount(initial = '', kinds: ReadonlySet<HarnessKind> = NO_KINDS) {
  const onSelect = vi.fn<(route: Route) => void>()
  const view = render(
    <SessionSearch query={initial} kinds={kinds} selected={null} onSelect={onSelect} debounceMs={DEBOUNCE} />,
  )
  const retype = (query: string, nextKinds: ReadonlySet<HarnessKind> = kinds) => {
    view.rerender(
      <SessionSearch query={query} kinds={nextKinds} selected={null} onSelect={onSelect} debounceMs={DEBOUNCE} />,
    )
  }
  return { ...view, onSelect, retype }
}

async function tick(ms: number): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms) })
}

/** Answer the newest in-flight request and let the render settle. */
async function answer(response: SearchResponse, at = calls.length - 1): Promise<void> {
  const call = calls[at]
  if (call === undefined) throw new Error(`no request #${at} in flight`)
  await act(async () => { call.resolve(response) })
}

beforeEach(() => {
  vi.useFakeTimers()
  stubFetch()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// -- the gate ----------------------------------------------------------------

describe('the query gate', () => {
  test('a query below the minimum never reaches the server and paints nothing', async () => {
    const { container, retype } = mount('ab')
    await tick(DEBOUNCE * 3)
    expect(calls).toHaveLength(0)
    expect(container.innerHTML).toBe('')
    // Whitespace does not buy length.
    retype('  a  ')
    await tick(DEBOUNCE * 3)
    expect(calls).toHaveLength(0)
  })

  test('three characters open the section and ask the server', async () => {
    mount('abc')
    expect(calls, 'the request waits out the debounce').toHaveLength(0)
    await tick(DEBOUNCE)
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]?.url ?? '', 'http://x').searchParams.get('q')).toBe('abc')
  })

  test("the server's own floor replaces the default once it has answered", async () => {
    const { retype, container } = mount('abcd')
    await tick(DEBOUNCE)
    await answer(body({ minLength: 5, query: 'abcd' }))
    // Four characters were fine a moment ago; the server says five.
    retype('abcd')
    await tick(DEBOUNCE * 3)
    expect(calls, 'no second request below the new floor').toHaveLength(1)
    expect(container.innerHTML).toBe('')
  })
})

// -- debounce and abort --------------------------------------------------------

describe('debounce and abort', () => {
  test('keystrokes inside the window collapse into one request', async () => {
    const { retype } = mount('nee')
    await tick(DEBOUNCE / 2)
    retype('need')
    await tick(DEBOUNCE / 2)
    retype('needl')
    await tick(DEBOUNCE / 2)
    retype('needle')
    expect(calls).toHaveLength(0)
    await tick(DEBOUNCE)
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]?.url ?? '', 'http://x').searchParams.get('q')).toBe('needle')
  })

  test('a query that moves on aborts the request already in flight', async () => {
    const { retype } = mount('alpha')
    await tick(DEBOUNCE)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.signal?.aborted).toBe(false)
    retype('alphabet')
    await tick(DEBOUNCE)
    expect(calls[0]?.signal?.aborted, 'the superseded request is cancelled').toBe(true)
    expect(calls).toHaveLength(2)
    expect(new URL(calls[1]?.url ?? '', 'http://x').searchParams.get('q')).toBe('alphabet')
  })

  test('an aborted request is never reported as an error', async () => {
    const { retype, container } = mount('alpha')
    await tick(DEBOUNCE)
    retype('alphabet')
    await tick(DEBOUNCE)
    await answer(body({ query: 'alphabet', groups: [group()], totalHits: 1 }))
    expect(container.textContent).not.toContain('aborted')
    expect(screen.getByText('Port the Context tab')).toBeDefined()
  })

  test('unmounting aborts whatever is open', async () => {
    const view = mount('alpha')
    await tick(DEBOUNCE)
    act(() => { view.unmount() })
    expect(calls[0]?.signal?.aborted).toBe(true)
  })

  test('a single selected harness travels with the request; a wider pick filters here', async () => {
    const { retype } = mount('needle', new Set<HarnessKind>(['codex']))
    await tick(DEBOUNCE)
    expect(new URL(calls[0]?.url ?? '', 'http://x').searchParams.get('kind')).toBe('codex')
    retype('needle', new Set<HarnessKind>(['claude', 'grok']))
    await tick(DEBOUNCE)
    expect(new URL(calls[1]?.url ?? '', 'http://x').searchParams.has('kind')).toBe(false)
    await answer(body({
      groups: [group(), group({ kind: 'kimi', sessionId: 'sess-2', title: 'A kimi session' })],
      totalHits: 2,
    }))
    expect(screen.getByText('Port the Context tab')).toBeDefined()
    expect(screen.queryByText('A kimi session'), 'kimi is not in the filter').toBeNull()
  })
})

// -- the states the server can put the section in ------------------------------

describe('states', () => {
  test('a request in flight says so', async () => {
    const { container } = mount('needle')
    await tick(DEBOUNCE)
    expect(container.textContent).toContain('Searching…')
  })

  test('a disabled index says so and lists nothing', async () => {
    mount('needle')
    await tick(DEBOUNCE)
    await answer(body({ enabled: false, groups: [group()] }))
    expect(screen.getByText('Search index disabled')).toBeDefined()
    expect(screen.queryByText('Port the Context tab')).toBeNull()
  })

  test('an index still building says so above whatever it already has', async () => {
    const { container } = mount('needle')
    await tick(DEBOUNCE)
    await answer(body({
      groups: [group()],
      totalHits: 1,
      indexing: { pendingFiles: 7, ready: false, filesDone: 3, filesTotal: 10 },
    }))
    expect(container.textContent).toContain('Indexing 3 / 10')
    expect(screen.getByText('Port the Context tab')).toBeDefined()
  })

  test('an empty answer is an answer, not a blank section', async () => {
    mount('needle')
    await tick(DEBOUNCE)
    await answer(body())
    expect(screen.getByText('No content matches')).toBeDefined()
  })

  test('a server with no search route reads as a disabled index, not a 404', async () => {
    mount('needle')
    await tick(DEBOUNCE)
    await act(async () => { calls[0]?.fail(404, 'Not Found') })
    expect(screen.getByText('Search index disabled')).toBeDefined()
    expect(screen.queryByText(/404/)).toBeNull()
  })

  test("the static fallback's HTML is a disabled index too, never a parse error", async () => {
    const { container } = mount('needle')
    await tick(DEBOUNCE)
    // An older build answers unknown paths with the app shell, status 200.
    await act(async () => { calls[0]?.fail(200, 'OK', 'text/html; charset=utf-8') })
    expect(screen.getByText('Search index disabled')).toBeDefined()
    expect(container.textContent).not.toContain('no body')
  })

  test('a real server error is still reported', async () => {
    const { container } = mount('needle')
    await tick(DEBOUNCE)
    await act(async () => { calls[0]?.fail(500, 'Internal Server Error') })
    expect(container.textContent).toContain('500 Internal Server Error')
  })

  test('a Hono 500 (text/plain) is an error, not a disabled index', async () => {
    const { container } = mount('needle')
    await tick(DEBOUNCE)
    await act(async () => { calls[0]?.fail(500, 'Internal Server Error', 'text/plain; charset=UTF-8') })
    expect(container.textContent).toContain('500 Internal Server Error')
    expect(screen.queryByText('Search index disabled')).toBeNull()
  })

  test('a failed request shows its message', async () => {
    const { container } = mount('needle')
    await tick(DEBOUNCE)
    await act(async () => { calls[0]?.reject(new Error('500 Internal Server Error for /api/search')) })
    expect(container.textContent).toContain('500 Internal Server Error')
  })
})

// -- highlighting ---------------------------------------------------------------

describe('snippetSegments', () => {
  test('a middle range splits into plain, marked, plain', () => {
    expect(snippetSegments('abcdef', [{ start: 2, end: 4 }])).toStrictEqual([
      { text: 'ab', marked: false },
      { text: 'cd', marked: true },
      { text: 'ef', marked: false },
    ])
  })

  test('ranges at either edge leave no empty run behind', () => {
    expect(snippetSegments('abcdef', [{ start: 0, end: 2 }])).toStrictEqual([
      { text: 'ab', marked: true },
      { text: 'cdef', marked: false },
    ])
    expect(snippetSegments('abcdef', [{ start: 4, end: 6 }])).toStrictEqual([
      { text: 'abcd', marked: false },
      { text: 'ef', marked: true },
    ])
    expect(snippetSegments('abcdef', [{ start: 0, end: 6 }])).toStrictEqual([
      { text: 'abcdef', marked: true },
    ])
  })

  test('touching and overlapping ranges become one run', () => {
    expect(snippetSegments('abcdef', [{ start: 0, end: 2 }, { start: 2, end: 4 }])).toStrictEqual([
      { text: 'abcd', marked: true },
      { text: 'ef', marked: false },
    ])
    expect(snippetSegments('abcdef', [{ start: 1, end: 4 }, { start: 2, end: 3 }])).toStrictEqual([
      { text: 'a', marked: false },
      { text: 'bcd', marked: true },
      { text: 'ef', marked: false },
    ])
  })

  test('unordered ranges sort themselves', () => {
    expect(snippetSegments('abcdef', [{ start: 4, end: 5 }, { start: 1, end: 2 }])).toStrictEqual([
      { text: 'a', marked: false },
      { text: 'b', marked: true },
      { text: 'cd', marked: false },
      { text: 'e', marked: true },
      { text: 'f', marked: false },
    ])
  })

  test('empty, inverted and out-of-range offsets drop instead of throwing', () => {
    expect(snippetSegments('abc', [])).toStrictEqual([{ text: 'abc', marked: false }])
    expect(snippetSegments('abc', [{ start: 2, end: 2 }])).toStrictEqual([{ text: 'abc', marked: false }])
    expect(snippetSegments('abc', [{ start: 3, end: 1 }])).toStrictEqual([{ text: 'abc', marked: false }])
    expect(snippetSegments('abc', [{ start: -4, end: 99 }])).toStrictEqual([{ text: 'abc', marked: true }])
    expect(snippetSegments('', [{ start: 0, end: 4 }])).toStrictEqual([])
  })

  test('the ranges are what highlight — the text is never re-searched', async () => {
    const { container } = mount('needle')
    await tick(DEBOUNCE)
    await answer(body({
      totalHits: 1,
      groups: [group({
        // "needle" occurs twice; only the offsets the server sent may mark.
        hits: [hit({ snippet: 'needle and needle', matches: [{ start: 11, end: 17 }] })],
      })],
    }))
    const marks = [...container.querySelectorAll('mark')]
    expect(marks.map(mark => mark.textContent)).toStrictEqual(['needle'])
    expect(container.textContent).toContain('needle and needle')
  })
})

// -- navigation -----------------------------------------------------------------

describe('hitRoute', () => {
  test('a hit in the main transcript addresses the session itself', () => {
    expect(hitRoute(hit({ fileId: 'sess-1', line: 4 })))
      .toStrictEqual({ kind: 'claude', id: 'sess-1', line: 4 })
  })

  test('a hit in a child transcript selects that file', () => {
    expect(hitRoute(hit({ fileId: 'sess-1/agent-a1b2', line: 40 })))
      .toStrictEqual({ kind: 'claude', id: 'sess-1', file: 'sess-1/agent-a1b2', line: 40 })
  })
})

describe('clicking', () => {
  test('a session row opens the session, a hit row opens kind, session, file and line', async () => {
    const { onSelect } = mount('needle')
    await tick(DEBOUNCE)
    await answer(body({
      totalHits: 2,
      groups: [group({
        hitCount: 2,
        hits: [
          hit({ snippet: 'in the parent', line: 7, matches: [] }),
          hit({ fileId: 'sess-1/agent-a1b2', line: 40, role: 'tool', snippet: 'in the child', matches: [] }),
        ],
      })],
    }))
    fireEvent.click(screen.getByText('Port the Context tab'))
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'claude', id: 'sess-1' })

    fireEvent.click(screen.getByText('in the parent'))
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'claude', id: 'sess-1', line: 7 })

    fireEvent.click(screen.getByText('in the child'))
    expect(onSelect).toHaveBeenLastCalledWith({
      kind: 'claude', id: 'sess-1', file: 'sess-1/agent-a1b2', line: 40,
    })
  })

  test('two hits on the same record (text + tool) both render', async () => {
    mount('needle')
    await tick(DEBOUNCE)
    await answer(body({
      totalHits: 2,
      groups: [group({
        hitCount: 2,
        hits: [
          hit({ role: 'assistant', snippet: 'I will start with the server', matches: [] }),
          hit({ role: 'tool', snippet: 'pnpm vitest run --project server', matches: [] }),
        ],
      })],
    }))
    expect(screen.getByText('I will start with the server')).toBeDefined()
    expect(screen.getByText('pnpm vitest run --project server')).toBeDefined()
  })

  test('every row is a button, so the section is keyboard-reachable', async () => {
    const { container } = mount('needle')
    await tick(DEBOUNCE)
    await answer(body({ totalHits: 1, groups: [group()] }))
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(button.getAttribute('type')).toBe('button')
  })

  test('the role tag and the project basename ride along with each hit', async () => {
    const { container } = mount('needle')
    await tick(DEBOUNCE)
    await answer(body({
      totalHits: 1,
      groups: [group({ hits: [hit({ role: 'assistant' })] })],
    }))
    expect(screen.getByText('assistant')).toBeDefined()
    expect(screen.getByText('harness-trajectory')).toBeDefined()
    expect(container.querySelector('[data-role="assistant"]')).not.toBeNull()
  })
})
