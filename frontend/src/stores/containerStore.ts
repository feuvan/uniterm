import { defineStore } from 'pinia'
import * as client from '../services/containerClient'
import { usePanelStore } from './panelStore'
import { useTabStore } from './tabStore'
import { useSessionStore } from './sessionStore'
import { isPanelLifecycleCancelled, usePanelLifecycle } from '../services/panelLifecycle'
import type { ContainerTab, ContainerInfo, ContainerImage, InspectResult } from '../types/container'

export interface ContainerSession {
  connId: string
  runtime: ContainerTab['runtime']
  containers: ContainerInfo[]
  images: ContainerImage[]
  namespaces: string[]
  namespace: string
  loading: boolean
  refreshing: boolean
  error: string
}

const resourceReleases = new Map<string, () => Promise<void>>()
const connectionOperations = new Map<string, Promise<void>>()

export const useContainerStore = defineStore('container', {
  state: () => ({ sessions: {} as Record<string, ContainerSession> }),
  actions: {
    async open(tab: ContainerTab) {
      const previous = connectionOperations.get(tab.id)
      if (previous) await previous.catch(() => {})
      await resourceReleases.get(tab.id)?.()
      this.sessions[tab.id] = {
        connId: tab.connectionId, runtime: tab.runtime,
        containers: [], images: [], namespaces: [], namespace: 'default',
        loading: true, refreshing: false, error: '',
      }
      // 读回响应式代理再操作：直接改闭包里的原始对象不会触发视图更新
      const s = this.sessions[tab.id]
      const lifecycle = usePanelLifecycle()
      let unregister = () => {}
      let released = false
      const release = async () => {
        if (released) return
        released = true
        unregister()
        if (resourceReleases.get(tab.id) === release) resourceReleases.delete(tab.id)
        if (this.sessions[tab.id] !== s) return
        delete this.sessions[tab.id]
        await Promise.resolve(client.disconnect(s.connId)).catch(() => {})
      }
      unregister = lifecycle.registerResource(tab.panelId, release)
      resourceReleases.set(tab.id, release)

      // Container manager ids are connection ids, not per-attempt handles.
      // Serialize opens so a late old Connect/Disconnect cannot close a newer
      // connection with the same id during rapid reconnects.
      const opening = Promise.resolve(previous).catch(() => {}).then(async () => {
        if (!lifecycle.isOpen(tab.panelId) || this.sessions[tab.id] !== s) return
        try {
          await client.connect(tab.connectionId)
          if (!lifecycle.isOpen(tab.panelId) || this.sessions[tab.id] !== s) {
            await client.disconnect(tab.connectionId)
            return
          }
          await this.refresh(tab.id)
          if (tab.runtime === 'nerdctl') await this.loadNamespaces(tab.id)
        } catch (e: any) {
          s.error = e?.message || String(e)
        } finally {
          s.loading = false
        }
      })
      connectionOperations.set(tab.id, opening)
      try {
        await opening
      } finally {
        if (connectionOperations.get(tab.id) === opening) connectionOperations.delete(tab.id)
      }
    },
    async refresh(tabId: string) {
      const s = this.sessions[tabId]
      if (!s || s.refreshing) return // 防止手动连点叠加并发 SSH 会话
      s.refreshing = true
      try {
        s.containers = await client.list(s.connId)
        s.error = ''
      } catch (e: any) {
        s.error = e?.message || String(e)
      } finally {
        s.refreshing = false
      }
    },
    async action(tabId: string, cid: string, act: string) {
      const s = this.sessions[tabId]
      if (!s) return
      await client.action(s.connId, cid, act)
      await this.refresh(tabId)
    },
    async rename(tabId: string, cid: string, name: string) {
      const s = this.sessions[tabId]
      if (!s) return
      await client.rename(s.connId, cid, name)
      await this.refresh(tabId)
    },
    async loadDetail(tabId: string, cid: string): Promise<InspectResult | null> {
      const s = this.sessions[tabId]
      if (!s) return null
      return await client.inspect(s.connId, cid)
    },
    async loadImages(tabId: string) {
      const s = this.sessions[tabId]
      if (!s) return
      s.images = await client.images(s.connId)
    },
    async loadNamespaces(tabId: string) {
      const s = this.sessions[tabId]
      if (!s) return
      try {
        s.namespaces = await client.namespaces(s.connId)
      } catch {
        s.namespaces = []
      }
    },
    async setNamespace(tabId: string, ns: string) {
      const s = this.sessions[tabId]
      if (!s) return
      s.namespace = ns
      await client.setNamespace(s.connId, ns)
      s.refreshing = false
      await this.refresh(tabId)
    },
    async createContainer(tabId: string, opts: Parameters<typeof client.create>[1]) {
      const s = this.sessions[tabId]
      if (!s) return
      await client.create(s.connId, opts)
      await this.refresh(tabId)
    },
    // Mirrors K8sTabContent.openTerminal: exec params go on the panel config so
    // Panel.vue / TabItem.vue can redial the stream on reconnect / duplicate.
    async openContainerExec(tab: ContainerTab, c: ContainerInfo, shell = 'sh') {
      const cfg = {
        id: '', name: c.name, type: 'container-exec' as any, host: '', port: 0, user: '', authType: 'password' as any,
        containerExecConnId: tab.connectionId, containerExecContainerId: c.id, containerExecShell: shell,
      }
      const panelStore = usePanelStore()
      const tabStore = useTabStore()
      const sessionStore = useSessionStore()
      const lifecycle = usePanelLifecycle()
      const panel = panelStore.createPanel(cfg as any, 'container-exec')
      panelStore.updateTitle(panel.id, c.name)
      const generation = lifecycle.begin(panel.id)
      try {
        const info = await client.execSession(tab.connectionId, c.id, shell)
        await lifecycle.adoptSession(panel.id, info.id, generation)
        sessionStore.updateStatus(info.id, 'connected')
        const termTab = tabStore.createTerminalTab(panel.title, panel.id)
        panelStore.movePanelToTab(panel.id, termTab.id)
      } catch (error) {
        if (!isPanelLifecycleCancelled(error)) await lifecycle.disposePanel(panel.id)
        throw error
      }
    },
    close(tabId: string) {
      const release = resourceReleases.get(tabId)
      if (release) {
        return release().catch(() => {})
      }
      const s = this.sessions[tabId]
      if (!s) return
      delete this.sessions[tabId]
      return Promise.resolve(client.disconnect(s.connId)).catch(() => {})
    },
  },
})
