/**
 * Narrow host API surface for scenecraft plugins (frontend).
 *
 * Plugins MUST import from this module rather than app internals. When the
 * dynamic plugin loader lands, this becomes the stable public API. The
 * surface is intentionally minimal: re-exports of a small number of stable
 * client helpers, a dialog host, a toast helper, and a job-subscription
 * helper. Anything outside this surface is considered internal and may
 * change without notice.
 */

import type { ComponentType } from 'react'

// --- Stable client helpers ------------------------------------------------
// Surface-safe re-exports. Plugins should reach for these rather than import
// from chat-client directly.
export { fetchChatHistory, ChatWebSocket } from './chat-client'

// --- Type re-exports ------------------------------------------------------
// Plugin descriptors live in plugin-host; re-exported here so a plugin only
// needs a single import path.
export type {
  PluginModule,
  ContextMenuDescriptor,
  OperationDescriptor,
} from './plugin-host'

// --- Dialog host ----------------------------------------------------------
// A single dialog host is registered by the editor shell. Plugins that need
// to render a confirm / parameter picker call `showDialog` rather than
// trying to mount into the app tree themselves.
type DialogHost = {
  show: <T>(Component: ComponentType<unknown>, props: unknown) => Promise<T | null>
}

let dialogHostRef: DialogHost | null = null

/** App-only: register the singleton dialog host. Plugins must not call this. */
export function _registerDialogHost(host: DialogHost | null): void {
  dialogHostRef = host
}

/**
 * Show a plugin-provided dialog. Resolves with the dialog's result, or `null`
 * if the user cancels. Throws if the dialog host has not been registered yet
 * (which indicates a startup ordering bug).
 */
export function showDialog<T>(
  Component: ComponentType<unknown>,
  props: unknown,
): Promise<T | null> {
  if (!dialogHostRef) {
    throw new Error(
      'plugin-api: dialog host not registered — called showDialog before editor mounted',
    )
  }
  return dialogHostRef.show<T>(Component, props)
}

// --- Toast ----------------------------------------------------------------
// Minimal surface. For MVP we log to the console; a future task can route
// this to the app toast lib without changing the plugin-facing signature.
export type ToastLevel = 'info' | 'error' | 'success'

export function toast(msg: string, level: ToastLevel = 'info'): void {
  const tag = `[plugin-toast:${level}]`
  if (level === 'error') console.error(tag, msg)
  else console.log(tag, msg)
}

// --- Job subscription -----------------------------------------------------
// Plugins that kick off long-running backend jobs (via the scenecraft REST
// API) need to watch a single jobId over the shared WebSocket. The app's
// `useScenecraftSocket` hook is React-only; this helper exposes the same
// data in a framework-agnostic shape a plugin operation handler can call
// from an async flow.

import { subscribeJobExternal } from '@/hooks/useScenecraftSocket'

export type JobSubscribeCallbacks = {
  onProgress?: (payload: {
    completed: number
    total: number
    detail: string
  }) => void
  onCompleted?: (result: unknown) => void
  onFailed?: (error: string) => void
}

/**
 * Subscribe to a backend job by id. Returns an unsubscribe function.
 *
 * Task-103's chat-tool glue depends on this: the isolate-vocals operation
 * kicks off a backend job via REST, then routes progress/completion to the
 * chat UI via these callbacks. For MVP this is a thin wrapper around the
 * existing `useScenecraftSocket` singleton — when we harden the plugin API
 * later we can swap the underlying transport without changing callers.
 */
export function getSubscribeJob() {
  return function subscribeJob(
    jobId: string,
    cbs: JobSubscribeCallbacks,
  ): () => void {
    return subscribeJobExternal(jobId, (msg) => {
      if (msg.type === 'job_progress') {
        cbs.onProgress?.({
          completed: msg.completed,
          total: msg.total,
          detail: msg.detail,
        })
      } else if (msg.type === 'job_completed') {
        cbs.onCompleted?.(msg.result)
      } else if (msg.type === 'job_failed') {
        cbs.onFailed?.(msg.error)
      }
    })
  }
}

// --- Legacy back-compat stubs --------------------------------------------
// These were placeholders for an older plugin contribution-point idea that
// never shipped. Two callers (`EffectEditor`, `Timeline`) still import them
// to derive "is this id plugin-contributed?" lists. They return `[]` today
// and should be migrated to the new PluginHost surface in a follow-up; left
// in place to avoid a mass rename inside task-101.

export type PluginEffectDefinition = {
  id: string
  label: string
  category: string
  params: Array<{
    name: string
    type: 'number' | 'string' | 'boolean'
    default: number | string | boolean
    min?: number
    max?: number
  }>
}

export type PluginBlendMode = {
  id: string
  label: string
}

/** @deprecated legacy contribution-point stub — always returns []. */
export function getPluginEffects(): PluginEffectDefinition[] {
  return []
}

/** @deprecated legacy contribution-point stub — always returns []. */
export function getPluginBlendModes(): PluginBlendMode[] {
  return []
}
