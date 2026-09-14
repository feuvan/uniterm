import {
  CloseSession,
  CreateSession,
  SessionStart,
} from '../../bindings/github.com/ys-ll/uniterm/app'
import { usePanelStore } from '../stores/panelStore'
import { useSessionStore } from '../stores/sessionStore'
import type { ConnectionConfig, SessionInfo } from '../types/session'

export interface PanelLifecycleBackend {
  createSession(sessionType: string, config: ConnectionConfig): Promise<SessionInfo>
  closeSession(sessionId: string): Promise<void>
  startSession(sessionId: string, config: ConnectionConfig): Promise<void>
}

export interface PanelLifecycleState {
  hasPanel(panelId: string): boolean
  getSessionId(panelId: string): string | null
  bindSession(panelId: string, sessionId: string): void
  unbindSession(panelId: string): void
  initSession(sessionId: string): void
  removeSession(sessionId: string): void
  removePanel(panelId: string): void
}

export interface SessionCreateOptions {
  start?: boolean
}

export class PanelLifecycleCancelledError extends Error {
  constructor() {
    super('Panel lifecycle operation was cancelled')
    this.name = 'PanelLifecycleCancelledError'
  }
}

/**
 * Owns the backend sessions attached to panels.
 *
 * The class is deliberately independent of Pinia and Wails. The production
 * instance is wired by usePanelLifecycle(), while tests can inject a small
 * fake backend and state adapter. A generation is advanced whenever a panel
 * is closed or a new session operation starts, so a late CreateSession result
 * can never be attached to a panel that has already moved on.
 */
export class PanelLifecycle {
  private generations = new Map<string, number>()
  private disposedPanels = new Set<string>()
  private sessions = new Map<string, Set<string>>()
  private resources = new Map<string, Set<() => void | Promise<void>>>()
  private sessionDisposals = new Map<string, Promise<void>>()
  private panelDisposals = new Map<string, Promise<void>>()

  constructor(
    private readonly backend: PanelLifecycleBackend,
    private readonly state: PanelLifecycleState,
  ) {}

  /** Start a new operation and invalidate the previous operation for a panel. */
  begin(panelId: string): number {
    const generation = (this.generations.get(panelId) ?? 0) + 1
    this.generations.set(panelId, generation)
    return generation
  }

  isCurrent(panelId: string, generation: number): boolean {
    return this.generations.get(panelId) === generation && this.state.hasPanel(panelId)
  }

  /**
   * Register a non-session resource owned by a panel, such as a proxy,
   * manager connection, child process, or companion session.
   */
  registerResource(panelId: string, dispose: () => void | Promise<void>): () => void {
    if (this.disposedPanels.has(panelId)) {
      Promise.resolve().then(dispose).catch(() => {})
      return () => {}
    }
    let panelResources = this.resources.get(panelId)
    if (!panelResources) {
      panelResources = new Set()
      this.resources.set(panelId, panelResources)
    }
    panelResources.add(dispose)
    return () => panelResources?.delete(dispose)
  }

  async createSession(
    panelId: string,
    sessionType: string,
    config: ConnectionConfig,
    options: SessionCreateOptions = {},
  ): Promise<SessionInfo> {
    if (!this.state.hasPanel(panelId)) {
      throw new Error(`Cannot create a session for missing panel ${panelId}`)
    }

    const generation = this.begin(panelId)
    let info: SessionInfo | undefined
    try {
      info = await this.backend.createSession(sessionType, config)
      if (!this.isCurrent(panelId, generation)) {
        await this.closeQuietly(info.id)
        throw new PanelLifecycleCancelledError()
      }

      this.trackSession(panelId, info.id)
      this.state.initSession(info.id)
      this.state.bindSession(panelId, info.id)

      if (options.start) {
        try {
          await this.backend.startSession(info.id, config)
        } catch (error) {
          await this.closeSessionAfterFailure(panelId, info.id)
          throw error
        }
      }
      return info
    } catch (error) {
      // createSession can fail before an info value exists. If it did return
      // an id, closeSessionAfterFailure has already handled start failures;
      // this branch only handles an error thrown after a successful create.
      if (info && this.isTracked(panelId, info.id)) {
        await this.closeSessionAfterFailure(panelId, info.id)
      }
      throw error
    }
  }

  /**
   * Adopt a session created by a protocol-specific endpoint such as K8s exec
   * or container exec. The caller starts the generation before its async IPC
   * call and passes it back here to get the same late-result protection as
   * CreateSession.
   */
  async adoptSession(panelId: string, sessionId: string, generation: number): Promise<void> {
    if (!this.isCurrent(panelId, generation)) {
      await this.closeQuietly(sessionId)
      throw new PanelLifecycleCancelledError()
    }
    this.trackSession(panelId, sessionId)
    this.state.initSession(sessionId)
    this.state.bindSession(panelId, sessionId)
  }

