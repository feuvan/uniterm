import {
  CloseSession,
  CreateSession,
  ListSessions,
  SessionStart,
} from '../../bindings/github.com/ys-ll/uniterm/app'
import type { ConnectionConfig, SessionInfo, SessionStatus } from '../types/session'

export interface BackendSessionRecord {
  id: string
  type?: string
  status: SessionStatus | string
  title?: string
}

/**
 * Typed boundary around the generated Wails session bindings. Keeping the
 * generated JavaScript module here means lifecycle code and UI components do
 * not each need to cast its return values or know the binding path.
 */
export interface BackendSessionApi {
  createSession(sessionType: string, config: ConnectionConfig): Promise<SessionInfo>
  closeSession(sessionId: string): Promise<void>
  startSession(sessionId: string, config: ConnectionConfig): Promise<void>
  listSessions(): Promise<BackendSessionRecord[]>
}

export const backendSessionApi: BackendSessionApi = {
  createSession: async (sessionType, config) =>
    await CreateSession(sessionType, config) as SessionInfo,
  closeSession: async (sessionId) => {
    await CloseSession(sessionId)
  },
  startSession: async (sessionId, config) => {
    await SessionStart(sessionId, config)
  },
  listSessions: async () =>
    await ListSessions() as BackendSessionRecord[],
}
