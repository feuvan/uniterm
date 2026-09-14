import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { backendSessionApi } from '../services/backendSessionApi'
import { usePanelStore } from './panelStore'
import { useSessionStore } from './sessionStore'
import { useTabStore } from './tabStore'
import { isPanelLifecycleCancelled, usePanelLifecycle } from '../services/panelLifecycle'
import { useConnectionStore } from './connectionStore'
import { fileTransferProto } from '../utils/fileTransferUtils'
import { unregisterTransferRoute } from '../services/transferTaskCenter'
import type { ConnectionConfig } from '../types/session'

export interface CompanionEntry {
  sftpSessionId?: string
  monitorSessionId?: string
  creatingSftp?: boolean
  creatingMonitor?: boolean
}

const DEFAULT_FILES_WIDTH = 300
const DEFAULT_MONITOR_WIDTH = 320

// Per-SSH-panel caches of the companion views, so switching between terminal
// tabs restores the previously loaded file listing / monitor graphs instead of
// re-fetching them. Keyed by the SSH panel id.
export interface FileViewCache {
  cwd: string
  files: unknown[]
}
export interface MonitorViewCache {
  systemInfo: Record<string, any> | null
  systemInfoAt: number
  cpu: Record<string, any>
  mem: Record<string, any>
  swap: Record<string, any>
  net: Record<string, any>
  // Expandable detail lists / their expansion state, kept per panel so the
  // sidebar restores them on return.
  cpus: any[]
  nets: any[]
  disks: any[]
  expanded: { cores: boolean; nets: boolean; disks: boolean }
}

