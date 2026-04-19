# Task 66: Stale Lipsync Detection + Regenerate Flow

**Objective**: Surface stale lipsync variants (source Veo clip changed since generation) in the UI with a one-click regenerate action
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft (frontend) + scenecraft-engine (backend touches already covered)
**Estimated Hours**: 3
**Status**: Not Started

---

## Context

A lipsync variant becomes stale when the user swaps the selected transition variant (different Veo candidate) or regenerates the Veo clip. The DB row still references the old `source_video_hash`, so the lipsync output no longer matches the current clip. We detect via hash mismatch (already built into task-64's list endpoint) and surface the staleness visually, offering a one-click regenerate with the same speaker mapping.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — Staleness detection section

## Steps

1. In the Lip-Sync tab candidates list (task-65), render stale variants with a yellow warning badge: "⚠ Stale — source clip changed"

2. Add "Regenerate" action to stale variants:
   - Reuses the stored `speaker_map` and re-runs diarization (since segment timings may differ in the new clip)
   - Actually — simpler: regenerate button opens the same speaker mapping UI as normal generate, pre-filled with the stored `speaker_map`. Then user confirms and hits generate.
   - Creates a new lipsync row (preserves the stale one for reference; user can delete manually)

3. Visual treatment: stale variants not available for "Make Active" — button disabled with tooltip "This variant is stale. Regenerate to use it."

4. If `active_lipsync_id` points to a stale variant, the preview panel shows a prominent banner: "⚠ Active lipsync is out of date. Regenerate or switch to original."

5. Unit tests for the stale detection logic and UI states.

## Verification

- [ ] After regenerating a transition's Veo clip, existing lipsyncs show "⚠ Stale" badges
- [ ] "Regenerate" action pre-fills the speaker map from the stale variant
- [ ] New lipsync row created after regenerate; stale one remains
- [ ] Active-variant banner shows if the active lipsync is stale
- [ ] Tests pass

---

**Dependencies**: Task 65 (lipsync tab)
