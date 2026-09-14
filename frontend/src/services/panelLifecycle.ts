import { usePanelStore } from '../stores/panelStore'
import { useSessionStore } from '../stores/sessionStore'
import { backendSessionApi } from './backendSessionApi'
import { unregisterTransferRoute } from './transferTaskCenter'
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
 * Owns primary/child sessions and protocol resources, independent of the UI
 * tab kind. All async results are checked against the operation that requested
 * them. Closing invalidates operations synchronously, before any IPC is awaited.
 * The injected backend/state adapters allow deterministic race tests.
 */
export class PanelLifecycle {
  private nextGeneration = 0
  private generations = new Map<string, number>()
  private closingPanels = new Set<string>()
  private sessions = new Map<string, Set<string>>()
  private resources = new Map<string, Set<() => void | Promise<void>>>()
  private closingSessions = new Map<string, Promise<void>>()
  private sessionDisposals = new Map<string, Promise<void>>()
  private panelDisposals = new Map<string, Promise<void>>()

  constructor(
    private readonly backend: PanelLifecycleBackend,
    private readonly state: PanelLifecycleState,
  ) {}

  isOpen(panelId: string): boolean {
    return this.state.hasPanel(panelId) && !this.closingPanels.has(panelId)
  }

  /** Start a new operation and invalidate the previous operation for a panel. */
  begin(panelId: string): number {
    if (!this.isOpen(panelId)) throw new PanelLifecycleCancelledError()
    return this.invalidate(panelId)
  }

  isCurrent(panelId: string, generation: number): boolean {
    return this.generations.get(panelId) === generation && this.isOpen(panelId)
  }

  /** Register a panel-owned client/manager. The returned function unregisters it. */
  registerResource(panelId: string, dispose: () => void | Promise<void>): () => void {
    if (!this.isOpen(panelId)) {
      void Promise.resolve().then(dispose).catch(() => {})
      return () => {}
    }
    let panelResources = this.resources.get(panelId)
    if (!panelResources) {
      panelResources = new Set()
      this.resources.set(panelId, panelResources)
    }
    panelResources.add(dispose)
    return () => {
      panelResources.delete(dispose)
      if (!panelResources.size && this.resources.get(panelId) === panelResources) {
        this.resources.delete(panelId)
      }
    }
  }

  async createSession(
    panelId: string,
    sessionType: string,
    config: ConnectionConfig,
    options: SessionCreateOptions = {},
  ): Promise<SessionInfo> {
    const generation = this.begin(panelId)
    // Also handles callers that replace a session without an explicit dispose.
    // The token is captured BEFORE waiting: an older reconnect cannot wake up
    // after a newer one and supersede it.
    await this.releaseSessions(panelId)
    if (!this.isCurrent(panelId, generation)) throw new PanelLifecycleCancelledError()

    const info = await this.backend.createSession(sessionType, config)
    await this.adoptSession(panelId, info.id, generation)
    if (!this.isCurrent(panelId, generation)) {
      await this.disposeOwnedSession(panelId, info.id)
      throw new PanelLifecycleCancelledError()
    }
    if (options.start) await this.startSession(panelId, info.id, config)
    return info
  }

  /** Create a companion without replacing the panel's primary binding. */
  async createChildSession(
    panelId: string,
    sessionType: string,
    config: ConnectionConfig,
  ): Promise<SessionInfo> {
    if (!this.isOpen(panelId)) throw new PanelLifecycleCancelledError()
    const generation = this.generations.get(panelId) ?? this.begin(panelId)
    await this.sessionDisposals.get(panelId)
    if (!this.isCurrent(panelId, generation)) throw new PanelLifecycleCancelledError()
    const info = await this.backend.createSession(sessionType, config)
    if (!this.isCurrent(panelId, generation)) {
      await this.closeQuietly(info.id)
      throw new PanelLifecycleCancelledError()
    }
    this.trackSession(panelId, info.id)
    try {
      this.state.initSession(info.id)
    } catch (error) {
      await this.disposeOwnedSession(panelId, info.id)
      throw error
    }
    return info
  }

  async disposeOwnedSession(panelId: string, sessionId: string): Promise<void> {
    const owned = this.sessions.get(panelId)?.delete(sessionId)
    const bound = this.state.getSessionId(panelId) === sessionId
    if (bound) this.state.unbindSession(panelId)
    if (!this.sessions.get(panelId)?.size) this.sessions.delete(panelId)
    if (owned || bound) await this.closeQuietly(sessionId)
    else await this.closingSessions.get(sessionId)
  }

  /** Adopt an exec session returned by a protocol-specific endpoint. */
  async adoptSession(panelId: string, sessionId: string, generation: number): Promise<void> {
    if (!this.isCurrent(panelId, generation)) {
      await this.closeQuietly(sessionId)
      throw new PanelLifecycleCancelledError()
    }
    this.trackSession(panelId, sessionId)
    try {
      this.state.initSession(sessionId)
      this.state.bindSession(panelId, sessionId)
    } catch (error) {
      await this.disposeOwnedSession(panelId, sessionId)
      throw error
    }
  }

