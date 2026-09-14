import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// sessionStore (imported by containerStore) calls EventsOn at module load; stub it.
vi.mock('@wailsio/runtime', async (importOriginal) => ({
  ...(await importOriginal()),
  Events: { On: vi.fn(() => () => {}), Off: vi.fn() },
}))

vi.mock('../services/containerClient', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  list: vi.fn().mockResolvedValue([
    { id: 'a1', name: 'web', image: 'nginx', state: 'running', status: 'Up', ports: '', createdAt: '' },
  ]),
  inspect: vi.fn(),
  action: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn(),
  stats: vi.fn().mockResolvedValue([]),
  images: vi.fn().mockResolvedValue([]),
  removeImage: vi.fn(),
  create: vi.fn(),
  namespaces: vi.fn().mockResolvedValue([]),
  setNamespace: vi.fn().mockResolvedValue(undefined),
  startLogs: vi.fn(),
  startPull: vi.fn(),
}))

import { useContainerStore } from './containerStore'
import { usePanelStore } from './panelStore'
import { usePanelLifecycle } from '../services/panelLifecycle'
import * as client from '../services/containerClient'

const tab = { type: 'container' as const, id: 'tab1', panelId: 'p1', name: 'c', connectionId: 'conn1', runtime: 'docker' as const }

describe('containerStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    tab.panelId = usePanelStore().createPanel(null, 'container').id
  })

  afterEach(async () => {
    await usePanelLifecycle().disposePanel(tab.panelId)
    const store = useContainerStore()
    Object.keys(store.sessions).forEach(id => store.close(id))
  })

  it('open connects and loads containers', async () => {
    const store = useContainerStore()
    await store.open(tab)
    expect(client.connect).toHaveBeenCalledWith('conn1')
    const s = store.sessions['tab1']
    expect(s.containers).toHaveLength(1)
    expect(s.containers[0].name).toBe('web')
    expect(s.error).toBe('')
  })

  it('open surfaces connect error', async () => {
    vi.mocked(client.connect).mockRejectedValueOnce(new Error('docker not found'))
    const store = useContainerStore()
    await store.open(tab)
    expect(store.sessions['tab1'].error).toContain('docker not found')
  })

  it('action calls client and refreshes', async () => {
    const store = useContainerStore()
    await store.open(tab)
    await store.action('tab1', 'a1', 'stop')
    expect(client.action).toHaveBeenCalledWith('conn1', 'a1', 'stop')
    expect(client.list).toHaveBeenCalledTimes(2)
  })

  it('closes the connection from panel lifecycle without a component unmount', async () => {
    const store = useContainerStore()
    await store.open(tab)
    await usePanelLifecycle().disposePanel(tab.panelId)
    expect(client.disconnect).toHaveBeenCalledExactlyOnceWith('conn1')
    expect(store.sessions['tab1']).toBeUndefined()
  })

  it('releases a connection that finishes after its panel was closed', async () => {
    let finish!: () => void
    vi.mocked(client.connect).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    const store = useContainerStore()
    const opening = store.open(tab)
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1))
    await usePanelLifecycle().disposePanel(tab.panelId)
    expect(store.sessions['tab1']).toBeUndefined()
    finish()
    await opening
    expect(client.disconnect).toHaveBeenCalledWith('conn1')
    expect(store.sessions['tab1']).toBeUndefined()
  })

  it('serializes a replacement behind a pending connect and its late cleanup', async () => {
    let finish!: () => void
    vi.mocked(client.connect).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    const store = useContainerStore()
    const opening = store.open(tab)
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(1))
    await store.close(tab.id)
    const replacement = store.open(tab)
    expect(client.connect).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([opening, replacement])
    expect(client.connect).toHaveBeenCalledTimes(2)
    const closedAt = vi.mocked(client.disconnect).mock.invocationCallOrder
    const openedAt = vi.mocked(client.connect).mock.invocationCallOrder
    expect(closedAt[closedAt.length - 1]).toBeLessThan(openedAt[1])
    expect(store.sessions[tab.id].containers).toHaveLength(1)
  })

  it('close disconnects and drops session', async () => {
    const store = useContainerStore()
    await store.open(tab)
    store.close('tab1')
    expect(client.disconnect).toHaveBeenCalledWith('conn1')
    expect(store.sessions['tab1']).toBeUndefined()
  })
})
