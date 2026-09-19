import type { SSEStreamingApi } from 'hono/streaming'
import type { HarnessKind, SessionLiveEvent } from '@harness-trajectory/core'
import { scopeToFile, type SessionSource } from './source.ts'

/** Per-connection queued JSON budget; a slow viewer reconnects and replays on overflow. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024

interface Frame {
  event: string
  data: string
}

function frameBytes(frame: Frame): number {
  return 64 + (frame.event.length + frame.data.length) * 2
}

/** One writer owns replay, queued appends, ready, and keepalives in that order. */
export async function streamSession(
  source: SessionSource,
  kind: HarnessKind,
  id: string,
  stream: SSEStreamingApi,
  fileId?: string,
): Promise<void> {
  const abort = new AbortController()
  const queue: Frame[] = []
  let pendingBytes = 0
  let counter = 0
  let wake = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined

  const enqueue = (frame: Frame): void => {
    if (abort.signal.aborted) return
    // Account for UTF-16 storage, conservatively including ASCII JSON.
    const bytes = frameBytes(frame)
    if (pendingBytes + bytes > MAX_PENDING_BYTES) {
      stream.abort()
      return
    }
    queue.push(frame)
    pendingBytes += bytes
    wake()
  }
  const unsubscribe = source.subscribe(kind, id, raw => {
    const event = fileId === undefined ? raw : scopeToFile(raw, fileId)
    if (event !== null) enqueue({ event: event.type, data: JSON.stringify(event) })
  })
  const stop = (): void => {
    abort.abort()
    unsubscribe()
    queue.length = 0
    pendingBytes = 0
    clearTimeout(timer)
    wake()
  }
  stream.onAbort(stop)

  const write = async (frame: Frame): Promise<void> => {
    if (abort.signal.aborted) return
    if (frame.event === 'ping') await stream.writeSSE(frame)
    else await stream.writeSSE({ ...frame, id: String(++counter) })
  }
  const send = async (event: SessionLiveEvent): Promise<void> => {
    if (!abort.signal.aborted) await write({ event: event.type, data: JSON.stringify(event) })
  }
  const drainOne = async (): Promise<void> => {
    const frame = queue.shift()
    if (frame === undefined) return
    pendingBytes -= frameBytes(frame)
    await write(frame)
  }
  try {
    await source.readAll(kind, id, send, fileId, abort.signal)
    // Freeze the catch-up window so ongoing appends cannot starve ready.
    const queued = queue.length
    for (let at = 0; at < queued && !abort.signal.aborted; at += 1) await drainOne()
    await send({ type: 'ready' })
    if (abort.signal.aborted) return

    // Chrome needs a short ping burst to finish draining a multi-MB replay.
    // Keepalives use the same writer as appends and stop promptly on abort.
    let burst = 20
    const schedulePing = (): void => {
      timer = setTimeout(() => {
        enqueue({ event: 'ping', data: '' })
        if (burst > 0) burst -= 1
        if (!abort.signal.aborted) schedulePing()
      }, burst > 0 ? 250 : 15_000)
    }
    schedulePing()
    while (!abort.signal.aborted) {
      if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
      await drainOne()
    }
  } finally {
    stop()
  }
}