  /** Start only after the terminal has measured its actual PTY dimensions. */
  async startSession(panelId: string, sessionId: string, config: ConnectionConfig): Promise<void> {
    const generation = this.generations.get(panelId)
    const isCurrent = () => generation !== undefined
      && this.isCurrent(panelId, generation)
      && this.state.getSessionId(panelId) === sessionId
    if (!isCurrent()) {
      await this.disposeOwnedSession(panelId, sessionId)
      throw new PanelLifecycleCancelledError()
    }
    try {
      await this.backend.startSession(sessionId, config)
      if (!isCurrent()) throw new PanelLifecycleCancelledError()
    } catch (error) {
      await this.disposeOwnedSession(panelId, sessionId)
      throw error
    }
  }

  /** Close primary and child sessions while retaining the panel for retry. */
  disposeSession(panelId: string): Promise<void> {
    if (!this.state.hasPanel(panelId)) return Promise.resolve()
    this.invalidate(panelId)
    return this.releaseSessions(panelId)
  }

  /** Mark closed immediately; all callers share the same in-flight teardown. */
  disposePanel(panelId: string): Promise<void> {
    const existing = this.panelDisposals.get(panelId)
    if (existing) return existing
    if (!this.state.hasPanel(panelId)) return Promise.resolve()
    this.closingPanels.add(panelId)
    this.invalidate(panelId)
    // Defer the work until the promise is registered, including for reentrant
    // calls from resource disposers and reactive state watchers.
    const disposal = Promise.resolve().then(() => this.disposePanelInternal(panelId)).finally(() => {
      this.panelDisposals.delete(panelId)
      this.closingPanels.delete(panelId)
      this.generations.delete(panelId)
    })
    this.panelDisposals.set(panelId, disposal)
    return disposal
  }

  async disposePanels(panelIds: string[]): Promise<void> {
    // Invalidate EVERY panel before waiting on the first slow backend close.
    await Promise.all(panelIds.map(panelId => this.disposePanel(panelId)))
  }

  private invalidate(panelId: string): number {
    const generation = ++this.nextGeneration
    this.generations.set(panelId, generation)
    return generation
  }

  private releaseSessions(panelId: string): Promise<void> {
    const existing = this.sessionDisposals.get(panelId)
    if (existing) return existing
    const disposal = Promise.resolve().then(async () => {
      const ids = new Set(this.sessions.get(panelId) ?? [])
      const currentId = this.state.getSessionId(panelId)
      if (currentId) ids.add(currentId)
      // Reverse creation order releases children before their parent session.
      for (const sessionId of [...ids].reverse()) {
        await this.disposeOwnedSession(panelId, sessionId)
      }
    }).finally(() => this.sessionDisposals.delete(panelId))
    this.sessionDisposals.set(panelId, disposal)
    return disposal
  }

  private async disposePanelInternal(panelId: string): Promise<void> {
    const panelResources = this.resources.get(panelId)
    this.resources.delete(panelId)
    // Stop clients/streams before shutting down the session/proxy they use.
    for (const dispose of [...(panelResources ?? [])].reverse()) {
      try { await dispose() } catch { /* release the rest even if one fails */ }
    }
    await this.releaseSessions(panelId)
    this.state.removePanel(panelId)
  }

  private trackSession(panelId: string, sessionId: string): void {
    let ids = this.sessions.get(panelId)
    if (!ids) {
      ids = new Set()
      this.sessions.set(panelId, ids)
    }
    ids.add(sessionId)
  }

  private closeQuietly(sessionId: string): Promise<void> {
    const existing = this.closingSessions.get(sessionId)
    if (existing) return existing
    const disposal = Promise.resolve().then(async () => {
      try {
        await this.backend.closeSession(sessionId)
      } catch {
        // State cleanup must continue even if the backend already removed it.
      } finally {
        // Includes early events from late/never-bound CreateSession results.
        this.state.removeSession(sessionId)
      }
    }).finally(() => this.closingSessions.delete(sessionId))
    this.closingSessions.set(sessionId, disposal)
    return disposal
  }
}

function createDefaultLifecycle(): PanelLifecycle {
  const panelStore = usePanelStore()
  const sessionStore = useSessionStore()
  return new PanelLifecycle(backendSessionApi, {
    hasPanel: (panelId) => !!panelStore.getPanel(panelId),
    getSessionId: (panelId) => panelStore.getPanel(panelId)?.sessionId ?? null,
    bindSession: (panelId, sessionId) => panelStore.bindSession(panelId, sessionId),
    unbindSession: (panelId) => panelStore.unbindSession(panelId),
    initSession: (sessionId) => sessionStore.initSession(sessionId),
    removeSession: (sessionId) => {
      unregisterTransferRoute(sessionId)
      sessionStore.removeSession(sessionId)
    },
    removePanel: (panelId) => panelStore.removePanel(panelId),
  })
}

// A lifecycle belongs to its Pinia panel store, not to a previous test/app's
// stores. Weak keys also avoid keeping an unmounted application's stores alive.
const lifecycles = new WeakMap<ReturnType<typeof usePanelStore>, PanelLifecycle>()

export function usePanelLifecycle(): PanelLifecycle {
  const panelStore = usePanelStore()
  let lifecycle = lifecycles.get(panelStore)
  if (!lifecycle) {
    lifecycle = createDefaultLifecycle()
    lifecycles.set(panelStore, lifecycle)
  }
  return lifecycle
}
