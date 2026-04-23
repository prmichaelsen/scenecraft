/**
 * Overwrite-with-split overlap resolution for audio-clip drops (M11 task-104b).
 *
 * Given a range being dropped onto an audio track and the existing clips
 * already on that track, compute the list of batch operations needed to
 * make the drop land cleanly — DaVinci Resolve / Premiere style: the
 * dropped clip always wins, and existing clips get trimmed, consumed, or
 * split around it. The single undo group is enforced by the backend's
 * `/audio-clips/batch-ops` endpoint, so callers POST the whole list of
 * ops as one request.
 *
 * This is a pure function: no DOM, no fetch, no React. The AudioLane drop
 * handler wires it up; tests exercise the five overlap cases directly.
 */

export type ClipRow = {
  id: string
  track_id: string
  start_time: number
  end_time: number
  source_offset: number
  source_path: string
  // Fields passed through unchanged to a "split right half" insert. The
  // resolver only touches the time bounds + source_offset.
  volume_curve?: unknown
  muted?: boolean
  remap?: unknown
}

export type Range = {
  start: number
  end: number
}

/** Shape of a single op in the POST /audio-clips/batch-ops body. */
export type BatchOp =
  | {
      op: 'trim'
      id: string
      start_time?: number
      end_time?: number
      source_offset?: number
    }
  | { op: 'delete'; id: string }
  | {
      op: 'split'
      id: string
      at: number
      new_id: string
      source_offset_right?: number
    }
  | {
      op: 'insert'
      clip: {
        id: string
        track_id: string
        source_path: string
        start_time: number
        end_time: number
        source_offset: number
        volume_curve?: unknown
        muted?: boolean
        remap?: unknown
      }
    }

/**
 * Resolve what happens to `existing` clips when `dropped` lands on top of
 * them. Returns the list of ops the caller should POST (without the
 * terminal `insert` of the dropped clip itself — that's the caller's job,
 * since the caller decides target track, new id, source_path, etc.).
 *
 * Rules (matching `clarification-9` + design doc):
 *   - Dropped fully covers existing      → delete existing
 *   - Dropped covers existing LEFT edge  → trim existing: start_time ← dropped.end,
 *                                          source_offset ← source_offset + (dropped.end − existing.start_time)
 *   - Dropped covers existing RIGHT edge → trim existing: end_time ← dropped.start
 *   - Dropped fits INSIDE existing       → split: left half stays, middle deleted
 *                                          (the left half becomes the `trim` op;
 *                                          the right half becomes an `insert` op),
 *                                          the caller's dropped clip slots in between.
 *   - No overlap                         → no ops for this clip.
 *
 * Left-trim advances `source_offset` to keep audio-sync correct;
 * right-trim does not. This is the non-obvious piece the tests lock in.
 */
export function resolveOverlapsWithSplit(
  dropped: Range,
  existing: ClipRow[],
  genId: () => string,
): BatchOp[] {
  const ops: BatchOp[] = []

  for (const c of existing) {
    const overlaps = !(c.end_time <= dropped.start || c.start_time >= dropped.end)
    if (!overlaps) continue

    const coversLeft = dropped.start <= c.start_time
    const coversRight = dropped.end >= c.end_time

    if (coversLeft && coversRight) {
      // Dropped fully covers the existing clip → consume it.
      ops.push({ op: 'delete', id: c.id })
    } else if (coversLeft) {
      // Dropped covers existing's LEFT edge → push existing's start forward.
      ops.push({
        op: 'trim',
        id: c.id,
        start_time: dropped.end,
        source_offset: c.source_offset + (dropped.end - c.start_time),
      })
    } else if (coversRight) {
      // Dropped covers existing's RIGHT edge → trim end_time back. No
      // source_offset change — the left half reads the same region.
      ops.push({
        op: 'trim',
        id: c.id,
        end_time: dropped.start,
      })
    } else {
      // Dropped fits strictly INSIDE existing → split into (left, right),
      // with the dropped clip slotting in the middle.
      //   Left half  = trim existing's end_time down to dropped.start
      //   Right half = new clip from dropped.end → existing.end_time,
      //                with source_offset advanced so it reads the original
      //                source's tail cleanly.
      ops.push({ op: 'trim', id: c.id, end_time: dropped.start })
      ops.push({
        op: 'insert',
        clip: {
          id: genId(),
          track_id: c.track_id,
          source_path: c.source_path,
          start_time: dropped.end,
          end_time: c.end_time,
          source_offset: c.source_offset + (dropped.end - c.start_time),
          volume_curve: c.volume_curve,
          muted: c.muted,
          remap: c.remap,
        },
      })
    }
  }

  return ops
}
