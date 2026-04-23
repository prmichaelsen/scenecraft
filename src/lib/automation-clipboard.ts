/**
 * M13 task-56: Copy-paste automation keyframes across curves and tracks.
 *
 * Pure utilities for:
 *   - Serializing a cross-curve / cross-track keyframe selection into a
 *     portable clipboard blob (spec R43-R44).
 *   - Computing a `trackDelta` between source and destination tracks using
 *     track order (M10 `trackDelta` pattern — indices, not string arithmetic).
 *   - Resolving a paste against the destination project state, honoring the
 *     `(effect_type, param_name)` filter (spec R46) and producing one
 *     (curve_id → merged points) map per target curve.
 *
 * Spec: agent/specs/local.effect-curves-macro-panel.md R43-R47.
 *
 * No React, no DOM, no fetch — keyboard wiring + HTTP live in
 * `useAutomationClipboard` and `scenecraft-client` respectively.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single keyframe selected for copy. We track its absolute curve time and
 * normalized value along with the originating (curve, track, effect, param)
 * so the clipboard can be both "untargeted" (value-only) and "targeted"
 * (filtered by effect_type + param_name on paste).
 */
export interface SelectedKeyframe {
  /** The `effect_curves.id` row this keyframe belongs to. */
  curve_id: string
  /** Time on the project timeline, seconds. */
  time: number
  /** Normalized [0, 1] value. */
  value: number
  /** The `effect_curves.interpolation` value (copied through to paste). */
  interpolation: 'bezier' | 'linear' | 'step'
}

/**
 * Runtime shape of a curve on one track — just the fields we need to
 * resolve paste targets.
 */
export interface CurveRef {
  curve_id: string
  track_id: string
  effect_type: string
  param_name: string
  interpolation: 'bezier' | 'linear' | 'step'
  /** Existing points (we merge new points on top). `[time, value]` pairs. */
  points: Array<[number, number]>
}

/**
 * Clipboard shape per the task brief. `version: 1` gates future format
 * evolution. `relative_t_offsets[i]` / `values[i]` are parallel arrays.
 */
export interface AutomationClipboardItem {
  effect_type: string
  param_name: string
  source_track_id: string
  relative_t_offsets: number[]
  values: number[]
  interpolation: 'bezier' | 'linear' | 'step'
}

export interface AutomationClipboard {
  version: 1
  kind: 'automation-keyframes'
  sourceTrackIds: string[]
  primary_source_track_id: string
  gesture_start_t: number
  items: AutomationClipboardItem[]
}

/**
 * A computed paste update — one per destination curve. The caller POSTs
 * this (preserving existing points and merging the new ones in time-sorted
 * order, deduping collisions) via the batch endpoint.
 */
export interface PasteUpdate {
  curve_id: string
  track_id: string
  effect_type: string
  param_name: string
  /** Merged + sorted + deduped points (dedupe keeps the pasted value when
   *  an existing keyframe is at the exact same time — spec step 4). */
  points: Array<[number, number]>
  /** Newly inserted points, for test assertions and debug logging. */
  newly_pasted_points: Array<[number, number]>
  interpolation: 'bezier' | 'linear' | 'step'
}

export interface PasteResolution {
  updates: PasteUpdate[]
  /** Items that had no matching curve on their resolved target track. */
  skipped_items: AutomationClipboardItem[]
  /** Number of target tracks (source_track + trackDelta) that fell out of
   *  the track ordering. These items are skipped silently like
   *  `skipped_items`. */
  out_of_range: number
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * Bucket the selection by `(curve_id)`, which uniquely identifies an
 * (effect_id, param_name) pair. Each bucket becomes one clipboard item.
 *
 * `curves` is a lookup of every *currently visible* curve in the editor —
 * we pull `effect_type`, `param_name`, `source_track_id`, and
 * `interpolation` from here. Keyframes whose curve_id isn't in `curves`
 * are skipped silently.
 *
 * `gesture_start_t` is the earliest time across the selection, and the
 * primary source track id is the track of the earliest keyframe (ties
 * broken by curve_id to make the result deterministic — important for
 * snapshot-style test assertions).
 */
export function serializeAutomationSelection(
  selection: SelectedKeyframe[],
  curves: Map<string, CurveRef>,
): AutomationClipboard | null {
  if (selection.length === 0) return null

  // Sort by (time asc, curve_id asc) for determinism.
  const ordered = [...selection].sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time
    return a.curve_id.localeCompare(b.curve_id)
  })

  const earliest = ordered[0]
  const earliestCurve = curves.get(earliest.curve_id)
  if (!earliestCurve) return null

  const gesture_start_t = earliest.time
  const primary_source_track_id = earliestCurve.track_id

  // Bucket by curve_id.
  const byCurve = new Map<string, SelectedKeyframe[]>()
  for (const kf of ordered) {
    if (!curves.has(kf.curve_id)) continue
    const arr = byCurve.get(kf.curve_id) ?? []
    arr.push(kf)
    byCurve.set(kf.curve_id, arr)
  }

  const items: AutomationClipboardItem[] = []
  const sourceTrackSet = new Set<string>()
  // Deterministic curve ordering (by curve_id asc) so the clipboard serialization
  // is stable for test snapshots.
  const curveIds = [...byCurve.keys()].sort()
  for (const cid of curveIds) {
    const bucket = byCurve.get(cid)!
    const curve = curves.get(cid)!
    sourceTrackSet.add(curve.track_id)
    items.push({
      effect_type: curve.effect_type,
      param_name: curve.param_name,
      source_track_id: curve.track_id,
      relative_t_offsets: bucket.map((kf) => kf.time - gesture_start_t),
      values: bucket.map((kf) => kf.value),
      interpolation: curve.interpolation,
    })
  }

  return {
    version: 1,
    kind: 'automation-keyframes',
    sourceTrackIds: [...sourceTrackSet].sort(),
    primary_source_track_id,
    gesture_start_t,
    items,
  }
}

