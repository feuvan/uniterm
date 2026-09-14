import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
const api = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(), list: vi.fn() }))
vi.mock('../../bindings/github.com/ys-ll/uniterm/app', () => ({
  CreateSession: api.create, CloseSession: api.close, ListSessions: api.list,
  SessionStart: vi.fn(async () => {}),
  DisableSessionOutputLog: vi.fn(async () => {}),
  RegisterSessionForPanel: vi.fn(async () => {}), UnregisterSession: vi.fn(async () => {}),
}))
import { usePanelStore } from '../stores/panelStore'
import { usePanelLifecycle } from '../services/panelLifecycle'
import { isPanelReconnecting, reconnectFileTransferPanel } from './usePanelReconnect'

const session = { id: 'new-session', type: 'sftp', title: 'test', status: 'connected' }
let panelId: string
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  api.create.mockReset().mockResolvedValue(session)
  api.close.mockReset().mockResolvedValue(undefined)
  api.list.mockReset().mockResolvedValue([session])
  panelId = usePanelStore().createPanel({
    id: 'file', name: 'test', type: 'sftp', host: 'example.test', port: 22, user: 'u', authType: 'password',
  }, 'sftp').id
})
afterEach(async () => {
  await usePanelLifecycle().disposePanel(panelId)
  vi.useRealTimers()
})

describe('file panel reconnect', () => {
  it('shares one reconnect and returns only a connected replacement', async () => {
    const first = reconnectFileTransferPanel(panelId)
    expect(reconnectFileTransferPanel(panelId)).toBe(first)
    expect(isPanelReconnecting(panelId)).toBe(true)
    expect(await first).toBe(session.id)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(isPanelReconnecting(panelId)).toBe(false)
  })

  it.each(['error', 'connecting'])('reclaims a replacement on %s or timeout', async (status) => {
    api.list.mockResolvedValue([{ ...session, status }])
    const result = reconnectFileTransferPanel(panelId)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await result).toBeNull()
    expect(usePanelStore().getPanel(panelId)?.sessionId).toBeNull()
    expect(api.close).toHaveBeenCalledExactlyOnceWith(session.id)
    expect(isPanelReconnecting(panelId)).toBe(false)
  })

  it('ignores a connected status response arriving after panel close', async () => {
    let respond!: (records: typeof session[]) => void
    api.list.mockReturnValueOnce(new Promise(resolve => { respond = resolve }))
    const result = reconnectFileTransferPanel(panelId)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.list).toHaveBeenCalledTimes(1)
    await usePanelLifecycle().disposePanel(panelId)
    respond([session])
    await expect(result).rejects.toMatchObject({
      name: 'PanelLifecycleCancelledError',
      message: 'Panel lifecycle operation was cancelled',
    })
    expect(api.close).toHaveBeenCalledExactlyOnceWith(session.id)
    expect(isPanelReconnecting(panelId)).toBe(false)
  })
})
