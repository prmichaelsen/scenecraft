# Clip Move — Drag and Drop Across Tracks

**Concept**: Drag a clip (or group of clips) on the timeline to reposition them in time and/or move them between tracks, with overlap resolution that splits or consumes existing target-track clips while preserving the dragged clip's internal state  
**Created**: 2026-04-21  
**Status**: Design Specification  
**Source**: [clarification-6-clip-move-cross-track.md](../clarifications/clarification-6-clip-move-cross-track.md)  
**Sibling**: [local.clip-trim-and-snap.md](local.clip-trim-and-snap.md) — boundary drags (trim / rolling / remap)

---

## Overview

Scenecraft's timeline supports keyframe-bounded transitions (clips) arranged linearly on named tracks. Clarification 4 / Task 48–49 added boundary drags for single-side trims, rolling edits, and time remaps. This document specifies the complementary gesture: **dragging the body of a clip** to reposition it in time or move it to a different track, optionally as part of a multi-clip group selection spanning multiple source tracks.

The invariant the entire design preserves: **the dragged clip's trim values, selected variant, candidates, effects, and all other state are unchanged by the drag. The drag changes only the clip's time position and (optionally) its track assignment.** Overlap resolution mutates the *target* clips that get hit, never the dragged clips themselves.

---

## Problem Statement

Current limitations:

1. **No drag-based repositioning.** Clip moves today require editing kf timestamps manually or re-generating — there's no direct-manipulation gesture for "move this clip 3 seconds later".
2. **No cross-track moves.** A clip's `track_id` can only change through full delete + re-insert flows; no interactive path.
3. **Multi-clip operations are ad-hoc.** Users can multi-select for batch delete, but there's no primitive for "shift these 5 clips together while preserving their relative layout".
4. **Multi-track source selections have no move primitive.** Clips selected across tracks T2 and T3 need to be moved as a group preserving their relative track offsets (track_delta applied uniformly).

Without these, common NLE workflows — rearranging sections, swapping clips between layers, nudging a sequence of beats into time with music — are blocked or require round-tripping through the backend.

---

## Solution

### Drag source and gesture

Body-drag is initiated by mousedown on a transition bar's **interior** (the area not claimed by the `<]` / `<|>` / `[>` boundary zones from clarification 4). A 3–4 px movement threshold distinguishes a body-drag from a plain selection click. Cursor is `grab` on hover and `grabbing` during the drag.

**Selection semantics at drag start**:
- If the clicked clip is in the current `selectedTransitionIds` multi-select set, drag the entire set.
- If the clicked clip is *not* in the selection, drag only that single clip and leave the existing selection untouched.

**Delta-based motion**:
- `timeDelta = (cursor_now.x - cursor_start.x) / pxPerSec` — all dragged clips shift their timestamps by the same `timeDelta`.
- `trackDelta = target_row_index - primary_clip_source_row_index` — all dragged clips apply the same `trackDelta`. This generalizes to multi-track source selections: a group on T2+T3 dragged from T3 to T2 yields `trackDelta = -1`, so T2 clips land on T1 and T3 clips land on T2.

The **primary-dragged clip** (the one under mousedown) is the source of truth for `trackDelta`. All other selected clips inherit the same delta.

### Modifier keys

| Modifier | Behavior |
|---|---|
| (none) | Move: dragged clips leave their source positions and land on the target positions |
| `Cmd` / `Ctrl` | Copy: dragged clips are duplicated at the target positions; sources remain in place |
| `Shift` | **Unbound** — snap is governed by the global snap toggle (Tasks 50/51), not a per-drag modifier |
| `Alt` | **Unbound** |

Snap behavior (snap-on-drop to kf boundaries, playhead, 0:00) is **deferred to P2** and will be wired through the same global `snapEnabled` state that governs boundary-drag snapping.

### Kf ownership model — "clips carry their boundary kfs"

