import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('../../bindings/github.com/ys-ll/uniterm/app', () => ({
  DisableSessionOutputLog: vi.fn(async () => {}),
  RegisterSessionForPanel: vi.fn(async () => {}),
  UnregisterSession: vi.fn(async () => {}),
}))
import { usePanelStore } from './panelStore'

beforeEach(() => { setActivePinia(createPinia()) })

describe('panel UI resource cleanup', () => {
  it('transfers desktop caches without disconnecting their live clients', () => {
    const store = usePanelStore()
    const panel = store.createPanel(null, 'vnc')
    const rfb = { disconnect: vi.fn() }
    const sc = { stop: vi.fn() }
    const container = { parentNode: null } as HTMLDivElement
    store.setVNCCache(panel.id, { rfb, container })
    store.setSPICECache(panel.id, { sc, container })
    expect(store.takeVNCCache(panel.id)?.rfb).toEqual(rfb)
    expect(store.takeSPICECache(panel.id)?.sc).toEqual(sc)
    store.removePanel(panel.id)
    expect(rfb.disconnect).not.toHaveBeenCalled()
    expect(sc.stop).not.toHaveBeenCalled()
  })

  it('destroys cached clients and auxiliary state when a panel is removed', () => {
    const store = usePanelStore()
    const panel = store.createPanel(null, 'vnc')
    const rfb = { disconnect: vi.fn() }
    const sc = { stop: vi.fn() }
    const removeChild = vi.fn()
    const container = { parentNode: { removeChild } } as unknown as HTMLDivElement
    store.setVNCCache(panel.id, { rfb, container })
    store.setSPICECache(panel.id, { sc, container })
    store.setProxyAddr(panel.id, 'ws://127.0.0.1')
    store.getTransferTasks(panel.id)
    store.removePanel(panel.id)
    store.removePanel(panel.id)
    expect(rfb.disconnect).toHaveBeenCalledTimes(1)
    expect(sc.stop).toHaveBeenCalledTimes(1)
    expect(removeChild).toHaveBeenCalledTimes(2)
    expect(store.getProxyAddr(panel.id)).toBeUndefined()
    expect(store.transferTasks.has(panel.id)).toBe(false)
  })
})