export const useCompanionStore = defineStore('companion', () => {
  const filesVisible = ref(false)
  const monitorVisible = ref(false)
  const filesWidth = ref(DEFAULT_FILES_WIDTH)
  const monitorWidth = ref(DEFAULT_MONITOR_WIDTH)
  const entries = ref<Record<string, CompanionEntry>>({})
  const fileViewCache = ref<Record<string, FileViewCache>>({})
  const monitorViewCache = ref<Record<string, MonitorViewCache>>({})
  // Per-files-panel "follow terminal path" flag (sidebar navigates when the
  // terminal's shell reports a cwd change). Ephemeral by design: never
  // persisted, resets with the session.
  const followPathByPanel = ref<Record<string, boolean>>({})

  const panelStore = usePanelStore()
  const sessionStore = useSessionStore()
  const tabStore = useTabStore()
  const lifecycle = usePanelLifecycle()
  const pendingSftp = new Map<string, Promise<string | null>>()
  const pendingMonitor = new Map<string, Promise<string | null>>()
  const resourceReleases = new Map<string, () => void>()

  function getActiveSshPanelId(): string | null {
    const pid = tabStore.getActivePanelId()
    if (!pid) return null
    const panel = panelStore.getPanel(pid)
    if (!panel || panel.type !== 'ssh') return null
    return pid
  }

  function getActiveWslPanelId(): string | null {
    const pid = tabStore.getActivePanelId()
    if (!pid) return null
    const panel = panelStore.getPanel(pid)
    if (!panel || panel.type !== 'wsl') return null
    return pid
  }

  /** Active panel that owns a file sidebar: an SSH panel or a WSL terminal. */
  function getActiveFilesPanelId(): string | null {
    return getActiveSshPanelId() ?? getActiveWslPanelId()
  }

  function isWslPanel(pid: string | null): boolean {
    if (!pid) return false
    return panelStore.getPanel(pid)?.type === 'wsl'
  }

  const activeSshPanelId = computed(() => getActiveSshPanelId())

  const activeFilesPanelId = computed(() => getActiveFilesPanelId())

  const sshConnected = computed(() => {
    const pid = activeSshPanelId.value
    if (!pid) return false
    const panel = panelStore.getPanel(pid)
    if (!panel?.sessionId) return false
    return sessionStore.getStatus(panel.sessionId) === 'connected'
  })

  // File sidebar is available for a connected SSH panel or a running WSL terminal.
  const filesConnected = computed(() => {
    const pid = activeFilesPanelId.value
    if (!pid) return false
    const panel = panelStore.getPanel(pid)
    if (!panel?.sessionId) return false
    return sessionStore.getStatus(panel.sessionId) === 'connected'
  })

  const canToggle = computed(() => filesConnected.value)

  const currentSftpSessionId = computed(() => {
    const pid = activeFilesPanelId.value
    if (!pid) return null
    return entries.value[pid]?.sftpSessionId ?? null
  })

  const currentMonitorSessionId = computed(() => {
    const pid = activeSshPanelId.value
    if (!pid) return null
    return entries.value[pid]?.monitorSessionId ?? null
  })

  // Companion file-panel transfer lists are stored in panelStore under a key
  // derived from the owning (SSH/WSL) panel id. Terminal tabs use the same
  // helper to surface active companion transfers on their tab.
  function sftpTransferKeyOf(panelId: string): string {
    return panelId ? `${panelId}__sftp` : ''
  }

  const transferKey = computed(() => sftpTransferKeyOf(getActiveFilesPanelId() ?? ''))

  function ensureEntry(sshPanelId: string): CompanionEntry {
    if (!entries.value[sshPanelId]) {
      entries.value[sshPanelId] = {}
      resourceReleases.set(sshPanelId, lifecycle.registerResource(sshPanelId, () => disposeForPanel(sshPanelId)))
    }
    return entries.value[sshPanelId]
  }

  function cloneConfig(config: ConnectionConfig): ConnectionConfig {
    // Companion sessions connect immediately; terminal deferral is selected
    // by the backend session type and does not need a frontend flag.
    return {
      ...config,
      initialCols: 0,
      initialRows: 0,
    }
  }

  function resolveConfig(sshPanelId: string): ConnectionConfig | null {
    const panel = panelStore.getPanel(sshPanelId)
    if (!panel?.config) return null
    const config = cloneConfig(panel.config)
    // Prefer password still held on the live SSH panel; fall back to the
    // connection store (which may have been refreshed from keychain).
    if (!config.password && config.authType === 'password' && config.id) {
      const stored = useConnectionStore().connections.find(c => c.id === config.id)
      if (stored?.password) config.password = stored.password
    }
    return config
  }

  async function sessionAlive(sessionId: string | undefined): Promise<boolean> {
    if (!sessionId) return false
    try {
      const sessions = await backendSessionApi.listSessions()
      const sess = sessions.find(s => s.id === sessionId)
      return sess?.status === 'connected' || sess?.status === 'connecting'
    } catch {
      const st = sessionStore.getStatus(sessionId)
      return st === 'connected' || st === 'connecting'
    }
  }

  function ensureSftp(sshPanelId: string): Promise<string | null> {
    return ensureCompanion(sshPanelId, 'sftp', pendingSftp)
  }

  function ensureMonitor(sshPanelId: string): Promise<string | null> {
    return ensureCompanion(sshPanelId, 'monitor', pendingMonitor)
  }

  function ensureCompanion(
    panelId: string,
    kind: 'sftp' | 'monitor',
    pending: Map<string, Promise<string | null>>,
  ): Promise<string | null> {
    const inflight = pending.get(panelId)
    if (inflight) return inflight
    const config = resolveConfig(panelId)
    if (!config || !lifecycle.isOpen(panelId)) return Promise.resolve(null)
    const entry = ensureEntry(panelId)
    const sessionKey = kind === 'sftp' ? 'sftpSessionId' : 'monitorSessionId'
    const creatingKey = kind === 'sftp' ? 'creatingSftp' : 'creatingMonitor'
    const current = () => entries.value[panelId] === entry && lifecycle.isOpen(panelId)
    entry[creatingKey] = true

    // Store the actual promise, not a boolean plus polling on an entry object
    // that might have been replaced by another request. Concurrent callers all
    // receive the same result, even when IPC takes more than five seconds.
    const attempt = Promise.resolve().then(async () => {
      const oldId = entry[sessionKey]
      if (oldId && await sessionAlive(oldId)) return current() ? oldId : null
      if (!current()) return null
      if (oldId) {
        entry[sessionKey] = undefined
        await lifecycle.disposeOwnedSession(panelId, oldId)
      }
      if (!current()) return null
      config.type = kind === 'monitor' ? 'monitor'
        : isWslPanel(panelId) ? 'wsl-file' : fileTransferProto(config)
      const session = await lifecycle.createChildSession(panelId, config.type, config)
      // disposeForPanel may run independently of closing the owner (e.g. a
      // sidebar reset). Never recreate its entry from a late child result.
      if (!current()) {
        await lifecycle.disposeOwnedSession(panelId, session.id)
        return null
      }
      entry[sessionKey] = session.id
      return session.id
    }).catch((error: unknown) => {
      if (current() && !isPanelLifecycleCancelled(error)) {
        console.error(`companion ${kind} create failed:`, error)
      }
      return null
    }).finally(() => {
      if (pending.get(panelId) === attempt) pending.delete(panelId)
      if (current()) entry[creatingKey] = false
    })
    pending.set(panelId, attempt)
    return attempt
  }

  async function toggleFiles() {
    if (!canToggle.value && !filesVisible.value) return
    if (filesVisible.value) {
      filesVisible.value = false
      return
    }
    const pid = getActiveFilesPanelId()
    if (!pid) return
    filesVisible.value = true
    await ensureSftp(pid)
  }

  async function toggleMonitor() {
    if (!canToggle.value && !monitorVisible.value) return
    if (monitorVisible.value) {
      monitorVisible.value = false
      return
    }
    const pid = getActiveSshPanelId()
    if (!pid) return
    monitorVisible.value = true
    await ensureMonitor(pid)
  }

  // Follow-terminal-path is DEFAULT-OFF: the record only ever stores an
  // explicit `true` (user turned it on); absence means disabled.
  function toggleFollowPath(panelId: string) {
    const next = followPathByPanel.value[panelId] !== true
    followPathByPanel.value = { ...followPathByPanel.value, [panelId]: next }
  }

  async function disposeForPanel(sshPanelId: string) {
    resourceReleases.get(sshPanelId)?.()
    resourceReleases.delete(sshPanelId)
    pendingSftp.delete(sshPanelId)
    pendingMonitor.delete(sshPanelId)
    const entry = entries.value[sshPanelId]
    // Drop companion view caches together with the panel's sessions.
    if (fileViewCache.value[sshPanelId]) {
      delete fileViewCache.value[sshPanelId]
    }
    if (monitorViewCache.value[sshPanelId]) {
      delete monitorViewCache.value[sshPanelId]
    }
    delete followPathByPanel.value[sshPanelId]
    panelStore.removeTransferTasks(sftpTransferKeyOf(sshPanelId))
    if (!entry) return
    const sftpId = entry.sftpSessionId
    const monitorId = entry.monitorSessionId
    delete entries.value[sshPanelId]
    if (sftpId) {
      await lifecycle.disposeOwnedSession(sshPanelId, sftpId)
      unregisterTransferRoute(sftpId)
    }
    if (monitorId) {
      await lifecycle.disposeOwnedSession(sshPanelId, monitorId)
    }
  }

  async function disposeForPanels(panelIds: string[]) {
    await Promise.all(panelIds.map(id => disposeForPanel(id)))
  }

  function setFilesWidth(w: number) {
    filesWidth.value = Math.min(Math.max(w, 240), 560)
  }

  function setMonitorWidth(w: number) {
    monitorWidth.value = Math.min(Math.max(w, 260), 560)
  }

  function getFileViewCache(sshPanelId: string): FileViewCache | undefined {
    return fileViewCache.value[sshPanelId]
  }

  function setFileViewCache(sshPanelId: string, cache: FileViewCache) {
    if (!entries.value[sshPanelId] || !lifecycle.isOpen(sshPanelId)) return
    fileViewCache.value = { ...fileViewCache.value, [sshPanelId]: cache }
  }

  function getMonitorViewCache(sshPanelId: string): MonitorViewCache | undefined {
    return monitorViewCache.value[sshPanelId]
  }

  function setMonitorViewCache(sshPanelId: string, cache: MonitorViewCache) {
    if (!entries.value[sshPanelId] || !lifecycle.isOpen(sshPanelId)) return
    monitorViewCache.value = { ...monitorViewCache.value, [sshPanelId]: cache }
  }

  return {
    filesVisible,
    monitorVisible,
    filesWidth,
    monitorWidth,
    entries,
    followPathByPanel,
    activeSshPanelId,
    activeFilesPanelId,
    sshConnected,
    filesConnected,
    canToggle,
    currentSftpSessionId,
    currentMonitorSessionId,
    transferKey,
    sftpTransferKeyOf,
    ensureSftp,
    ensureMonitor,
    toggleFiles,
    toggleMonitor,
    disposeForPanel,
    disposeForPanels,
    setFilesWidth,
    setMonitorWidth,
    getActiveSshPanelId,
    getActiveFilesPanelId,
    isWslPanel,
    getFileViewCache,
    setFileViewCache,
    getMonitorViewCache,
    setMonitorViewCache,
    toggleFollowPath,
  }
})
