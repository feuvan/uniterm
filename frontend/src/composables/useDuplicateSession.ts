import {
  K8sExecSession,
  ContainerExecSession,
} from '../../bindings/github.com/ys-ll/uniterm/app'
import { usePanelStore } from '../stores/panelStore'
import { useTabStore } from '../stores/tabStore'
import { useSessionStore } from '../stores/sessionStore'
import { waitForTerminalSize } from '../services/terminalManager'
import { usePanelLifecycle } from '../services/panelLifecycle'
import { fileTransferProto } from '../utils/fileTransferUtils'
import type { ConnectionConfig } from '../types/session'

// The session-type argument to CreateSession isn't always tab.config.type:
// a file-transfer (sftp) tab may share an SSH connection whose config.type is
// 'ssh' but whose session must be created as 'sftp' (per the connection's
// fileTransferProto preference). Everything else — including the whole
// database family — already carries its session type in config.type.
function resolveSessionType(tabType: string, config: any): string {
  if (tabType === 'sftp') {
    return config?.type === 'ssh' ? fileTransferProto(config) : config?.type
  }
  return config?.type
}

// Tab kinds whose duplicates are plain tab-shaped (session already bound by
// the shared flow). Terminal tabs are special (workspace embedding + PTY size
// wait) and keep their own branch.
const TAB_BACKED_DUPLICATE_TYPES = ['sftp', 'database', 'mongodb', 'redis', 'elasticsearch']

/**
 * Duplicate a session/tab. Shared by the tab context menu ("复制会话") and the
 * keyboard shortcut (duplicateSession) so both paths behave identically.
 *
 * The new tab or workspace panel is created right after the session is bound
 * but BEFORE it is started, so the duplicate appears immediately while the
 * SSH/PTY handshake runs in the background.
 */
export function useDuplicateSession() {
  const panelStore = usePanelStore()
  const tabStore = useTabStore()
  const sessionStore = useSessionStore()

  async function duplicateSession(
    tab: any,
    targetWorkspace?: { workspaceId: string; targetPanelId?: string },
  ) {
    if (!tab || !('panelId' in tab)) return
    const panel = panelStore.getPanel(tab.panelId)
    if (!panel) return

    // k8s tab has no backend session; it connects itself on mount from
    // connectionId + namespace. Duplicate = a fresh panel + K8s tab reusing the
    // same connection (a new independent session), matching other tab types.
    if (tab.type === 'k8s') {
      const newPanel = panelStore.createPanel(panel.config, 'k8s')
      panelStore.updateTitle(newPanel.id, panel.title)
      const newTab = tabStore.createTab('k8s', newPanel.title, newPanel.id, { connectionId: tab.connectionId, connId: null, namespace: tab.namespace || '' })
      panelStore.movePanelToTab(newPanel.id, newTab.id)
      return
    }

    if (tab.type !== 'terminal' && !TAB_BACKED_DUPLICATE_TYPES.includes(tab.type)) return
    const newPanel = panelStore.createPanel(panel.config, panel.type)
    panelStore.updateTitle(newPanel.id, panel.title)

    // Create + bind the session BEFORE mounting the tab, so the terminal has a
    // sessionId on first mount. Mounting first (empty sessionId) leaves the
    // shared terminal keyed by '' and bindSession's later id change can't
    // transfer it (the watch skips when oldId is falsy), so server output is
    // dropped until an incidental resize rebuilds the reference.
    let info
    let config: ConnectionConfig | undefined
    if (panel.config) {
      try {
        if (panel.type === 'k8s-exec' || panel.type === 'container-exec') {
          // Exec panels can't be rebuilt via CreateSession (no such type); re-dial the exec stream.
          const generation = usePanelLifecycle().begin(newPanel.id)
          const c = panel.config
          if (panel.type === 'k8s-exec') {
            if (!c.k8sExecConnId || !c.k8sExecPod || !c.k8sExecContainer) throw new Error('exec session parameters missing')
            info = await K8sExecSession(c.k8sExecConnId, c.k8sNamespace || '', c.k8sExecPod, c.k8sExecContainer)
          } else {
            if (!c.containerExecConnId || !c.containerExecContainerId) throw new Error('exec session parameters missing')
            info = await ContainerExecSession(c.containerExecConnId, c.containerExecContainerId, c.containerExecShell || 'sh')
          }
          if (!info?.id) throw new Error('Backend returned an empty exec session')
          await usePanelLifecycle().adoptSession(newPanel.id, info.id, generation)
          sessionStore.updateStatus(info.id, 'connected')
        } else {
          const sessionType = resolveSessionType(tab.type, panel.config)
          config = {
            ...panel.config,
            initialCols: 0,
            initialRows: 0,
          }
          info = await usePanelLifecycle().createSession(newPanel.id, sessionType, config)
        }
      } catch (e) {
        console.error('Failed to duplicate session:', e)
        await usePanelLifecycle().disposePanel(newPanel.id)
        return
      }
    }

    // Mount the duplicate now that the session is bound but BEFORE it is
    // started, either beside the source panel or in a standalone tab.
    let newTab
    if (tab.type === 'terminal') {
      const addedToWorkspace = targetWorkspace
        ? tabStore.addNewPanelToWorkspace(
            targetWorkspace.workspaceId,
            newPanel.id,
            targetWorkspace.targetPanelId,
          )
        : false
      if (addedToWorkspace) {
        panelStore.movePanelToTab(newPanel.id, targetWorkspace!.workspaceId)
      } else {
        newTab = tabStore.createTerminalTab(newPanel.title, newPanel.id)
      }
    } else if (TAB_BACKED_DUPLICATE_TYPES.includes(tab.type)) {
      newTab = tabStore.createTab(tab.type, newPanel.title, newPanel.id)
    } else {
      return
    }
    if (newTab) panelStore.movePanelToTab(newPanel.id, newTab.id)

    // Start the connection after the tab is visible. The terminal has now
    // mounted (with its sessionId bound), so waitForTerminalSize resolves with
    // the real size instead of blocking forever on a terminal that didn't exist
    // yet.
    if (tab.type === 'terminal' && info && config) {
      try {
        const size = await waitForTerminalSize(info.id)
        if (size.cols > 0 && size.rows > 0) {
          config.initialCols = size.cols
          config.initialRows = size.rows
        }
        await usePanelLifecycle().startSession(newPanel.id, info.id, config).catch((e) => {
          console.error('Failed to start duplicated session:', e)
        })
      } catch (e) {
        console.error('Failed to duplicate session:', e)
      }
    }
  }

  return { duplicateSession }
}
