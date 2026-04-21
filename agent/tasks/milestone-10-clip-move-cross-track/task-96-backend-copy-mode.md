# Task 96: Backend Copy Mode

**Milestone**: [M10 — Clip Move Cross-Track](../../milestones/milestone-10-clip-move-cross-track.md)  
**Design**: [local.clip-move-cross-track.md](../../design/local.clip-move-cross-track.md)  
**Estimated Hours**: 3-4  
**Status**: Not Started  
**Dependencies**: Task 95 (overlap resolution)  

---

## Objective

Support `mode: "copy"` on `/move-transitions` — duplicate the dragged clips at the target position, leaving the source clips untouched. Clones the tr row, `tr_candidates` junction rows (so both original and copy reference the same pool files — no file duplication), and refreshes the `selected_transitions` cache for the copy.

---

## Steps

1. **Remove the 501 guard** from Task 93: accept `mode: "copy"`.

2. **In copy mode, skip source-track cleanup** (Tasks 94 step 5):
   - No empty-tr bridge on source
   - No kf migration/deletion on source
   - Source tr rows unchanged

3. **Create target kfs for ALL boundaries** (not just interior):
   - No kf is "moved"; every kf needed on target is a fresh INSERT
   - Reuse existing target-track kfs at matching timestamps if present (future: snap-driven; for now strict timestamp equality)

4. **Clone each tr row** in the batch:
   - `new_tr_id = next_transition_id(project_dir)`
   - `INSERT INTO transitions (id, track_id, from_kf, to_kf, duration_seconds, trim_in, trim_out, source_video_duration, selected, slots, action, use_global_prompt, remap, track_id, label, label_color, tags, blend_mode, opacity, opacity_curve, ..., is_adjustment, ...)` — copy ALL fields from the source tr except `id`, `track_id` (use target), `from_kf`, `to_kf` (use new target kfs), and `duration_seconds` (use new timeline duration)

5. **Clone `tr_candidates` junction rows**:
   - Fetch all rows `WHERE tr_id = source_tr_id AND deleted_at IS NULL`
   - For each row: `INSERT` with `tr_id = new_tr_id`, same `slot`, `pool_segment_id`, `rank`, `added_at`, `label`, etc.
   - Both original and copy now reference the same pool files

6. **Refresh `selected_transitions/{new_tr_id}_slot_N.mp4` cache**:
   - For each populated slot on the new tr, re-run the variant-resolution path that creates the slot cache (same logic used after `UPDATE` of `selected`)
   - Reuses `shutil.copy2` from the source pool file (no re-encoding)

7. **Overlap resolution on target** (Task 95):
   - Applies identically in copy mode — existing target-track clips still get trimmed/consumed/split when the copy lands on them
   - The source clips are NOT in the target-overlap resolution scope (they're not on the target track)

8. **Response**:
   - `movedTransitionIds` contains the NEW tr IDs (the copies), not source tr IDs
   - This lets the frontend select the copies after the operation
   - Callers that need both source and copy IDs can pair them by order (index i in request → index i in response)

9. **Tests**:
   - Single clip copy same-track → source unchanged, new tr at target position with cloned junction rows
   - Single clip copy cross-track → source unchanged, target has copy with correct track_id
   - Multi-clip copy → all sources unchanged, all copies present with fresh tr_ids
   - Copy lands on overlap → overlap resolution fires normally (consumed / trimmed targets), copy itself unaffected
   - Both original and copy reference same pool files (no pool duplication)
   - `selected_transitions` cache exists for copy after operation

---

## Verification

- [ ] `mode: "copy"` accepted; source clips unchanged after operation
- [ ] New tr rows inserted with all fields cloned except `id`, `track_id`, `from_kf`/`to_kf`, `duration_seconds`
- [ ] `tr_candidates` junction rows cloned for each copied tr (same `pool_segment_id`, `rank`, etc.)
- [ ] No pool file duplication (both original and copy reference same files)
- [ ] `selected_transitions/{new_tr_id}_slot_N.mp4` cache refreshed for each populated slot
- [ ] Overlap resolution on target works identically to move mode
- [ ] Response `movedTransitionIds` contains new tr IDs (the copies)
- [ ] Undo reverts copy in one entry
- [ ] All tests pass

---

**Next Task**: [Task 97: Frontend body-drag gesture](task-97-frontend-body-drag.md)  
