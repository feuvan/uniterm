import { beforeEach, describe, expect, it, vi } from 'vitest'
const bindings = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(), start: vi.fn(), list: vi.fn() }))
vi.mock('../../bindings/github.com/ys-ll/uniterm/app', () => ({
  CreateSession: bindings.create, CloseSession: bindings.close,
  SessionStart: bindings.start, ListSessions: bindings.list,
}))
import { backendSessionApi } from './backendSessionApi'
import type { ConnectionConfig } from '../types/session'

const config: ConnectionConfig = {
  id: 'c', name: 'test', type: 'ssh', host: 'example.test', port: 22, user: 'u', authType: 'password',
}
const session = { id: 's', type: 'ssh', title: 'test', status: 'connecting' }
beforeEach(() => {
  bindings.create.mockReset().mockResolvedValue(session)
  bindings.close.mockReset().mockResolvedValue(undefined)
  bindings.start.mockReset().mockResolvedValue(undefined)
  bindings.list.mockReset().mockResolvedValue([session])
})

describe('backendSessionApi', () => {
  it('marshals through the generated model and preserves PTY size/runtime fields', async () => {
    const sized = { ...config, deferConnect: true, initialCols: 123, initialRows: 45 }
    expect(await backendSessionApi.createSession('ssh', sized)).toEqual(session)
    await backendSessionApi.startSession('s', sized)
    expect(bindings.create).toHaveBeenCalledWith('ssh', expect.objectContaining(sized))
    expect(bindings.start).toHaveBeenCalledWith('s', expect.objectContaining(sized))
    expect(await backendSessionApi.listSessions()).toEqual([session])
  })
  it('rejects an empty session instead of allowing a panel to bind undefined', async () => {
    bindings.create.mockResolvedValueOnce(null)
    await expect(backendSessionApi.createSession('ssh', config)).rejects.toThrow('empty session')
    expect(bindings.close).not.toHaveBeenCalled()
  })
  it('rolls back an invalid returned status before passing it to the lifecycle', async () => {
    bindings.create.mockResolvedValueOnce({ ...session, status: 'unknown' })
    await expect(backendSessionApi.createSession('ssh', config)).rejects.toThrow('Unknown backend session status')
    expect(bindings.close).toHaveBeenCalledExactlyOnceWith('s')
  })
})
