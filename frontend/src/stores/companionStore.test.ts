import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  create: vi.fn(), close: vi.fn(), list: vi.fn(),
}))
vi.mock('../../bindings/github.com/ys-ll/uniterm/app', () => ({
  CreateSession: api.create, CloseSession: api.close, ListSessions: api.list,
  SessionStart: vi.fn(async () => {}),
  DisableSessionOutputLog: vi.fn(async () => {}),
  RegisterSessionForPanel: vi.fn(async () => {}),
  UnregisterSession: vi.fn(async () => {}),
}))
vi.mock('@wailsio/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wailsio/runtime')>()),
  Events: { On: vi.fn(() => () => {}) },
}))

import { usePanelStore } from './panelStore'
import { useSessionStore } from './sessionStore'
import { useCompanionStore } from './companionStore'
import { usePanelLifecycle } from '../services/panelLifecycle'
import type { SessionInfo } from '../types/session'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const info = (id: string): SessionInfo => ({ id, type: 'sftp', status: 'connected', title: id })
let panelId: string

beforeEach(() => {
  setActivePinia(createPinia())
  api.create.mockReset().mockResolvedValue(info('child'))
  api.close.mockReset().mockResolvedValue(undefined)
  api.list.mockReset().mockResolvedValue([])
  panelId = usePanelStore().createPanel({
    id: 'ssh', name: 'SSH', type: 'ssh', host: 'example.test', port: 22,
    user: 'u', password: 'test', authType: 'password', deferConnect: true,
  }, 'ssh').id
})
afterEach(async () => { await usePanelLifecycle().disposePanel(panelId) })

describe('companion session ownership', () => {
  it.each(['ensureSftp', 'ensureMonitor'] as const)('%s shares one pending create between callers', async (method) => {
    const pending = deferred<SessionInfo>()
    api.create.mockReturnValueOnce(pending.promise)
    const store = useCompanionStore()
    const first = store[method](panelId)
    const second = store[method](panelId)
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    pending.resolve(info('shared'))
    expect(await Promise.all([first, second])).toEqual(['shared', 'shared'])
    expect(api.create).toHaveBeenCalledWith(method === 'ensureSftp' ? 'sftp' : 'monitor', expect.objectContaining({ deferConnect: false }))
  })

  it('does not recreate entries when a pending child resolves after panel close', async () => {
    const pending = deferred<SessionInfo>()
    api.create.mockReturnValueOnce(pending.promise)
    const store = useCompanionStore()
    const opening = store.ensureSftp(panelId)
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    await usePanelLifecycle().disposePanel(panelId)
    pending.resolve(info('late'))
    expect(await opening).toBeNull()
    expect(store.entries[panelId]).toBeUndefined()
    expect(api.close).toHaveBeenCalledExactlyOnceWith('late')
    expect(useSessionStore().sessions.has('late')).toBe(false)
  })

  it('does not let a disposed entry overwrite a newer companion attempt', async () => {
    const pending = deferred<SessionInfo>()
    api.create.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(info('new'))
    const store = useCompanionStore()
    const opening = store.ensureSftp(panelId)
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    await store.disposeForPanel(panelId)
    expect(await store.ensureSftp(panelId)).toBe('new')
    pending.resolve(info('old'))
    expect(await opening).toBeNull()
    expect(store.entries[panelId].sftpSessionId).toBe('new')
    expect(api.close).toHaveBeenCalledExactlyOnceWith('old')
  })

  it('drops child session buffers, transfer tasks and caches from lifecycle alone', async () => {
    const store = useCompanionStore()
    await store.ensureSftp(panelId)
    store.setFileViewCache(panelId, { cwd: '/', files: [] })
    store.toggleFollowPath(panelId)
    usePanelStore().getTransferTasks(`${panelId}__sftp`)
    await usePanelLifecycle().disposePanel(panelId)
    expect(store.entries[panelId]).toBeUndefined()
    expect(store.getFileViewCache(panelId)).toBeUndefined()
    expect(store.followPathByPanel[panelId]).toBeUndefined()
    expect(usePanelStore().transferTasks.has(`${panelId}__sftp`)).toBe(false)
    expect(useSessionStore().sessions.has('child')).toBe(false)
    expect(api.close).toHaveBeenCalledExactlyOnceWith('child')
    store.setFileViewCache(panelId, { cwd: '/late', files: [] })
    expect(store.getFileViewCache(panelId)).toBeUndefined()
  })

  it('respects SCP preference and uses wsl-file for a WSL owner', async () => {
    const panel = usePanelStore().getPanel(panelId)!
    panel.config!.fileTransferProto = 'scp'
    const store = useCompanionStore()
    await store.ensureSftp(panelId)
    expect(api.create).toHaveBeenLastCalledWith('scp', expect.objectContaining({ type: 'scp' }))
    await store.disposeForPanel(panelId)
    panel.type = 'wsl'
    panel.config!.type = 'wsl'
    await store.ensureSftp(panelId)
    expect(api.create).toHaveBeenLastCalledWith('wsl-file', expect.objectContaining({ type: 'wsl-file' }))
  })
})