When a clip moves, its boundary keyframes move *with* it conceptually. Because each kf has a single `track_id` and a fixed `timestamp`, the DB-level implementation is:

- **Interior kfs** (kfs used only by clips inside the dragged group) migrate directly: one row update, `track_id` flipped, `timestamp` set to the new value.
- **Boundary kfs** (kfs shared with a source neighbor that is NOT being dragged) are **duplicated** on exit: one copy stays on source (still bounding the neighbor), one copy goes to target (at the new drop timestamp, `track_id` = target).
- **Orphan boundary kfs** (kfs where the dragged clip is the first or last on its source track, with no neighbor on one side) are soft-deleted — no duplication needed.

### Source-track cleanup

After the clips leave, the source track must preserve the no-gap invariant. A single **empty tr** bridges the vacated span between the now-adjacent neighbors' retained boundary kfs. The dragged clips' source-side history is preserved: source neighbors' kfs and timestamps are unchanged.

If removing the clips empties the source track, the track itself is **kept** (empty). Lifecycle is user-managed — no auto-delete.

### Target-track overlap resolution

The dragged group lands at `[new_from, new_to]` on the target track. Existing clips on that track are resolved as follows:

| Target tr overlap | Action |
|---|---|
| **Fully inside** `[new_from, new_to]` | Soft-delete (recoverable from bin) |
| **Straddles `new_from`** (target extends left past new_from, ends inside the drop span) | Trim: target becomes `[target.from → new_from_kf]`, `trim_out` reduced proportionally by target's current `time_remap_factor` |
| **Straddles `new_to`** (target starts inside drop span, extends right past new_to) | Trim: target becomes `[new_to_kf → target.to]`, `trim_in` advanced proportionally |
| **Drop fully inside a single target** | Three-way split: `[target.from → new_from_kf]` (original variant, trim reduced) + dropped clip + `[new_to_kf → target.to]` (original variant, trim advanced) |

Special case: **empty tr as target**. Empties have no trim to adjust, so trimming reduces to "move the empty's kf to the dragged boundary". If the drop is entirely inside the empty, both sides of the empty shrink (or the empty is split in two) and the dragged clip sits in the middle.

### Auto-create tracks on overflow

If `trackDelta` would push any dragged clip's target_track_index below zero or past the last existing track, **new tracks are automatically created** to accommodate. Group layout is always preserved — no clamping, no blocking. New tracks inherit safe defaults (see Key Design Decisions).

### Visual feedback during drag

- **Ghost preview**: ~50% opacity copy of the dragged clip(s) rendered at the tentative position. Preview origin anchors at `(cursor.x + 4px, cursor.y + 4px)` so the preview sits at the bottom-right of the cursor and doesn't occlude the hotspot. Multi-clip ghosts are a composite positioned at `preview_origin + (clip_offset_from_primary)`.
- **Target-track highlight**: subtle tint on the target track's header/row.
- **Overlap preview**: would-be-consumed target clips render with a red tint; split lines render where dragged boundaries would cut existing clips.
- **Auto-create tracks preview**: ghost rows above/below the existing track stack (dashed border, "New track" label) when the drop would require new tracks.
- **Tooltip** near the primary ghost: new start timestamp, new end timestamp, target track name, `Δ+X.YZs`, and "N clips" if multi-clip.
- **Copy-mode badge**: Cmd+drag shows a `+` badge or green tint on the ghost so the user knows it's a copy.

### Atomicity

A drag commits as a single backend call regardless of how many clips are being moved or how many overlap targets need resolution. Intermediate states never violate invariants because the server computes the entire transformation atomically. One undo entry per gesture.

---

## Implementation

### Backend endpoint

```
POST /api/projects/:name/move-transitions
```

**Request body**:
```json
{
  "mode": "move" | "copy",                     // default "move"
  "trackDelta": -1,                             // applied to each tr's current track_id
  "timeDeltaSeconds": 3.5,                      // applied to each tr's from/to timestamps
  "transitionIds": ["tr_001", "tr_002", ...],   // flat list of clips in the batch
  "autoCreateTracks": true                      // default true
}
```

