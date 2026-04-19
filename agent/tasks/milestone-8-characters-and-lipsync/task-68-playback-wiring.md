# Task 68: Playback Wiring for Active Lipsync Variant

**Objective**: Make preview playback and the final render pipeline prefer the active lipsync output over the raw Veo clip when `active_lipsync_id` is set
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft (frontend) + scenecraft-engine (backend render)
**Estimated Hours**: 4
**Status**: Not Started

---

## Context

Generating lipsyncs is useless if the app still plays the original Veo clip. This task wires the active lipsync into both the live preview (Timeline playback + PreviewPanel hover) and the final render pipeline (google_pipeline.py). Key invariant: the raw Veo clip remains the canonical source; lipsync is a presentation-layer substitution.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — File Layout + API Endpoints sections

## Steps

1. **Frontend: preview playback**
   - In `Timeline.tsx`, when computing the active transition's video URL, check for `active_lipsync_id`:
     - If set, resolve to `assets/lipsync_outputs/{tr_id}/{lipsync_id}.mp4`
     - Else, use the existing `selected_transitions/{tr_id}_slot_0.mp4`
   - Update the frame preload, frame cache keys, and the transition-audio `<audio>` element to use the resolved path
   - When `active_lipsync_id` changes, invalidate the frame cache entry for that transition and preload the new URL

2. **Frontend: candidate hover preview**
   - Already handled in task-65 (candidates list plays each variant in the preview panel on hover)
   - No changes needed here unless the existing hover flow still points at the raw clip — verify and fix if so

3. **Backend: final render pipeline**
   - In `google_pipeline.py` Phase 3 (segment collection), when reading a transition's selected video:
     - Check `transition['active_lipsync_id']`
     - If set, use `assets/lipsync_outputs/{tr_id}/{lipsync_id}.mp4` as the segment source
     - Else, use the existing `selected_transitions/{tr_id}_slot_0.mp4`
   - Remove or conditionalize the `-an` flag (strip audio) — when the source is a lipsync, audio MUST be preserved
   - Update the Phase 4.5 audio mux step to NOT overwrite the lipsync audio track with the original video audio

4. **Edge cases**:
   - Active lipsync is stale (source video hash mismatch) — render still uses it (user's call), but log a warning
   - Active lipsync's output file is missing on disk — fall back to raw Veo clip and log an error

5. Integration tests:
   - Preview playback uses lipsync audio when active
   - Final render incorporates lipsync segment for transitions with active lipsyncs
   - Mixed render (some transitions with lipsync, some without) works correctly

## Verification

- [ ] Setting a lipsync as active causes the preview panel to play its video+audio instead of the raw Veo clip
- [ ] Final render output contains lipsync audio for transitions with active lipsyncs
- [ ] Transitions without active lipsync render as before (original behavior preserved)
- [ ] Stale-active lipsyncs still work but log a warning
- [ ] Missing active lipsync file falls back gracefully
- [ ] Tests pass

---

**Dependencies**: Task 58 (active_lipsync_id column), Task 65 (frontend lipsync tab)
