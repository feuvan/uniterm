import { beforeEach, describe, expect, it, vi } from 'vitest'

const bindings = vi.hoisted(() => ({
  startLogs: vi.fn(),
  startPull: vi.fn(),
  stop: vi.fn(),
}))
const handlers: Record<string, ((event: any) => void)[]> = {}

vi.mock('@wailsio/runtime', () => ({
  Events: {
    On: vi.fn((name: string, callback: (event: any) => void) => {
      ;(handlers[name] ||= []).push(callback)
      return () => {
        handlers[name] = (handlers[name] || []).filter(cb => cb !== callback)
      }
    }),
    Off: vi.fn((name: string) => { delete handlers[name] }),
  },
}))

vi.mock('../../bindings/github.com/ys-ll/uniterm/app', () => ({
  ContainerStartLogs: bindings.startLogs,
  ContainerStartPull: bindings.startPull,
  ContainerStopStream: bindings.stop,
}))

import { startLogs, startPull } from './containerClient'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

function fire(name: string, data: unknown) {
  for (const callback of handlers[name] || []) callback({ data })
}

beforeEach(() => {
  for (const name of Object.keys(handlers)) delete handlers[name]
  bindings.startLogs.mockReset()
  bindings.startPull.mockReset()
  bindings.stop.mockReset().mockResolvedValue(undefined)
})

describe('container stream lifecycle', () => {
  it('stops a stream whose startup resolves after its panel closes', async () => {
    const pending = deferred<string>()
    const current = vi.fn(() => false)
    bindings.startLogs.mockReturnValueOnce(pending.promise)

    const opening = startLogs('conn-1', 'container-1', 100, false, vi.fn(), vi.fn(), current)
    pending.resolve('late-stream')
    const handle = await opening

    expect(handle.id).toBe('late-stream')
    expect(bindings.stop).toHaveBeenCalledExactlyOnceWith('late-stream')
    expect(handlers['container:stream:late-stream']).toBeUndefined()
  })

  it('ignores lines after ownership is invalidated and stops idempotently', async () => {
    let current = true
    const onLine = vi.fn()
    bindings.startPull.mockResolvedValueOnce('pull-stream')

    const handle = await startPull('conn-1', 'image:latest', onLine, undefined, () => current)
    current = false
    fire('container:stream:pull-stream', { line: 'late output' })
    expect(onLine).not.toHaveBeenCalled()

    handle.stop()
    handle.stop()
    expect(bindings.stop).toHaveBeenCalledExactlyOnceWith('pull-stream')
  })

  it('delivers an end error only while the stream is current', async () => {
    const onEnd = vi.fn()
    let current = true
    bindings.startLogs.mockResolvedValueOnce('log-stream')

    const handle = await startLogs('conn-1', 'container-1', 10, true, vi.fn(), onEnd, () => current)
    fire('container:stream-end:log-stream', { error: 'backend failed' })
    expect(onEnd).toHaveBeenCalledExactlyOnceWith('backend failed')

    current = false
    fire('container:stream-end:log-stream', { error: 'second error' })
    expect(onEnd).toHaveBeenCalledTimes(1)
    handle.stop()
    expect(bindings.stop).not.toHaveBeenCalled()
  })
})