**Response**:
```json
{
  "success": true,
  "movedTransitionIds": ["tr_001", "tr_002"],
  "createdTrackIds": ["track_7"],           // auto-created tracks (if any)
  "consumedTransitionIds": ["tr_099"],      // soft-deleted fully-overlapped targets
  "splitTransitionIds": ["tr_042"]          // existing trs split at dragged boundaries
}
```

**Server-side algorithm** (per request, single transaction):

```
1. Resolve and validate:
   - fetch all tr rows for transitionIds, their from/to kfs, and their current track_ids
   - compute each tr's new_track_id = current_track_id_index + trackDelta → track_id
   - compute each tr's new_from_time = from_kf.timestamp + timeDeltaSeconds
   - compute each tr's new_to_time = to_kf.timestamp + timeDeltaSeconds
   - validate: all new_from_time >= 0; all new_from_time < new_to_time (should always hold)

2. Auto-create tracks (if autoCreateTracks):
   - find max negative track_index (clips that go above) → prepend N new tracks at top
   - find max positive overflow (clips that go past bottom) → append N new tracks at bottom
   - new tracks inherit: blendMode="normal", baseOpacity=1.0, enabled=true,
     name=auto-generated ("Track N"), z_order continues the existing range

3. Determine interior vs boundary kfs (MOVE mode only):
   - build a set of tr_ids being moved
   - a kf is "interior" if ALL trs referencing it (both as from and as to) are in the moved set
   - a kf is "boundary" if at least one non-moved tr references it
   - orphan kfs (referenced only by a moved tr and no other) where the tr is the edge of its source track count as interior

4. Source-track cleanup (MOVE mode only, per vacated span per source track):
   - collapse multiple consecutive vacancies into a single range
   - insert ONE empty tr spanning the vacated range, bounded by the surviving boundary kfs
   - soft-delete orphan kfs that are no longer referenced

5. Move / duplicate dragged clips:
   - MOVE mode:
     - for interior kfs: UPDATE keyframes SET track_id=new_track, timestamp=new_time
     - for boundary kfs: INSERT new keyframe on target at new_time; leave source copy in place
     - UPDATE each tr SET track_id=new_track, from_kf=new_from_kf_id, to_kf=new_to_kf_id
   - COPY mode:
     - INSERT new kfs for ALL boundaries on target (no source cleanup)
     - INSERT new tr row with fresh tr_id, clone trim/selected/effects/curves/label/tags
     - clone tr_candidates junction rows for the new tr_id
     - refresh selected_transitions/{new_tr_id}_slot_N.mp4 cache via existing variant-resolution

6. Target-track overlap resolution (per dragged clip, per target track):
   - fetch existing trs on target track that overlap [new_from, new_to] (excluding trs being dragged/copied into place)
   - classify each:
     - fully-inside → soft-delete (marked in consumedTransitionIds)
     - straddles new_from → trim: to_kf = new_from_kf, trim_out -= (target.to_kf.time - new_from) * factor
     - straddles new_to → trim: from_kf = new_to_kf, trim_in += (new_to - target.from_kf.time) * factor
     - drop fully inside → three-way split: clone the target, left remainder keeps original from_kf, right remainder gets original to_kf; both remainders preserve variant and trim proportionally
   - empty tr targets: no trim math, just move the kf to the dragged boundary

7. No-gap invariant repair on target tracks:
   - find any gaps between drop span and flanking content
   - insert empty tr bridges as needed

8. Commit transaction; emit undo entry; return response payload
```

### Frontend

**New component state** (`TransitionTrack.tsx`):

```typescript
type MoveDragState = {
  primaryTrId: string
  draggedIds: string[]
  startX: number
  startY: number
  startTrackId: string
  mode: 'move' | 'copy'  // set from metaKey/ctrlKey at mousedown
  timeDelta: number      // updated on mousemove
  trackDelta: number     // updated on mousemove
}
```

