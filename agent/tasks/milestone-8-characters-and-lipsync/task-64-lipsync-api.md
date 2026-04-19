# Task 64: Lipsync API Endpoints + Job Manager Integration

**Objective**: Expose the two-stage lip-sync pipeline (diarize + generate) as REST endpoints with WebSocket-backed job progress
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 5
**Status**: Not Started

---

## Context

The render module from task-63 is called from two endpoints: `/lipsync/diarize` runs synchronously (cheap, fast — WhisperX returns in seconds) and returns speaker + segments + proposed map; `/lipsync/generate` is long-running and goes through the existing `job_manager` pattern used by transition candidate generation. Also exposes list + set-active endpoints.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — API Endpoints section

## Steps

1. Add `POST /api/projects/:name/lipsync/diarize`:
   - Body: `{transitionId}`
   - Synchronous — calls `diarize_transition(project_dir, tr_id)` and returns result
   - Errors: 404 if transition missing, 400 if no selected video, 500 on WhisperX failure

2. Add `POST /api/projects/:name/lipsync/generate`:
   - Body: `{transitionId, speakerMap, segments}`
   - Validates that every speaker in `segments` is present in `speakerMap`
   - Validates that every `char_id` in `speakerMap` exists and is non-deleted
   - Creates a `job_manager` job with total = `len(segments) + 2` (S2S per segment + stitch + sync.so)
   - Spawns thread: calls `lipsync_transition(project_dir, tr_id, speaker_map, segments, on_status)` where `on_status` calls `job_manager.update_progress`
   - Returns `{jobId, lipsyncId}` immediately
   - On success: broadcasts `completed` with `{lipsyncId, outputPath}`
   - On failure: `job_manager.fail_job` with error message

3. Add `GET /api/projects/:name/transitions/:id/lipsyncs`:
   - Returns all non-deleted lipsyncs for a transition
   - Each entry includes computed `isStale: true|false` (compare `source_video_hash` to current Veo clip's hash)
   - Includes `outputUrl` (via `scenecraftFileUrl`), `createdAt`, `speakerMap` (expanded to character names), `segments`

4. Add `POST /api/projects/:name/transitions/:id/active-lipsync`:
   - Body: `{lipsyncId}` or `{lipsyncId: null}`
   - Calls `set_active_lipsync`
   - Returns updated transition

5. Frontend client functions in `src/lib/scenecraft-client.ts`:
   - `postLipsyncDiarize(project, transitionId)`
   - `postLipsyncGenerate(project, transitionId, speakerMap, segments)`
   - `fetchTransitionLipsyncs(project, transitionId)`
   - `postSetActiveLipsync(project, transitionId, lipsyncId | null)`

6. Integration tests:
   - Diarize endpoint with mocked render module
   - Generate endpoint returns jobId; background thread completes; GET /lipsyncs shows the new row
   - Set-active updates the transition
   - isStale flag works when source video hash changes

## Verification

- [ ] Diarize endpoint returns segments + proposed map within 30s on a real clip
- [ ] Generate endpoint returns jobId immediately; WebSocket delivers progress events
- [ ] List endpoint returns all lipsyncs with correct isStale flags
- [ ] Set-active updates transition.active_lipsync_id
- [ ] Invalid speaker map (unknown char_id) returns 400
- [ ] Integration tests pass

---

**Dependencies**: Task 63 (render module)
