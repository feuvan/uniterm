import { describe, expect, it, vi } from 'vitest'
import {
  PanelLifecycle,
  PanelLifecycleCancelledError,
  isPanelLifecycleCancelled,
  type PanelLifecycleState,
} from './panelLifecycle'
import type { ConnectionConfig, SessionInfo } from '../types/session'

const config: ConnectionConfig = {
  id: 'conn-1', name: 'test', type: 'sftp', host: 'example.test',
  port: 22, user: 'test', authType: 'password',
}
const info = (id: string): SessionInfo => ({ id, type: 'sftp', title: id, status: 'connecting' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createFixture() {
  const panels = new Set(['panel-1', 'panel-2'])
  const sessions = new Map<string, string | null>()
  const initialized = new Set<string>()
  const order: string[] = []
  let serial = 0
  const backend = {
    createSession: vi.fn(async () => info(`session-${++serial}`)),
    closeSession: vi.fn(async (id: string) => { order.push(`close:${id}`) }),
    startSession: vi.fn(async (_id: string, _config: ConnectionConfig) => {}),
  }
  const state: PanelLifecycleState = {
    hasPanel: (id) => panels.has(id),
    getSessionId: (id) => sessions.get(id) ?? null,
    bindSession: (panelId, sessionId) => { sessions.set(panelId, sessionId) },
    unbindSession: (panelId) => { sessions.set(panelId, null) },
    initSession: (id) => { initialized.add(id) },
    removeSession: vi.fn((id) => { initialized.delete(id) }),
    removePanel: vi.fn((id) => { panels.delete(id); order.push(`remove:${id}`) }),
  }
  return { lifecycle: new PanelLifecycle(backend, state), backend, state, panels, sessions, initialized, order }
}

// Let a create/start reach the fake backend before resolving its deferred IPC.
async function reached(mock: ReturnType<typeof vi.fn>, count = 1) {
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count))
}