  /** Start a session that was created and bound earlier, such as a terminal. */
  async startSession(panelId: string, sessionId: string, config: ConnectionConfig): Promise<void> {
    if (!this.state.hasPanel(panelId) || this.state.getSessionId(panelId) !== sessionId) {
      await this.closeQuietly(sessionId)
      throw new PanelLifecycleCancelledError()
    }
    try {
      await this.backend.startSession(sessionId, config)
    } catch (error) {
      await this.closeSessionAfterFailure(panelId, sessionId)
      throw error
    }
  }

  /** Close the currently attached session while keeping the panel alive. */
  async disposeSession(panelId: string): Promise<void> {
    const existing = this.sessionDisposals.get(panelId)
    if (existing) return existing

    const disposal = this.disposeSessionInternal(panelId).finally(() => {
      this.sessionDisposals.delete(panelId)
    })
    this.sessionDisposals.set(panelId, disposal)
    return disposal
  }

  /** Close all resources and remove the panel's frontend state. */
  async disposePanel(panelId: string): Promise<void> {
    const existing = this.panelDisposals.get(panelId)
    if (existing) return existing
    this.disposedPanels.add(panelId)

    const disposal = this.disposePanelInternal(panelId).finally(() => {
      this.panelDisposals.delete(panelId)
    })
    this.panelDisposals.set(panelId, disposal)
    return disposal
  }

  async disposePanels(panelIds: string[]): Promise<void> {
    for (const panelId of panelIds) {
      await this.disposePanel(panelId)
    }
  }

  private async disposeSessionInternal(panelId: string): Promise<void> {
    // Invalidates pending CreateSession continuations before collecting the
    // currently known ids. A late result will see the new generation and close
    // itself when the IPC promise resolves.
    this.begin(panelId)

    const ids = new Set(this.sessions.get(panelId) ?? [])
    const currentId = this.state.getSessionId(panelId)
    if (currentId) ids.add(currentId)

    this.sessions.delete(panelId)
    this.state.unbindSession(panelId)
    for (const sessionId of ids) {
      await this.closeQuietly(sessionId)
      this.state.removeSession(sessionId)
    }
  }

  private async disposePanelInternal(panelId: string): Promise<void> {
    await this.disposeSession(panelId)

    const panelResources = this.resources.get(panelId)
    this.resources.delete(panelId)
    if (panelResources) {
      // Dispose in reverse registration order so child resources go first.
      for (const dispose of [...panelResources].reverse()) {
        try {
          await dispose()
        } catch {
          // A panel close should release every remaining resource even if one
          // protocol-specific disposer has already failed.
        }
      }
    }

    this.state.removePanel(panelId)
    this.generations.delete(panelId)
  }

  private trackSession(panelId: string, sessionId: string): void {
    let ids = this.sessions.get(panelId)
    if (!ids) {
      ids = new Set()
      this.sessions.set(panelId, ids)
    }
    ids.add(sessionId)
  }

  private isTracked(panelId: string, sessionId: string): boolean {
    return this.sessions.get(panelId)?.has(sessionId) ?? false
  }

  private async closeSessionAfterFailure(panelId: string, sessionId: string): Promise<void> {
    this.sessions.get(panelId)?.delete(sessionId)
    if (this.state.getSessionId(panelId) === sessionId) {
      this.state.unbindSession(panelId)
    }
    this.state.removeSession(sessionId)
    await this.closeQuietly(sessionId)
  }

  private async closeQuietly(sessionId: string): Promise<void> {
    try {
      await this.backend.closeSession(sessionId)
    } catch {
      // Closing is best-effort. The state cleanup must continue even when the
      // backend has already removed the session or the Wails call fails.
    }
  }
}

function createDefaultLifecycle(): PanelLifecycle {
  const panelStore = usePanelStore()
  const sessionStore = useSessionStore()
  return new PanelLifecycle(
    {
      createSession: (sessionType, config) => CreateSession(sessionType, config) as Promise<SessionInfo>,
      closeSession: (sessionId) => CloseSession(sessionId),
      startSession: (sessionId, config) => SessionStart(sessionId, config),
    },
    {
      hasPanel: (panelId) => !!panelStore.getPanel(panelId),
      getSessionId: (panelId) => panelStore.getPanel(panelId)?.sessionId ?? null,
      bindSession: (panelId, sessionId) => panelStore.bindSession(panelId, sessionId),
      unbindSession: (panelId) => panelStore.unbindSession(panelId),
      initSession: (sessionId) => sessionStore.initSession(sessionId),
      removeSession: (sessionId) => sessionStore.removeSession(sessionId),
      removePanel: (panelId) => panelStore.removePanel(panelId),
    },
  )
}

let defaultLifecycle: PanelLifecycle | null = null

export function usePanelLifecycle(): PanelLifecycle {
  if (!defaultLifecycle) defaultLifecycle = createDefaultLifecycle()
  return defaultLifecycle
}