// ---------------------------------------------------------------------------
// trackDelta (M10 pattern — index-based, not string arithmetic)
// ---------------------------------------------------------------------------

/**
 * Given the project's audio-track ordering (top → bottom = index 0 → N-1),
 * return the numeric delta from `source_track_id` to `destination_track_id`.
 *
 * If either id isn't present in the ordering, returns `null` — the caller
 * should treat that as "skip" (the UI shouldn't ever submit such a paste,
 * but the pure function is defensive).
 *
 * Reuses the M10 transition-clip `computeTrackDelta` mental model (see
 * `TransitionTrack.tsx` ~L600: hit-test a track row index, subtract source
 * index). Here we don't hit-test — we just index into `track_ordering`.
 */
export function computeTrackDelta(
  source_track_id: string,
  destination_track_id: string,
  track_ordering: string[],
): number | null {
  const srcIdx = track_ordering.indexOf(source_track_id)
  const dstIdx = track_ordering.indexOf(destination_track_id)
  if (srcIdx < 0 || dstIdx < 0) return null
  return dstIdx - srcIdx
}

/**
 * Apply `trackDelta` to an arbitrary source track id. Returns the
 * destination track id, or `null` if the destination is out of bounds.
 *
 * We DO NOT clamp — out-of-range just skips. (Unlike the M10 drag
 * behavior which auto-creates tracks; paste is strictly additive onto
 * existing tracks per R45.)
 */
export function applyTrackDelta(
  source_track_id: string,
  trackDelta: number,
  track_ordering: string[],
): string | null {
  const srcIdx = track_ordering.indexOf(source_track_id)
  if (srcIdx < 0) return null
  const dstIdx = srcIdx + trackDelta
  if (dstIdx < 0 || dstIdx >= track_ordering.length) return null
  return track_ordering[dstIdx]
}

// ---------------------------------------------------------------------------
// Paste resolution
// ---------------------------------------------------------------------------

export interface PasteContext {
  /** Clipboard payload from a prior copy. */
  clipboard: AutomationClipboard
  /** The track the user currently has selected (paste anchor). */
  destination_primary_track_id: string
  /** Absolute timeline time at which to anchor the paste. */
  playhead_time: number
  /** Track order — index 0 is the top track in the UI. */
  track_ordering: string[]
  /** All curves currently present in the project that *could* receive a
   *  paste — indexed so we can look up `(track_id, effect_type, param_name)`. */
  destination_curves: CurveRef[]
}

/**
 * Compute the updates that would be applied to the project's effect_curves
 * table for a paste at `playhead_time` anchored on
 * `destination_primary_track_id`.
 *
 * The algorithm:
 *   1. `trackDelta = dstIdx(primary) - srcIdx(primary_source_track_id)`
 *   2. For each clipboard item:
 *        target_track = source_track + trackDelta (out-of-range → skip)
 *        target_curve = find curve on target_track matching (effect_type,
 *          param_name) — no match → skip
 *        new_times = playhead_time + relative_t_offsets
 *        merge with target_curve.points; dedupe colliding times (pasted
 *        value wins); sort by time asc.
 *   3. Collect into `updates`.
 *
 * The result is a *plan* — the caller actually POSTs it.
 */
