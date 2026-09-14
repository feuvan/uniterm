import {
  CloseSession,
  CreateSession,
  ListSessions,
  SessionStart,
} from '../../bindings/github.com/ys-ll/uniterm/app'
import {
  ConnectionConfig as BackendConnectionConfig,
  PostLoginExpectStep as BackendExpectStep,
  type SessionInfo as BackendSessionInfo,
} from '../../bindings/github.com/ys-ll/uniterm/backend/session/models'
import type { ConnectionConfig, SessionInfo, SessionStatus } from '../types/session'

export type BackendSessionRecord = SessionInfo

export interface BackendSessionApi {
  createSession(sessionType: string, config: ConnectionConfig): Promise<SessionInfo>
  closeSession(sessionId: string): Promise<void>
  startSession(sessionId: string, config: ConnectionConfig): Promise<void>
  listSessions(): Promise<BackendSessionRecord[]>
}

function connectionConfig(config: ConnectionConfig): BackendConnectionConfig {
  return new BackendConnectionConfig({
    ...config,
    postLoginExpectSteps: config.postLoginExpectSteps?.map(step => new BackendExpectStep(step)),
  })
}

function sessionStatus(status: string): SessionStatus {
  switch (status) {
    case 'connecting': case 'connected': case 'disconnected': case 'error': return status
    default: throw new Error(`Unknown backend session status: ${status}`)
  }
}

function sessionInfo(info: BackendSessionInfo | null): SessionInfo {
  if (!info?.id) throw new Error('Backend returned an empty session')
  return { ...info, status: sessionStatus(info.status) }
}

export type DesktopSessionResolution =
  | { kind: 'missing' | 'disconnected' | 'error' }
  | { kind: 'connect'; proxyAddr: string }

export function resolveDesktopSession(
  info: SessionInfo | undefined,
  expectedType: 'vnc' | 'spice',
  cachedProxy?: string,
): DesktopSessionResolution {
  if (!info || info.type !== expectedType) return { kind: 'missing' }
  if (info.status === 'error') return { kind: 'error' }
  if (info.status === 'disconnected') return { kind: 'disconnected' }
  const proxyAddr = info.proxyAddr || cachedProxy
  return proxyAddr ? { kind: 'connect', proxyAddr } : { kind: 'error' }
}


/**
 * Generated Go models supply defaults for optional frontend config fields.
 * Generated declarations check the IPC boundary; returned status values are
 * narrowed here rather than asserted independently by every consumer.
 */
export const backendSessionApi: BackendSessionApi = {
  createSession: async (sessionType, config) => {
    const info = await CreateSession(sessionType, connectionConfig(config))
    try {
      return sessionInfo(info)
    } catch (error) {
      if (info?.id) await CloseSession(info.id).catch(() => {})
      throw error
    }
  },
  closeSession: async (sessionId) => { await CloseSession(sessionId) },
  startSession: async (sessionId, config) => {
    await SessionStart(sessionId, connectionConfig(config))
  },
  listSessions: async () => (await ListSessions() ?? []).map(sessionInfo),
}
