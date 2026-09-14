import { describe, expect, it } from 'vitest'
import {
  PanelLifecycle,
  PanelLifecycleCancelledError,
  type PanelLifecycleBackend,
  type PanelLifecycleState,
} from './panelLifecycle'
import type { ConnectionConfig, SessionInfo } from '../types/session'

const config = { id: 'conn-1', type: 'sftp' } as ConnectionConfig

function createFixture() {
  const panels = new Set(['panel-1'])
  const sessions = new Map<string, string | null>([['panel-1', null]])
  const initialized = new Set<string>()
  const removedSessions: string[] = []
  const removedPanels: string[] = []
  const closed: string[] = []
  const created: SessionInfo[] = []

  const backend: PanelLifecycleBackend = {
    createSession: async (type) => {
      const info = {
        id: `session-${created.length + 1}`,
        type,
        title: type,
        status: 'connecting',
      } as SessionInfo
      created.push(info)
      return info
    },
    closeSession: async (id) => {
      closed.push(id)
    },
    startSession: async () => {},
  }
  const state: PanelLifecycleState = {
    hasPanel: (id) => panels.has(id),
    getSessionId: (id) => sessions.get(id) ?? null,
    bindSession: (panelId, sessionId) => sessions.set(panelId, sessionId),
    unbindSession: (panelId) => sessions.set(panelId, null),
    initSession: (id) => initialized.add(id),
    removeSession: (id) => removedSessions.push(id),
    removePanel: (id) => {
      panels.delete(id)
      removedPanels.push(id)
    },
  }

  return {
    lifecycle: new PanelLifecycle(backend, state),
    backend,
    state,
    panels,
    sessions,
    initialized,
    removedSessions,
    removedPanels,
    closed,
    created,
  }
}

describe('PanelLifecycle', () => {
  it('creates, binds, and fully disposes a panel session', async () => {
    const fixture = createFixture()
    const info = await fixture.lifecycle.createSession('panel-1', 'sftp', config)

    expect(fixture.sessions.get('panel-1')).toBe(info.id)
    expect(fixture.initialized.has(info.id)).toBe(true)

    await fixture.lifecycle.disposePanel('panel-1')

    expect(fixture.closed).toEqual([info.id])
    expect(fixture.removedSessions).toEqual([info.id])
    expect(fixture.removedPanels).toEqual(['panel-1'])
    expect(fixture.sessions.get('panel-1')).toBeNull()
  })

  it('disposes panel-owned resources after the session', async () => {
    const fixture = createFixture()
    const order: string[] = []
    fixture.lifecycle.registerResource('panel-1', () => { order.push('resource') })

    await fixture.lifecycle.createSession('panel-1', 'sftp', config)
    order.push('session-created')
    await fixture.lifecycle.disposePanel('panel-1')

    expect(order).toEqual(['session-created', 'resource'])
  })

  it('closes a session that resolves after the panel was disposed', async () => {
    const fixture = createFixture()
    let resolveCreate!: (info: SessionInfo) => void
    const pending = new Promise<SessionInfo>(resolve => { resolveCreate = resolve })
    const lifecycle = new PanelLifecycle(
      {
        createSession: async () => pending,
        closeSession: async id => fixture.closed.push(id),
        startSession: async () => {},
      },
      fixture.state,
    )

    const create = lifecycle.createSession('panel-1', 'sftp', config)
    const dispose = lifecycle.disposePanel('panel-1')
    await dispose

    resolveCreate({ id: 'late-session', type: 'sftp', title: 'sftp', status: 'connecting' })
    await expect(create).rejects.toBeInstanceOf(PanelLifecycleCancelledError)
    expect(fixture.closed).toEqual(['late-session'])
    expect(fixture.sessions.get('panel-1')).toBeNull()
  })

  it('closes a session when starting it fails', async () => {
    const fixture = createFixture()
    const error = new Error('start failed')
    const startFailBackend: PanelLifecycleBackend = {
      createSession: fixture.backend.createSession,
      closeSession: async id => fixture.closed.push(id),
      startSession: async () => { throw error },
    }
    const lifecycle = new PanelLifecycle(startFailBackend, fixture.state)

    await expect(lifecycle.createSession('panel-1', 'local', config, { start: true })).rejects.toBe(error)
    expect(fixture.closed).toEqual(['session-1'])
  })
})
