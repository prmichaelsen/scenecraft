# Task 45: Backend Trim Support

**Milestone**: [M7 — Clip Trim and Snap](../../milestones/milestone-7-clip-trim-and-snap.md)  
**Design**: [local.clip-trim-and-snap.md](../../design/local.clip-trim-and-snap.md)  
**Estimated Hours**: 4-5  
**Status**: Not Started  
**Dependencies**: Task 44 (Schema Migration)  

---

## Objective

Update the scenecraft-engine render and truthiness paths to use the new trim columns. Replace filesystem `stat()` checks with DB truthiness (`selected IS NOT NULL`). Ensure generation endpoints skip empty transitions.

---

## Steps

1. **Render seek math** (`api_server.py:3551-3567`):
   - Replace `video_time = progress * video_dur` with:
     ```python
     effective_trim_out = tr.get("trim_out") or tr.get("source_video_duration") or probe_dur
     effective_trim_in = tr.get("trim_in", 0) or 0
     video_time = effective_trim_in + (progress * (effective_trim_out - effective_trim_in))
     ```
   - Null handling: if `trim_out` is NULL, fall back to `source_video_duration`; if that's also NULL, fall back to `probe_dur` (current behavior)

2. **Drop filesystem stat for truthiness** (`api_server.py:1945`):
   - Replace `has_selected = img_path.exists()` with `has_selected = kf.get("selected") is not None`
   - For transitions: `has_selected_video = kf.get("selected") and kf["selected"] != '[]' and any non-null entries in the parsed array`
   - If `selected` is set but file is missing, log a corruption warning (don't silently fall back)

3. **Variant selection hook** — when a variant is selected (endpoint at `api_server.py` where `selected` is updated on a tr):
   - After the update, ffprobe the new selected video
   - Persist `source_video_duration = probe_dur` on the transition row
   - If the existing `trim_out` is NULL or > new `source_video_duration`, clamp it: `trim_out = min(trim_out or source, source)`
   - If `trim_in` > `source_video_duration - 0.1`, reset `trim_in = 0`
   - Return the updated values in the response so the frontend can refresh

4. **Generation endpoints**:
   - `_handle_generate_transition_candidates` (`api_server.py:4670`): if `selected == '[]'` AND the request targets this transition, reject with 400 "Empty transition; select/generate a variant first via a different flow" — OR treat it as normal generation and fill the transition
   - Confirm which behavior per downstream needs; default to allow generation (spacer → content conversion)
   - `render/narrative.py` `generate_all`: filter out transitions with `selected == '[]'` from the generation queue

5. **Bin/pool copy** (`api_server.py:2915` area):
   - When copying a tr to bin, include `trim_in`, `trim_out`, `source_video_duration` in the bin entry JSON
   - When pasting from bin, restore these values on the new tr

6. **Split/duplicate** (`api_server.py:3812`, `3989`, `2491`):
   - On split at timeline point `t`:
     - Compute the source offset corresponding to `t` using existing time_remap math
     - Left half: keep `trim_in`, set `trim_out = source_offset_at_t`
     - Right half: set `trim_in = source_offset_at_t`, keep `trim_out`
     - Both halves inherit `source_video_duration`
   - On duplicate: copy trim values as-is to the duplicate (next kf shifted by clip_duration)

7. **Deprecation**:
   - Remove all code reads of `duration_seconds` (no DELETE of the column — keep as safety net)
   - Add a deprecation comment on the column definition in `db.py`

8. **Tests** (`scenecraft-engine/tests/test_trim.py`):
   - Render a trimmed transition — video plays from `trim_in` to `trim_out`
   - Render a time-remapped trimmed transition — correct speed
   - Truthiness check returns correct state without filesystem
   - Variant switch clamps invalid trim
   - Split divides trim correctly
   - Bin copy preserves trim

---

## Verification

- [ ] Render plays only the trimmed portion of the video
- [ ] Time remap works correctly with non-zero `trim_in`
- [ ] No filesystem `stat()` calls in the timeline fetch path
- [ ] Variant switch to a shorter video clamps trim and logs a warning
- [ ] Split produces two transitions whose trim sums to the original
- [ ] Bin paste restores the original trim values
- [ ] `duration_seconds` no longer read by any code path

---

**Next Task**: [Task 46: Frontend trim plumbing](task-46-frontend-trim-plumbing.md)  