**Gesture flow**:
1. **mousedown** on transition bar interior → stash `MoveDragState`, mark gesture as pending. Don't start drag yet.
2. **mousemove** (< 3 px movement) → still pending; treat as click-on-release.
3. **mousemove** (>= 3 px) → gesture locks to "move". Set cursor to `grabbing`. Compute `timeDelta`/`trackDelta` from mouse position and target-track detection. Render ghost preview, tooltip, overlap preview, and auto-create-track ghost rows. No DB writes yet.
4. **mouseup** → if gesture is "move", compute final deltas, call `postMoveTransitions({ mode, trackDelta, timeDeltaSeconds, transitionIds, autoCreateTracks: true })`. Clear state. Refresh timeline data on success.
5. **Escape key during drag** → cancel: clear state, no DB write.

**Ghost preview rendering** (schematic):
```tsx
{moveDragState && (
  <div
    className="pointer-events-none fixed z-50"
    style={{
      left: cursorX + 4,
      top: cursorY + 4,
      opacity: 0.5,
    }}
  >
    {moveDragState.draggedIds.map((id) => {
      const tr = trById.get(id)
      const offsetX = (tr.from_time - primaryClip.from_time) * pxPerSec
      const offsetY = (tr.track_index - primaryClip.track_index) * TRACK_HEIGHT
      return (
        <div
          key={id}
          className="absolute bg-orange-500/30 border border-orange-500 rounded"
          style={{
            left: offsetX,
            top: offsetY,
            width: (tr.to_time - tr.from_time) * pxPerSec,
            height: TRACK_HEIGHT,
          }}
        >
          {moveDragState.mode === 'copy' && <PlusBadge />}
        </div>
      )
    })}
  </div>
)}
```

**Overlap preview** requires computing the *would-be* state on every mousemove:
```typescript
function computeTargetTrackOverlapPreview(
  dragState: MoveDragState,
  allTrs: Transition[],
): {
  consumedIds: string[]
  splitLines: Array<{ targetTrId: string, x: number }>
}
```

The preview computation must be cheap (< 5 ms) to run on every mousemove. Memoize by `{timeDelta, trackDelta, mode}` since those are the only inputs that change.

**Client helper**:
```typescript
export async function postMoveTransitions(
  project: string,
  opts: {
    mode?: 'move' | 'copy'
    trackDelta: number
    timeDeltaSeconds: number
    transitionIds: string[]
    autoCreateTracks?: boolean
  },
): Promise<{ success: boolean; movedTransitionIds: string[]; createdTrackIds: string[]; consumedTransitionIds: string[]; splitTransitionIds: string[] }>
```

### Data model — no schema changes

Every piece of state this feature mutates already exists in the schema:
- `transitions.track_id` — already nullable-string, already used for track membership
- `transitions.from_kf`, `transitions.to_kf` — already nullable-string
- `keyframes.track_id`, `keyframes.timestamp` — already mutated by existing trim endpoints
- `transitions.trim_in`, `transitions.trim_out` — already mutated by trim endpoints
- `transitions.deleted_at` — already used for soft-delete (bin)
- `tr_candidates` junction table — already used by split/duplicate

---

## Benefits