describe('PanelLifecycle', () => {
  it('recognizes cancellation across serialized error boundaries', () => {
    expect(isPanelLifecycleCancelled(new PanelLifecycleCancelledError())).toBe(true)
    expect(isPanelLifecycleCancelled({
      name: 'PanelLifecycleCancelledError',
      message: 'Panel lifecycle operation was cancelled',
    })).toBe(true)
    expect(isPanelLifecycleCancelled(new Error('Panel lifecycle operation was cancelled'))).toBe(false)
  })

  it('creates, binds, and disposes exactly once, including repeated closes', async () => {
    const f = createFixture()
    const session = await f.lifecycle.createSession('panel-1', 'sftp', config)
    expect(f.sessions.get('panel-1')).toBe(session.id)
    expect(f.initialized.has(session.id)).toBe(true)
    const first = f.lifecycle.disposePanel('panel-1')
    expect(f.lifecycle.disposePanel('panel-1')).toBe(first)
    await first
    await f.lifecycle.disposePanel('panel-1')
    expect(f.backend.closeSession).toHaveBeenCalledExactlyOnceWith(session.id)
    expect(f.state.removePanel).toHaveBeenCalledExactlyOnceWith('panel-1')
    expect(f.initialized.size).toBe(0)
  })

  it('reconnects the primary without disposing its child sessions', async () => {
    const f = createFixture()
    const primary = await f.lifecycle.createSession('panel-1', 'ssh', config)
    const child = await f.lifecycle.createChildSession('panel-1', 'monitor', config)
    const replacement = await f.lifecycle.createSession('panel-1', 'ssh', config)

    expect(f.backend.closeSession).toHaveBeenCalledExactlyOnceWith(primary.id)
    expect(f.sessions.get('panel-1')).toBe(replacement.id)
    await f.lifecycle.disposeSession('panel-1')
    expect(f.backend.closeSession).toHaveBeenCalledWith(replacement.id)
    expect(f.backend.closeSession).not.toHaveBeenCalledWith(child.id)
    expect(f.sessions.get('panel-1')).toBeNull()
  })

  it('stops resources in reverse order, then children, then the primary session', async () => {
    const f = createFixture()
    const primary = await f.lifecycle.createSession('panel-1', 'ssh', config)
    const child = await f.lifecycle.createChildSession('panel-1', 'monitor', config)
    expect(f.sessions.get('panel-1')).toBe(primary.id)
    f.lifecycle.registerResource('panel-1', () => { f.order.push('manager') })
    f.lifecycle.registerResource('panel-1', () => { f.order.push('stream'); throw new Error('stop failed') })
    await f.lifecycle.disposePanel('panel-1')
    expect(f.order).toEqual(['stream', 'manager', `close:${child.id}`, `close:${primary.id}`, 'remove:panel-1'])
  })

  it('does not self-await when a resource requests disposal during panel teardown', async () => {
    const f = createFixture()
    const primary = await f.lifecycle.createSession('panel-1', 'ssh', config)
    const child = await f.lifecycle.createChildSession('panel-1', 'monitor', config)
    f.lifecycle.registerResource('panel-1', async () => {
      f.order.push('resource')
      await f.lifecycle.disposeSession('panel-1')
      await f.lifecycle.disposePanel('panel-1')
      f.order.push('resource-done')
    })

    await f.lifecycle.disposePanel('panel-1')

    expect(f.order).toEqual([
      'resource', 'resource-done', `close:${child.id}`, `close:${primary.id}`, 'remove:panel-1',
    ])
  })

  it('can unregister a resource without disposing it during a view remount', async () => {
    const f = createFixture()
    const dispose = vi.fn()
    const unregister = f.lifecycle.registerResource('panel-1', dispose)
    unregister()
    await f.lifecycle.disposePanel('panel-1')
    expect(dispose).not.toHaveBeenCalled()
  })

  it('rejects creation while close is waiting, and disposes newly registered resources', async () => {
    const f = createFixture()
    const stop = deferred<void>()
    f.lifecycle.registerResource('panel-1', () => stop.promise)
    const closing = f.lifecycle.disposePanel('panel-1')
    await expect(f.lifecycle.createSession('panel-1', 'sftp', config)).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    await expect(f.lifecycle.createChildSession('panel-1', 'sftp', config)).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    const late = vi.fn()
    f.lifecycle.registerResource('panel-1', late)
    await reached(late)
    expect(f.backend.createSession).not.toHaveBeenCalled()
    stop.resolve()
    await closing
    const afterClose = vi.fn()
    f.lifecycle.registerResource('panel-1', afterClose)
    await reached(afterClose)
  })

  it('closes a late primary result and removes its early event buffer', async () => {
    const f = createFixture()
    const pending = deferred<SessionInfo>()
    f.backend.createSession.mockReturnValueOnce(pending.promise)
    const opening = f.lifecycle.createSession('panel-1', 'sftp', config)
    const cancelled = expect(opening).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    await reached(f.backend.createSession)
    await f.lifecycle.disposePanel('panel-1')
    f.initialized.add('late') // status/data events may arrive before the IPC response
    pending.resolve(info('late'))
    await cancelled
    expect(f.backend.closeSession).toHaveBeenCalledExactlyOnceWith('late')
    expect(f.initialized.size).toBe(0)
    expect(f.sessions.get('panel-1')).toBeUndefined()
  })

  it('closes a child result that arrives after its parent was closed', async () => {
    const f = createFixture()
    const pending = deferred<SessionInfo>()
    f.backend.createSession.mockReturnValueOnce(pending.promise)
    const opening = f.lifecycle.createChildSession('panel-1', 'sftp', config)
    const cancelled = expect(opening).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    await reached(f.backend.createSession)
    await f.lifecycle.disposePanel('panel-1')
    pending.resolve(info('child'))
    await cancelled
    expect(f.backend.closeSession).toHaveBeenCalledExactlyOnceWith('child')
  })

  it('invalidates every panel in a batch before waiting on slow close IPC', async () => {
    const f = createFixture()
    const stop = deferred<void>()
    f.lifecycle.registerResource('panel-1', () => stop.promise)
    const generation = f.lifecycle.begin('panel-2')
    const closing = f.lifecycle.disposePanels(['panel-1', 'panel-2'])
    await expect(f.lifecycle.adoptSession('panel-2', 'late-exec', generation)).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    stop.resolve()
    await closing
    expect(f.backend.closeSession).toHaveBeenCalledWith('late-exec')
  })

  it('does not bind an old reconnect result over the newer session', async () => {
    const f = createFixture()
    const pending = deferred<SessionInfo>()
    f.backend.createSession.mockReturnValueOnce(pending.promise)
    const older = f.lifecycle.createSession('panel-1', 'sftp', config)
    const cancelled = expect(older).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    await reached(f.backend.createSession)
    const newer = await f.lifecycle.createSession('panel-1', 'sftp', config)
    pending.resolve(info('obsolete'))
    await cancelled
    expect(f.sessions.get('panel-1')).toBe(newer.id)
    expect(f.backend.closeSession).toHaveBeenCalledExactlyOnceWith('obsolete')
  })

  it('releases a bound previous session even if the caller omitted disposeSession', async () => {
    const f = createFixture()
    const old = await f.lifecycle.createSession('panel-1', 'sftp', config)
    const current = await f.lifecycle.createSession('panel-1', 'sftp', config)
    expect(f.backend.closeSession).toHaveBeenCalledExactlyOnceWith(old.id)
    expect(f.sessions.get('panel-1')).toBe(current.id)
  })

  it('does not let an older reconnect waiting for disposal overtake the latest one', async () => {
    const f = createFixture()
    await f.lifecycle.createSession('panel-1', 'sftp', config)
    const stop = deferred<void>()
    f.backend.closeSession.mockReturnValueOnce(stop.promise)
    const older = f.lifecycle.createSession('panel-1', 'sftp', config)
    const cancelled = expect(older).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    await reached(f.backend.closeSession)
    const newer = f.lifecycle.createSession('panel-1', 'sftp', config)
    stop.resolve()
    await cancelled
    const current = await newer
    expect(f.backend.createSession).toHaveBeenCalledTimes(2)
    expect(f.sessions.get('panel-1')).toBe(current.id)
  })

  it('does not restart a session closed while terminal sizing was pending', async () => {
    const f = createFixture()
    const session = await f.lifecycle.createSession('panel-1', 'local', config)
    await f.lifecycle.disposePanel('panel-1')
    await expect(f.lifecycle.startSession('panel-1', session.id, config)).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    expect(f.backend.startSession).not.toHaveBeenCalled()
    expect(f.backend.closeSession).toHaveBeenCalledTimes(1)
  })

  it.each(['resolve', 'reject'] as const)('rejects a late start %s without unbinding a replacement', async (outcome) => {
    const f = createFixture()
    const pending = deferred<void>()
    f.backend.startSession.mockReturnValueOnce(pending.promise)
    const older = f.lifecycle.createSession('panel-1', 'local', config, { start: true })
    const rejected = expect(older).rejects.toBeInstanceOf(Error)
    await reached(f.backend.startSession)
    const current = await f.lifecycle.createSession('panel-1', 'local', config)
    if (outcome === 'resolve') pending.resolve()
    else pending.reject(new Error('old start failed'))
    await rejected
    expect(f.sessions.get('panel-1')).toBe(current.id)
    expect(f.backend.closeSession).toHaveBeenCalledExactlyOnceWith('session-1')
  })

  it('rolls back a start failure, keeping the panel available for retry', async () => {
    const f = createFixture()
    const error = new Error('start failed')
    f.backend.startSession.mockRejectedValueOnce(error)
    await expect(f.lifecycle.createSession('panel-1', 'local', config, { start: true })).rejects.toBe(error)
    expect(f.backend.closeSession).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(f.initialized.size).toBe(0)
    expect(f.sessions.get('panel-1')).toBeNull()
    expect(f.panels.has('panel-1')).toBe(true)
  })

  it('does not invent a session id when CreateSession fails', async () => {
    const f = createFixture()
    f.backend.createSession.mockRejectedValueOnce(new Error('create failed'))
    await expect(f.lifecycle.createSession('panel-1', 'sftp', config)).rejects.toThrow('create failed')
    await f.lifecycle.disposePanel('panel-1')
    expect(f.backend.closeSession).not.toHaveBeenCalled()
    expect(f.initialized.size).toBe(0)
  })

  it('rolls back even if the frontend bind throws after session creation', async () => {
    const f = createFixture()
    f.state.bindSession = () => { throw new Error('bind failed') }
    await expect(f.lifecycle.createSession('panel-1', 'sftp', config)).rejects.toThrow('bind failed')
    expect(f.backend.closeSession).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(f.initialized.size).toBe(0)
  })

  it('continues clearing state after a backend close failure', async () => {
    const f = createFixture()
    await f.lifecycle.createSession('panel-1', 'sftp', config)
    f.backend.closeSession.mockRejectedValueOnce(new Error('already gone'))
    await f.lifecycle.disposePanel('panel-1')
    expect(f.initialized.size).toBe(0)
    expect(f.panels.has('panel-1')).toBe(false)
  })

  it('never reuses generations after removing and recreating a panel id', async () => {
    const f = createFixture()
    const old = f.lifecycle.begin('panel-1')
    await f.lifecycle.disposePanel('panel-1')
    f.panels.add('panel-1')
    const current = f.lifecycle.begin('panel-1')
    expect(current).not.toBe(old)
    await expect(f.lifecycle.adoptSession('panel-1', 'old-exec', old)).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    expect(f.lifecycle.isCurrent('panel-1', current)).toBe(true)
  })
})
