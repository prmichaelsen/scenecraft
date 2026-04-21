# Task 94: Backend Cross-Track Move + Kf Ownership + Auto-Create Tracks

**Milestone**: [M10 — Clip Move Cross-Track](../../milestones/milestone-10-clip-move-cross-track.md)  
**Design**: [local.clip-move-cross-track.md](../../design/local.clip-move-cross-track.md)  
**Estimated Hours**: 6-8  
**Status**: Completed (2026-04-21)  
**Dependencies**: Task 93 (endpoint skeleton)  
**Backend commit**: scenecraft-engine 5a1ab7b  

---

## Objective

Extend `/move-transitions` to support cross-track moves (`trackDelta != 0`) with the full kf-ownership model from the design: interior kfs migrate, boundary kfs duplicate. On the source track, insert a single empty tr bridging the vacated span. When `trackDelta` would push any clip past the existing track range, auto-create new tracks with safe defaults.

No overlap resolution on target tracks yet (Task 95) — assume drops land on empty space for now.

---

## Steps

1. **Lift the `trackDelta != 0` guard** from Task 93; allow cross-track moves.

2. **Compute per-clip target track**:
   - Fetch all tracks sorted by `z_order`
   - For each tr in `transitionIds`:
     - Find its current track's index → `source_index`
     - Compute `target_index = source_index + trackDelta`
     - If `target_index < 0` or `target_index >= len(tracks)`:
       - If `autoCreateTracks`: flag for creation
       - Else: 400 with `OUT_OF_RANGE_TRACK`

3. **Auto-create tracks** (if `autoCreateTracks == True` and flagged):
   - Count how many tracks needed above existing (for negative overflow) and below (for positive overflow)
   - For each, insert a new track row with:
     - `name`: auto-generated (e.g., `"Track N"` where N is the next available ordinal)
     - `blendMode`: `"normal"`
     - `baseOpacity`: `1.0`
     - `enabled`: `1`
     - `z_order`: extended above/below existing range preserving order
   - Collect new track IDs into `createdTrackIds` for response

4. **Classify kfs as interior vs boundary**:
   - Build `moved_tr_set = set(transitionIds)`
   - A kf is **interior** if every tr referencing it (as from or to, `deleted_at IS NULL`) is in `moved_tr_set`
   - A kf is **boundary** otherwise (at least one non-moved tr references it)
   - Orphan edge kfs (first/last tr on source track, no neighbor on one side) count as **interior** for the single-side-orphan case — they can be safely migrated

5. **Source-track cleanup** (per distinct source track):
   - For each source track that lost clips:
     - Sort the vacated spans on that track (each moved tr contributes `[from_kf.timestamp, to_kf.timestamp]`)
     - Merge consecutive/overlapping spans
     - For each merged span `[span_from, span_to]`:
       - Surviving left kf = first kf on source track at or just before `span_from` that still has a neighbor (= remaining tr ending there)
       - Surviving right kf = first kf on source track at or just after `span_to` that still has a neighbor
       - If both exist: insert an empty tr bridging `[surviving_left, surviving_right]`
       - If only one exists (edge of track): no bridge needed; orphan side's kfs already soft-deleted via interior-kf migration
   - Soft-delete kfs that are now unreferenced on source (orphan migration or duplicate-then-move cleanup)

6. **Move kfs + update trs** (move mode):
   - For each interior kf: `UPDATE keyframes SET track_id = target, timestamp = new_time WHERE id = kf_id`
   - For each boundary kf being moved: `INSERT INTO keyframes (...)` with fresh id at `target` track and `new_time`; keep source copy in place
   - For each tr in batch: `UPDATE transitions SET track_id = new_track_id, from_kf = new_from_kf_id, to_kf = new_to_kf_id, duration_seconds = new_dur`

7. **Undo**:
   - Single `undo_begin` for the whole batch (kf inserts + updates + tr updates + track inserts + empty-tr inserts)

8. **Response**:
   - `createdTrackIds` populated with any auto-created track IDs
   - `movedTransitionIds` unchanged from Task 93 shape

9. **Tests**:
   - Single clip cross-track (trackDelta = +1), shared boundary kfs with source neighbors → source retains kfs, target has duplicated kfs, empty bridge inserted
   - Single clip cross-track (trackDelta = +1), unshared (orphan) boundary kfs → source kfs soft-deleted, target has migrated kfs
   - Multi-track source selection (clips on T2 + T3), trackDelta = -1 → T2 clips land on T1, T3 clips land on T2
   - Overflow → auto-create: trackDelta = -1 when all clips on T1 → new T0 created, clips land on T0
   - `autoCreateTracks: false` with overflow → 400 `OUT_OF_RANGE_TRACK`
   - Interior kf between two dragged clips (B|C boundary) → migrates in one row update
   - Empty-tr bridge inserted correctly when 2 consecutive clips are moved off a track

---

## Verification

- [ ] Cross-track move works for single clip (shared and orphan boundary kfs)
- [ ] Multi-track source selection with uniform `trackDelta` produces correct per-clip target tracks
- [ ] Interior kfs migrate in one UPDATE; boundary kfs duplicate via INSERT
- [ ] Source-track empty-tr bridge inserted for vacated spans
- [ ] Consecutive vacated spans merged into a single empty bridge
- [ ] Auto-create-tracks populates `createdTrackIds` with correct defaults
- [ ] `autoCreateTracks: false` + overflow → 400
- [ ] Source neighbors' timestamps unchanged after move
- [ ] Dragged clips' `trim_in`/`trim_out`/`selected` unchanged
- [ ] Undo reverts everything (kfs, trs, new tracks, bridge) in one entry
- [ ] All tests pass

---

**Next Task**: [Task 95: Overlap resolution](task-95-backend-overlap-resolution.md)  
