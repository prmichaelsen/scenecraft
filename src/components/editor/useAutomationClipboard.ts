/**
 * M13 task-56: React hook wiring copy/paste keyboard shortcuts to the
 * pure `automation-clipboard` functions.
 *
 * Responsibilities:
 *   - On Ctrl+C (when a multi-select is active and the focused element
 *     isn't a text input / page-level text selection): serialize the
 *     selection via `serializeAutomationSelection`, stash in the system
 *     clipboard (with in-memory fallback).
 *   - On Ctrl+V: read the clipboard, call `resolvePasteTargets` against
 *     the current project's curves / track ordering, and POST the merged
 *     points to `/effect-curves/batch` so the whole paste lands in a
 *     single undo unit (spec R47).
 *
 * The hook is UI-framework-agnostic below the React event wiring — it
 * accepts injected `postBatchUpdate` for testability, and all dependence
 * on project state comes in via props.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md R43-R47.
 */

import { useCallback, useEffect } from 'react'
import {
  serializeAutomationSelection,
  resolvePasteTargets,
  writeClipboardToSystem,
  readClipboardFromSystem,
  type SelectedKeyframe,
  type CurveRef,
  type AutomationClipboard,
  type PasteUpdate,
} from '@/lib/automation-clipboard'
import { matchesHotkey, handlePreventDefault } from '@/lib/hotkeys'
import { postEffectCurveBatchUpdate } from '@/lib/scenecraft-client'

export interface UseAutomationClipboardOptions {
  /** Project name used for HTTP calls. */
  projectName: string
  /** The user's current selection of keyframes across all visible curves. */
  selection: SelectedKeyframe[]
  /** Map curve_id → CurveRef for every curve currently loaded. */
  curvesById: Map<string, CurveRef>
  /** Same curves as an array, for destination-side lookup during paste. */
  allCurves: CurveRef[]
  /** Project's audio track ids in display order (top → bottom). */
  trackOrdering: string[]
  /** Current selected audio track (paste anchor). */
  destinationPrimaryTrackId: string | null
  /** Absolute timeline time in seconds used as the paste anchor. */
  playheadTime: number
  /** Called after a successful paste so the parent can refresh state. */
  onAfterPaste?: (result: { updates: PasteUpdate[]; skipped: number }) => void

  // ---- Injection points (tests override) ----
  /** Override for the batch HTTP call (tests). */
  postBatchUpdate?: typeof postEffectCurveBatchUpdate
  /** Override for system-clipboard write (tests). */
  writeClipboard?: (clip: AutomationClipboard) => Promise<void>
  /** Override for system-clipboard read (tests). */
  readClipboard?: () => Promise<AutomationClipboard | null>

  /** Disable all keyboard wiring (e.g. when the panel isn't focused). */
  disabled?: boolean
}

export interface UseAutomationClipboardResult {
  /** Imperatively trigger the copy gesture (used by InlineCurveEditor onKeyDown). */
  copy: () => Promise<AutomationClipboard | null>
  /** Imperatively trigger the paste gesture. */
  paste: () => Promise<{ updates: PasteUpdate[]; skipped: number } | null>
}

export function useAutomationClipboard(
  opts: UseAutomationClipboardOptions,
): UseAutomationClipboardResult {
  const {
    projectName,
    selection,
    curvesById,
    allCurves,
    trackOrdering,
    destinationPrimaryTrackId,
    playheadTime,
    onAfterPaste,
    postBatchUpdate = postEffectCurveBatchUpdate,
    writeClipboard = writeClipboardToSystem,
    readClipboard = readClipboardFromSystem,
    disabled = false,
  } = opts

  const copy = useCallback(async (): Promise<AutomationClipboard | null> => {
    if (selection.length === 0) return null
    const clip = serializeAutomationSelection(selection, curvesById)
    if (!clip) return null
    await writeClipboard(clip)
    return clip
  }, [selection, curvesById, writeClipboard])

  const paste = useCallback(async (): Promise<{ updates: PasteUpdate[]; skipped: number } | null> => {
    if (!destinationPrimaryTrackId) return null
    const clip = await readClipboard()
    if (!clip) return null

    const resolution = resolvePasteTargets({
      clipboard: clip,
      destination_primary_track_id: destinationPrimaryTrackId,
      playhead_time: playheadTime,
      track_ordering: trackOrdering,
      destination_curves: allCurves,
    })

    if (resolution.updates.length === 0) {
      // Nothing matched — inform the caller but do not POST.
      onAfterPaste?.({ updates: [], skipped: resolution.skipped_items.length + resolution.out_of_range })
      return { updates: [], skipped: resolution.skipped_items.length + resolution.out_of_range }
    }

    await postBatchUpdate(
      projectName,
      resolution.updates.map((u) => ({
        curve_id: u.curve_id,
        points: u.points,
      })),
      { description: `Paste automation keyframes (${resolution.updates.length} curves)` },
    )

    const result = {
      updates: resolution.updates,
      skipped: resolution.skipped_items.length + resolution.out_of_range,
    }
    onAfterPaste?.(result)
    return result
  }, [
    destinationPrimaryTrackId, readClipboard, playheadTime, trackOrdering,
    allCurves, postBatchUpdate, projectName, onAfterPaste,
  ])

  useEffect(() => {
    if (disabled) return
    const onKey = (e: KeyboardEvent) => {
      // Skip while typing in text inputs; let browser handle text copy/paste
      // when the user has an active text selection on the page.
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      const pageSelection = typeof window !== 'undefined' ? window.getSelection() : null
      if (pageSelection && pageSelection.toString().length > 0) return

      if (matchesHotkey(e, 'copy')) {
        if (selection.length === 0) return
        handlePreventDefault(e, 'copy')
        void copy()
        return
      }
      if (matchesHotkey(e, 'paste')) {
        if (!destinationPrimaryTrackId) return
        handlePreventDefault(e, 'paste')
        void paste()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [disabled, selection, destinationPrimaryTrackId, copy, paste])

  return { copy, paste }
}
