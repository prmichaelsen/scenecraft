# Task 47: Bin/Duplicate/Split Trim Propagation

**Milestone**: [M7 — Clip Trim and Snap](../../milestones/milestone-7-clip-trim-and-snap.md)  
**Design**: [local.clip-trim-and-snap.md](../../design/local.clip-trim-and-snap.md)  
**Estimated Hours**: 3-4  
**Status**: Not Started  
**Dependencies**: Task 46 (Frontend Trim Plumbing)  

---

## Objective

Ensure trim values propagate correctly through the bin, duplicate, and split operations — both backend and frontend paths.

---

## Steps

1. **Bin copy path** (backend + frontend):
   - `BinPanel.tsx` drag-to-bin handler: include trim fields in the bin entry payload
   - Backend `_handle_add_to_bench`: store trim values on the bench row
   - Bin render: show trim info when hovering a bin entry (small label like "3.2s trimmed from 8.0s source")

2. **Paste from bin**:
   - Backend `_handle_paste_from_bench`: restore `trim_in`, `trim_out`, `source_video_duration` on the new transition
   - Frontend: refresh timeline after paste to show the restored trim

3. **Duplicate transition** (`api_server.py:3812-3820`):
   - When duplicating, copy `trim_in`, `trim_out`, `source_video_duration` to the new row
   - The duplicate's timeline position is determined by where it's dropped; the trim dictates how much of the source plays in that span

4. **Split transition** (`api_server.py:2491`, `3989`):
   - Compute the split point in source-video time:
     ```
     split_progress = (split_timeline_time - from_kf.timestamp) / timeline_duration
     split_source_time = trim_in + split_progress * (trim_out - trim_in)
     ```
   - Left half: `trim_in` unchanged, `trim_out = split_source_time`
   - Right half: `trim_in = split_source_time`, `trim_out` unchanged
   - Both inherit `source_video_duration`
   - Both retain the same `selected` variant (they point at the same source file)

5. **Copy video to adjacent transition** (`api_server.py` copy flow):
   - When copying a video to next/prev transition, copy the trim values too (the target will likely have different timeline_duration, so time_remap_factor will differ)

6. **Tests**:
   - Split a transition at its midpoint → verify `left.trim_out == right.trim_in`, sum equals original clip_duration
   - Duplicate a trimmed transition → verify trim preserved
   - Bin→paste cycle preserves trim and source_video_duration
   - Copy-to-next preserves trim

---

## Verification

- [ ] Bin entries include trim fields (inspect via DB query)
- [ ] Bin paste produces a transition with the expected trim
- [ ] Split produces two transitions whose trim values sum to the original
- [ ] Duplicate keeps trim intact
- [ ] Copy-to-adjacent preserves trim

---

**Next Task**: [Task 48: Trim drag UI — right edge only](task-48-trim-drag-right.md)  
