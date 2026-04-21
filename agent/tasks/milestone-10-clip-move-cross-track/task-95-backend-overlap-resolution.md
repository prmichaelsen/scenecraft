# Task 95: Backend Overlap Resolution

**Milestone**: [M10 — Clip Move Cross-Track](../../milestones/milestone-10-clip-move-cross-track.md)  
**Design**: [local.clip-move-cross-track.md](../../design/local.clip-move-cross-track.md)  
**Estimated Hours**: 6-8  
**Status**: Not Started  
**Dependencies**: Task 94 (cross-track + auto-create tracks)  

---

## Objective

Resolve overlaps on target tracks when dragged clips land on top of existing clips. Four cases: fully-inside target → soft-delete; target straddles drop's `new_from` → trim + proportional `trim_out` reduction; target straddles drop's `new_to` → trim + proportional `trim_in` advance; drop fully inside one target → three-way split. Empty-tr targets use kf-shift rather than trim math.

---

## Steps

1. **Per dragged clip, on its target track**:
   - After the tr is moved/placed (from Task 94), query existing trs on the target track where `deleted_at IS NULL` and time-span overlaps `[new_from, new_to]`, excluding trs in the move batch itself
   - Classify each overlap into one of four cases

2. **Case A — fully inside drop span** (`target.from >= new_from AND target.to <= new_to`):
   - Soft-delete the target: `UPDATE transitions SET deleted_at = <ISO now>`
   - Its from_kf / to_kf: soft-delete if no surviving tr references them
   - Append `target.id` to `consumedTransitionIds` in response

3. **Case B — target straddles `new_from`** (`target.from < new_from AND target.to <= new_to`):
   - Compute target's current factor: `factor = (target.trim_out - target.trim_in) / (target.to_time - target.from_time)`
   - Shrink target: new `to_kf` becomes the dragged clip's `new_from_kf`
     - `UPDATE transitions SET to_kf = new_from_kf_id, trim_out = target.trim_in + (new_from - target.from_time) * factor, duration_seconds = new_from - target.from_time`
   - Append `target.id` to `splitTransitionIds`

4. **Case C — target straddles `new_to`** (`target.from >= new_from AND target.to > new_to`):
   - Compute target's current factor
   - Shrink target: new `from_kf` becomes dragged clip's `new_to_kf`
     - `UPDATE transitions SET from_kf = new_to_kf_id, trim_in = target.trim_in + (new_to - target.from_time) * factor, duration_seconds = target.to_time - new_to`
   - Append `target.id` to `splitTransitionIds`

5. **Case D — drop fully inside a single target** (`target.from < new_from AND target.to > new_to`):
   - Three-way split, preserving variant/trim on remainders:
     - **Left remainder**: clone target into new tr with `id = next_transition_id()`, `from_kf = target.from_kf`, `to_kf = new_from_kf_id`, `trim_in = target.trim_in`, `trim_out = target.trim_in + (new_from - target.from_time) * factor`, `duration_seconds = new_from - target.from_time`
     - **Right remainder**: clone target into new tr with `id = next_transition_id()`, `from_kf = new_to_kf_id`, `to_kf = target.to_kf`, `trim_in = target.trim_in + (new_to - target.from_time) * factor`, `trim_out = target.trim_out`, `duration_seconds = target.to_time - new_to`
     - Clone `tr_candidates` junction rows for both remainders (both reference the original target's pool files)
     - Refresh `selected_transitions/{remainder_id}_slot_N.mp4` cache for both
     - Soft-delete the original target
   - Append original target.id to `splitTransitionIds` (appears once even though it produced two remainders)

6. **Empty-tr target variant**:
   - If target is empty (`selected IS NULL` / `[None]`), skip trim math entirely
   - Case A (fully inside): soft-delete empty
   - Case B (straddle `new_from`): move empty's `to_kf` to `new_from_kf`
   - Case C (straddle `new_to`): move empty's `from_kf` to `new_to_kf`
   - Case D (drop inside empty): split empty into two empties flanking the dropped clip

7. **No-gap invariant repair** on target tracks:
   - After all dragged clips placed + overlaps resolved, walk the target track chronologically
   - Find gaps between trs (from_kf of one tr ≠ to_kf of previous tr by timestamp)
   - Insert empty trs bridging each gap

8. **Tests**:
   - Drop entirely over a content tr → target soft-deleted, `consumedTransitionIds` populated
   - Drop straddles `new_from` of a content tr → target trimmed with factor-preserved `trim_out`
   - Drop straddles `new_to` of a content tr → target trimmed with factor-preserved `trim_in`
   - Drop entirely inside a content tr → three-way split, both remainders have correct proportional trims
   - Drop inside an empty tr → empty split, kfs moved (no trim math)
   - Drop over multiple targets simultaneously → each target resolved per-case correctly
   - No-gap invariant holds after every test case

---

## Verification

- [ ] Fully-inside targets soft-deleted; bin has them for recovery
- [ ] Straddle cases (B/C) preserve target's time_remap_factor on the surviving remainder
- [ ] Three-way split produces correct left and right remainders with proportional trims
- [ ] Both remainders' junction rows cloned from original target
- [ ] Both remainders' selected_transitions cache refreshed
- [ ] Empty-tr targets handled via kf-shift only (no trim math)
- [ ] No-gap invariant preserved on target tracks after commit
- [ ] Response `consumedTransitionIds` and `splitTransitionIds` populated correctly
- [ ] Undo reverts overlap resolution in the same entry as the move
- [ ] All tests pass

---

**Next Task**: [Task 96: Copy mode](task-96-backend-copy-mode.md)  