- **NLE-standard interaction**: drag-to-move is the expected gesture in every video editor; users don't have to learn a scenecraft-specific flow.
- **Cross-track reorganization**: moving a clip between layers unlocks common composition workflows (swap a clip's layer to test blend modes, move a beat from foreground to background).
- **Multi-clip group motion**: selecting a sequence and sliding it in time (preserving internal layout) is a core editorial move.
- **Multi-track source selections**: selections spanning tracks behave as a rigid group under a single delta, matching user expectation.
- **Non-destructive overlap semantics**: existing work on target tracks isn't destroyed — it's trimmed at boundaries or soft-deleted (recoverable from bin).
- **No schema changes**: lands as an endpoint + frontend gesture + small backend helper. No migration.
- **Atomic undo**: a whole rearrangement is one undo entry; the user gets the "big undo" they expect.

---

## Trade-offs

- **Overlap preview cost**: computing "what would happen if I dropped here" on every mousemove requires re-walking the target track's trs. Memoization helps; coarse throttling (~60 fps cap) helps further.
- **Boundary-kf duplication**: creates more kf rows over time as users drag clips around. Duplicate kfs with identical timestamps could in theory be merged at commit time, but this is a low-priority optimization — kfs are cheap.
- **Auto-create tracks can surprise users**: a user dragging to re-time a clip might accidentally create a new track if their mouse strays outside the existing track stack. Mitigation: the ghost track preview (dashed "New track" row) signals the intent clearly before commit.
- **Deferred snap means pixel-imprecise drops**: until Tasks 50/51 ship, dropping a clip exactly at an existing boundary requires careful mouse work. Acceptable for MVP; snap lands shortly after.
- **No ripple**: dragging a clip on top of another doesn't push the second clip out of the way — it consumes it. This is the "overwrite" model from NLEs. Users wanting ripple edits should use the Shift+drag on boundary zones (clarification 4) and arrange content with empty spacers.

---

## Dependencies

- **Clarification 4 artifacts** (trim / rolling / remap + snap toggle): the boundary zones define the body-drag region (everything else), and the snap toggle governs drop snapping (P2).
- **Existing `undo_begin` infrastructure**: atomicity.
- **Existing `tr_candidates` junction table** (from clarification 4): needed for copy-mode junction cloning.
- **Existing track creation helpers**: auto-create-tracks path.
- **No external libraries required.**

---

## Testing Strategy

### Backend
- **Unit tests** for the move algorithm:
  - single-clip same-track move (no overlaps) → only timestamps change
  - single-clip cross-track move → source empty inserted, target has new kfs
  - multi-clip same-track move → batch applied, no intermediate invariant violations
  - multi-track source selection with negative trackDelta → group lands preserving relative offsets
  - boundary-kf duplication → source neighbor's to_kf untouched, target has new duplicate
  - interior-kf migration → single row updated, timestamp and track_id flipped
  - auto-create-tracks top/bottom → new track rows created with expected defaults
- **Overlap resolution tests**:
  - drop fully consumes a target tr → target soft-deleted
  - drop straddles target's right edge → target trimmed with proportional trim_out reduction
  - drop straddles target's left edge → target trimmed with proportional trim_in advance
  - drop fully inside target → three-way split produces correct left/right remainders
  - drop onto empty tr → empty shrunk correctly
- **Copy-mode tests**:
  - source clip unchanged, target has clone with fresh tr_id
  - junction rows cloned, pool files referenced (not copied)
  - selected_transitions cache refreshed
- **Atomicity test**: artificial mid-transaction failure → no partial mutations persisted; undo restores prior state

### Frontend
- **Gesture tests**:
  - 2-px movement after mousedown → no drag initiated, click fires
  - 5-px movement → drag initiated, ghost rendered
  - Escape during drag → cancelled, no mutation
  - mouseup outside any track → drop still commits (if timeDelta within clamps)
- **Multi-clip drag**:
  - primary clip in selection → all selected clips ghost, all move on commit
  - primary clip not in selection → only primary ghosts and moves
- **Cursor / badge tests**:
  - hover transition body → `grab` cursor
  - active drag → `grabbing` cursor
  - Cmd-held at drag start → `+` badge on ghost
- **Overlap preview**: red tint on would-be-consumed, split lines on would-be-trimmed

### Integration
- End-to-end: drag a clip from T1 to T2, verify rendered output plays both tracks correctly
- Undo after a multi-clip cross-track drag restores the exact prior layout, including trim values and selected variants

---

## Migration Path

No migration required — this is an additive feature. All schema fields exist already, and the endpoint is new.

Rollout sequence (see "Tasks" below):
1. Backend endpoint + move algorithm + auto-create-tracks → server-side unit tests pass
2. Frontend drag gesture + ghost preview (same-track single-clip move only, no overlap preview)
3. Overlap resolution + overlap preview
4. Multi-clip and multi-track source selections
5. Copy mode (Cmd+drag)
6. Polish: tooltip, track highlight, auto-create-track preview rows
7. P2 follow-up: snap-on-drop once Tasks 50/51 ship

---

## Key Design Decisions

### Gesture & Selection

| Decision | Choice | Rationale |
|---|---|---|
| Drag source region | Transition bar interior, excluding `<]`/`<|>`/`[>` zones | Reserves boundary zones for trim/rolling/remap (clarification 4); body-drag gets the rest |
| Movement threshold | 3–4 px | Distinguishes click-select from move-drag; standard for desktop direct-manipulation UIs |
| Hover cursor | `grab` | OS-native affordance for "this is draggable" |
| Active-drag cursor | `grabbing` | OS-native affordance for "drag in progress" |
| Ghost preview anchor | Bottom-right of cursor (`cursor + 4px, 4px`) | Keeps cursor unobstructed; drop point visible directly adjacent to hotspot |
| Primary-clip selection rule | If clicked clip is in multi-select, drag all; else drag only clicked | Least-surprise — explicit selections are respected |
| Multi-track source selections | Apply uniform `trackDelta` | Supports groups already spanning multiple tracks; consistent with multi-clip semantics |
| `trackDelta` source of truth | Primary-dragged clip's source track → drop-target track | User's mouse gesture defines the delta; other selected clips inherit |
| Out-of-range `trackDelta` | Auto-create tracks above/below | Preserves group layout; no silent clipping of clips to valid range |

### Modifier Keys

| Modifier | Behavior | Rationale |
|---|---|---|
| (none) | Move | Default NLE behavior |
| Cmd/Ctrl | Copy-on-drop | NLE convention; duplicates at drop, source unchanged |
| Shift | Unbound for body-drag | Snap is a global toggle (clarification 4 / Task 50), not a per-drag override |
| Alt | Unbound | Reserved for future use |

### Kf Ownership & Source Cleanup

| Decision | Choice | Rationale |
|---|---|---|
| Kf identity under move | Interior kfs migrate; boundary kfs duplicate | Preserves single-`track_id` invariant while matching user's mental model of "clips carry their boundaries" |
| Source-track gap | Fill with single empty tr bridging the vacated span | Preserves no-gap invariant from clarification 4; preserves time positions of source neighbors |
| Ripple-collapse on source? | No | Would unexpectedly move other clips; user rejected this explicitly |
| Orphan boundary kf (first/last tr on source) | Soft-delete | Not needed for any neighbor; don't leak stale rows |
| Track lifecycle on last clip removal | Keep empty track | User-managed lifecycle; avoids accidental track loss |

### Target-Track Overlap Resolution

| Target overlap | Action | Rationale |
|---|---|---|
| Fully inside drop span | Soft-delete | Matches "overwrite" model of NLE drops; recoverable via bin |
| Straddles drop's `new_from` | Trim to end at `new_from_kf` with proportional `trim_out` reduction | Factor preserved on the surviving remainder |
| Straddles drop's `new_to` | Trim to start at `new_to_kf` with proportional `trim_in` advance | Factor preserved on the surviving remainder |
| Drop fully inside a single target | Three-way split (remainder-left + dropped + remainder-right) | Natural extension of the straddle cases |
| Target is empty tr | Move the empty's kf(s) to the dragged boundary | Empties have no trim — kf shift is sufficient |
| Snap new_from / new_to to nearby kfs / playhead / 0:00 | **P2 — deferred** | Snap toggle infrastructure (Tasks 50/51) is prerequisite |

### Clamping & Invariants

| Decision | Choice | Rationale |
|---|---|---|
| `new_from >= 0` | Hard clamp | Timeline origin is invariant; negative times are meaningless |
| Clip timeline duration preserved during move | Hard invariant | Drag shifts both endpoints by same delta; body-drag doesn't trim |
| Drop past current timeline duration | Allowed — extends the timeline | No artificial ceiling; timeline grows to accommodate |
| No-gap invariant | Enforced on every track before commit | Clarification 4 invariant preserved across all operations |
| Single `track_id` per kf | Enforced via boundary-kf duplication | Schema constraint honored |

### Endpoint & Atomicity

| Decision | Choice | Rationale |
|---|---|---|
| Endpoint shape | Delta-based (`trackDelta`, `timeDeltaSeconds`, flat `transitionIds[]`) | Clients don't pre-compute per-clip destinations; auto-create-tracks has one calculation point |
| Modes | `"move"` / `"copy"` via single `mode` field | Avoids duplicate `/copy-transitions` endpoint |
| `autoCreateTracks` flag | Optional, default `true` | Allows non-UI clients to opt out; UI always wants true |
| Atomicity | Whole batch in one DB transaction | Invariant violations can't leak to client |
| Undo granularity | One entry per gesture | User expectation: "undo the drag" is a single operation |

### Visual Feedback

| Feedback | MVP / P2 | Notes |
|---|---|---|
| 50% opacity ghost preview | MVP | Standard direct-manipulation affordance |
| Target track highlight | MVP | Subtle tint; cheap to render |
| Overlap preview (red tint + split lines) | MVP | User explicitly requested; essential for predictability |
| Auto-create track ghost rows | MVP | Signals track creation intent before commit |
| Tooltip with timestamps + Δ + N-clips | MVP | Information-dense; helps precision moves |
| Copy-mode `+` badge | MVP | Disambiguates move vs copy at a glance |
| Snap indicators (blue line on snap) | P2 | Depends on Tasks 50/51 |

### Non-Goals (MVP)

| Excluded | Rationale |
|---|---|
| Insert / ripple mode (push downstream clips to make room) | Shift+drag on boundary zones handles ripple for trims; body-drag is overwrite-on-drop |
| Drag-to-generate (create clip by dragging on empty space) | Distinct gesture; out of scope |
| Rubber-band selection extending during drag | Selection is fixed at drag start |
| Drag-to-bin (drop onto bin panel to delete) | Existing delete flow is sufficient |

---

## Future Considerations

- **Snap-on-drop** (P2): wire body-drag drop points into the global snap target set (kfs, tr boundaries, playhead, 0:00) once Tasks 50/51 ship. Visual feedback: blue line on the snapped boundary, sticky cursor within threshold.
- **Ripple-move modifier**: optional `Opt+Shift+drag` to push downstream clips out of the way instead of consuming them. Distinct from ripple-trim (already covered by Shift+drag on boundary zones).
- **Cross-project clip move**: drag a clip from one project's timeline into another. Requires file-level clone; much larger scope.
- **Dragged-boundary merging**: when a drag's `new_to_kf` lands within a few frames of an existing kf, merge them (don't create a duplicate kf row). Could be handled at commit time as a post-processing pass.
- **Undo/redo keyboard shortcuts for drags**: leverage existing `undo_begin` + keyboard integration.

---

**Status**: Design Specification  
**Recommendation**: Proceed to task breakdown — backend endpoint (including move algorithm + auto-create-tracks), then frontend gesture with same-track moves, then cross-track + multi-clip + overlap preview, then copy mode, then P2 snap integration once Tasks 50/51 land.  
**Related Documents**:
- [clarification-6-clip-move-cross-track.md](../clarifications/clarification-6-clip-move-cross-track.md) — source of all design decisions
- [local.clip-trim-and-snap.md](local.clip-trim-and-snap.md) — sibling feature: boundary drags (trim/rolling/remap) and snap toggle infrastructure
