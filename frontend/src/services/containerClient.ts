import {
  ContainerConnect, ContainerDisconnect, ContainerList, ContainerInspect,
  ContainerAction, ContainerRename, ContainerStats, ContainerImages,
  ContainerRemoveImage, ContainerCreate, ContainerNamespaces,
  ContainerSetNamespace, ContainerStartLogs, ContainerStartPull,
  ContainerStopStream, ContainerExecSession,
} from '../../bindings/github.com/ys-ll/uniterm/app'
import { Events } from '@wailsio/runtime'
import type {
  ContainerInfo, InspectResult, ContainerImage, ContainerStats as ContainerStatsInfo, ContainerCreateOptions,
} from '../types/container'

export const connect = async (id: string): Promise<void> => { await ContainerConnect(id) }
export const disconnect = (id: string) => ContainerDisconnect(id)
export const list = (id: string) => ContainerList(id) as Promise<ContainerInfo[]>
export const inspect = (id: string, cid: string) => ContainerInspect(id, cid) as Promise<InspectResult>
export const action = (id: string, cid: string, act: string) => ContainerAction(id, cid, act)
export const rename = (id: string, cid: string, name: string) => ContainerRename(id, cid, name)
export const stats = (id: string) => ContainerStats(id) as Promise<ContainerStatsInfo[]>
export const images = (id: string) => ContainerImages(id) as Promise<ContainerImage[]>
export const removeImage = (id: string, imageID: string) => ContainerRemoveImage(id, imageID)
export const create = (id: string, opts: ContainerCreateOptions) => ContainerCreate(id, opts as any)
export const namespaces = (id: string) => ContainerNamespaces(id) as Promise<string[]>
export const setNamespace = (connId: string, ns: string) => ContainerSetNamespace(connId, ns)
export const execSession = async (connId: string, cid: string, shell: string) => {
  const info = await ContainerExecSession(connId, cid, shell)
  if (!info?.id) throw new Error('Backend returned an empty container exec session')
  return info
}

export interface StreamHandle {
  id: string
  stop: () => void
}

async function startStream(
  start: () => Promise<string>,
  onLine: (line: string) => void,
  onEnd?: (err: string) => void,
  isCurrent: () => boolean = () => true,
): Promise<StreamHandle> {
  const id = await start()
  const evName = `container:stream:${id}`
  const endName = `container:stream-end:${id}`
  let stopped = false
  const removeListeners = () => {
    Events.Off(evName)
    Events.Off(endName)
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    removeListeners()
    void ContainerStopStream(id)
  }

  // A panel can be closed while the backend is still creating the stream.
  // Stop the late stream before registering callbacks or returning it to the
  // caller, so it cannot survive the panel that requested it.
  if (!isCurrent()) {
    stop()
    return { id, stop }
  }

  Events.On(evName, (ev) => {
    if (!stopped && isCurrent()) {
      const p: { line: string } = ev.data
      onLine(p?.line ?? '')
    }
  })
  Events.On(endName, (ev) => {
    if (stopped) return
    stopped = true
    const p: { error: string } = ev.data
    try {
      if (isCurrent()) onEnd?.(p?.error || '')
    } finally {
      removeListeners()
    }
  })
  return { id, stop }
}

export const startLogs = (connId: string, cid: string, tail: number, timestamps: boolean,
  onLine: (l: string) => void, onEnd?: (e: string) => void, isCurrent?: () => boolean) =>
  startStream(() => ContainerStartLogs(connId, cid, tail, timestamps), onLine, onEnd, isCurrent)

export const startPull = (connId: string, image: string,
  onLine: (l: string) => void, onEnd?: (e: string) => void, isCurrent?: () => boolean) =>
  startStream(() => ContainerStartPull(connId, image), onLine, onEnd, isCurrent)
