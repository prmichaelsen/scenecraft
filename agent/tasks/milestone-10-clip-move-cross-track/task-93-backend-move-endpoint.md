# Task 93: Backend `/move-transitions` Endpoint + Same-Track Move

**Milestone**: [M10 — Clip Move Cross-Track](../../milestones/milestone-10-clip-move-cross-track.md)  
**Design**: [local.clip-move-cross-track.md](../../design/local.clip-move-cross-track.md)  
**Estimated Hours**: 5-7  
**Status**: Not Started  
**Dependencies**: M7 Task 44 (schema), M7 Task 45 (backend trim support)  

---

## Objective

Create the `POST /api/projects/:name/move-transitions` endpoint with a minimal first implementation: same-track, single-clip, time-delta-only moves. No cross-track, no overlap resolution, no copy mode — those come in tasks 94, 95, 96. Establishes the endpoint contract and the undo integration.

---

## Steps

1. **Endpoint registration** in `api_server.py`:
   - `POST /api/projects/:name/move-transitions`
   - Parse body: `{ mode, trackDelta, timeDeltaSeconds, transitionIds[], autoCreateTracks }`
   - Validate `mode` in `("move", "copy")`; for now reject `"copy"` with `501 Not Implemented`
   - Validate `transitionIds` non-empty
   - Validate all tr_ids exist and `deleted_at IS NULL`
   - For this task only: validate `trackDelta == 0` (cross-track deferred to Task 94)

2. **Same-track move algorithm** (transaction-wrapped):
   - For each tr_id in `transitionIds`:
     - Fetch tr + from_kf + to_kf
     - Compute `new_from_time = parse_ts(from_kf.timestamp) + timeDeltaSeconds`
     - Compute `new_to_time = parse_ts(to_kf.timestamp) + timeDeltaSeconds`
     - Clamp: `new_from_time >= 0` (raise 400 if violated after shift)
     - Determine kf shareability: are from_kf / to_kf referenced by any other tr (not in `transitionIds`)?
       - If unshared: update kf.timestamp in place
       - If shared: create a NEW kf at the new timestamp on the same track; repoint this tr's from/to to the new kf
   - Update each tr's `duration_seconds` to match new kf spacing (cascade logic reused from `_handle_update_transition_trim`)

3. **Undo integration**:
   - Wrap the whole batch in `undo_begin(project_dir, f"Move {len(transitionIds)} tr(s) by {timeDeltaSeconds:.2f}s")`
   - One undo entry per batch, not per tr

4. **Response payload** (for this task, overlap/create arrays are empty):
   ```json
   {
     "success": true,
     "movedTransitionIds": [...],
     "createdTrackIds": [],
     "consumedTransitionIds": [],
     "splitTransitionIds": []
   }
   ```

5. **Frontend client helper** in `scenecraft-client.ts`:
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

6. **Tests** (pytest + `CliRunner` + fixture project):
   - single tr, timeDelta +3s → tr's from/to timestamps both shifted by +3s
   - single tr at timeline start, timeDelta -5s → 400 (would push new_from < 0)
   - single tr with shared boundary kf (neighbor uses same kf) → new kf created, tr repointed
   - single tr with unshared kfs → kf timestamps updated in place
   - batch of 3 trs → all shifted, undo reverts all in one entry

---

## Verification

- [ ] Endpoint registered and accepts `POST /move-transitions`
- [ ] Request validation rejects `trackDelta != 0` and `mode == "copy"` for this task
- [ ] Same-track time shift works for single clip (shared and unshared kfs)
- [ ] Same-track time shift works for batch of 3+ clips
- [ ] `new_from_time < 0` after shift returns 400
- [ ] Undo reverts the entire batch in one operation
- [ ] Response payload shape matches the design spec
- [ ] Client helper `postMoveTransitions` compiles and sends the expected body shape
- [ ] All tests pass

---

**Next Task**: [Task 94: Cross-track + kf ownership + auto-create tracks](task-94-backend-cross-track-and-auto-tracks.md)  
