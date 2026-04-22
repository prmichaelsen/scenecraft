// Snap-to-grid helper for audio clip drag / trim gestures in the Timeline.
//
// Targets (priority by proximity, all compared in pixel space at the current
// zoom so behaviour is consistent across pxPerSec):
//   1. Other audio clips' start_time / end_time (passed as anchorPoints).
//   2. Keyframe timestamps (also passed in anchorPoints — caller merges them).
//   3. Grid of 1s, or 0.1s when shiftKey is held.
//
// Alt disables snap entirely for fine-grained control.
//
// The function operates relative to a reference "currentPosition" — the
// absolute timeline time that the drag delta is applied to (e.g. the primary
// clip's start_time for a body drag, origStart for a left-edge trim, origEnd
// for a right-edge trim). A snap target then corresponds to a delta of
// `anchor - currentPosition`.

export interface SnapResult {
  dt: number
  // The absolute timeline time that was snapped to, or null for grid / no snap.
  snappedTo: number | null
}

export function snapDelta(
  rawDt: number,
  currentPosition: number,
  anchorPoints: number[],
  pxPerSec: number,
  altKey: boolean,
  shiftKey: boolean,
  pixelThreshold: number = 8,
): SnapResult {
  if (altKey || pxPerSec <= 0) {
    return { dt: rawDt, snappedTo: null }
  }

  const cursor = currentPosition + rawDt

  let bestAnchor: number | null = null
  let bestAnchorDistPx = Infinity

  for (const anchor of anchorPoints) {
    const distPx = Math.abs((cursor - anchor) * pxPerSec)
    if (distPx <= pixelThreshold && distPx < bestAnchorDistPx) {
      bestAnchorDistPx = distPx
      bestAnchor = anchor
    }
  }

  if (bestAnchor !== null) {
    return { dt: bestAnchor - currentPosition, snappedTo: bestAnchor }
  }

  // Grid fallback — snap the delta itself, not the absolute time. Using a grid
  // on the delta gives nice round offsets without fighting the anchor list.
  const grid = shiftKey ? 0.1 : 1.0
  const gridDt = Math.round(rawDt / grid) * grid
  const gridDistPx = Math.abs((rawDt - gridDt) * pxPerSec)
  if (gridDistPx <= pixelThreshold) {
    return { dt: gridDt, snappedTo: null }
  }

  return { dt: rawDt, snappedTo: null }
}