export function resolvePasteTargets(ctx: PasteContext): PasteResolution {
  const { clipboard, destination_primary_track_id, playhead_time,
    track_ordering, destination_curves } = ctx

  const trackDelta = computeTrackDelta(
    clipboard.primary_source_track_id,
    destination_primary_track_id,
    track_ordering,
  )
  // If primary isn't in ordering we can't paste at all.
  if (trackDelta === null) {
    return { updates: [], skipped_items: [...clipboard.items], out_of_range: clipboard.items.length }
  }

  // Index destination curves by (track_id, effect_type, param_name).
  const curveLookup = new Map<string, CurveRef>()
  const curveKey = (t: string, e: string, p: string) => `${t}::${e}::${p}`
  for (const c of destination_curves) {
    curveLookup.set(curveKey(c.track_id, c.effect_type, c.param_name), c)
  }

  const updates: PasteUpdate[] = []
  const skipped: AutomationClipboardItem[] = []
  let outOfRange = 0

  for (const item of clipboard.items) {
    const target_track_id = applyTrackDelta(item.source_track_id, trackDelta, track_ordering)
    if (target_track_id === null) {
      outOfRange += 1
      continue
    }
    const target = curveLookup.get(curveKey(target_track_id, item.effect_type, item.param_name))
    if (!target) {
      // R46: paste filter — mismatched (effect_type, param_name) silently skips.
      skipped.push(item)
      continue
    }

    // Build new points at absolute times.
    const newly: Array<[number, number]> = item.relative_t_offsets.map(
      (off, i) => [playhead_time + off, item.values[i]] as [number, number],
    )

    // Merge with existing points. Dedupe by time (pasted wins).
    const merged = new Map<number, number>()
    for (const [t, v] of target.points) merged.set(t, v)
    for (const [t, v] of newly) merged.set(t, v)
    const finalPoints = [...merged.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => [t, v] as [number, number])

    updates.push({
      curve_id: target.curve_id,
      track_id: target.track_id,
      effect_type: target.effect_type,
      param_name: target.param_name,
      points: finalPoints,
      newly_pasted_points: newly,
      interpolation: target.interpolation,
    })
  }

  return { updates, skipped_items: skipped, out_of_range: outOfRange }
}

// ---------------------------------------------------------------------------
// Clipboard plumbing (in-memory fallback for tests, browser-native in app)
// ---------------------------------------------------------------------------

const CLIPBOARD_GLOBAL_KEY = '__scenecraftAutomationClipboard'

/** Stash a clipboard blob on the window for cross-component retrieval. */
export function writeClipboardToMemory(clip: AutomationClipboard): void {
  if (typeof globalThis !== 'undefined') {
    ;(globalThis as Record<string, unknown>)[CLIPBOARD_GLOBAL_KEY] = clip
  }
}

/** Retrieve a previously-stashed clipboard blob, or null. */
export function readClipboardFromMemory(): AutomationClipboard | null {
  if (typeof globalThis === 'undefined') return null
  const v = (globalThis as Record<string, unknown>)[CLIPBOARD_GLOBAL_KEY]
  if (v == null) return null
  // Narrow: anything stored under our key is expected to have version: 1.
  const c = v as AutomationClipboard
  if (c.version !== 1 || c.kind !== 'automation-keyframes') return null
  return c
}

/** Clear the in-memory clipboard (test-only, but safe in prod too). */
export function clearClipboardMemory(): void {
  if (typeof globalThis !== 'undefined') {
    delete (globalThis as Record<string, unknown>)[CLIPBOARD_GLOBAL_KEY]
  }
}

/**
 * Try to write the clipboard to the system via navigator.clipboard — if
 * unavailable or blocked (secure-context, permissions), falls back to the
 * in-memory store. Always returns a promise so UI can `await` it.
 */
export async function writeClipboardToSystem(clip: AutomationClipboard): Promise<void> {
  writeClipboardToMemory(clip)
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      await nav.clipboard.writeText(JSON.stringify(clip))
    }
  } catch {
    // Silent — memory store is the source of truth.
  }
}

/**
 * Attempt to read a clipboard blob from navigator.clipboard. If the text
 * doesn't parse as our shape, returns null. Falls back to in-memory
 * (which writeClipboardToSystem mirrors to) when the system clipboard is
 * unavailable.
 */
export async function readClipboardFromSystem(): Promise<AutomationClipboard | null> {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav && nav.clipboard && typeof nav.clipboard.readText === 'function') {
      const text = await nav.clipboard.readText()
      const parsed = JSON.parse(text) as AutomationClipboard
      if (parsed && parsed.version === 1 && parsed.kind === 'automation-keyframes') {
        return parsed
      }
    }
  } catch {
    // Ignore parse / permission errors; fall through to memory.
  }
  return readClipboardFromMemory()
}
