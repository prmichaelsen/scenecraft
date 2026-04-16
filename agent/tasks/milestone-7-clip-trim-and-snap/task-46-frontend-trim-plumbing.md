# Task 46: Frontend Trim Plumbing

**Milestone**: [M7 — Clip Trim and Snap](../../milestones/milestone-7-clip-trim-and-snap.md)  
**Design**: [local.clip-trim-and-snap.md](../../design/local.clip-trim-and-snap.md)  
**Estimated Hours**: 2-3  
**Status**: Not Started  
**Dependencies**: Task 45 (Backend Trim Support)  

---

## Objective

Add the new trim fields (`trimIn`, `trimOut`, `sourceVideoDuration`) to the frontend Transition type, client API types, and editor data loader. No UI changes — all existing rendering continues to work with defaults (full clip, no trim).

---

## Steps

1. **Update `Transition` type** in `src/routes/project/$name/editor.tsx`:
   - Add `trimIn?: number` (defaults to 0)
   - Add `trimOut?: number | null` (null = use full source)
   - Add `sourceVideoDuration?: number | null`

2. **Update `src/lib/scenecraft-client.ts`** type definitions and response parsers:
   - `ActiveTransition` type: add the three fields
   - `TransitionBinEntry` type: add the three fields
   - `fetchTimelineData` response mapping: include trim fields
   - `postUpdateTransitionStyle`: accept `trimIn` / `trimOut` in the payload
   - New endpoint helper: `postUpdateTransitionTrim(project, tr_id, { trimIn, trimOut })`

3. **Update `TransitionTrack.tsx:101`** speed ratio calculation to use new model:
   - Keep existing `durationSeconds` until backend stops sending it
   - Compute: `clipDuration = (trimOut ?? sourceVideoDuration ?? durationSeconds) - (trimIn ?? 0)`
   - `timelineDuration = to_kf.timestamp - from_kf.timestamp`
   - `timeRemapFactor = clipDuration / timelineDuration`

4. **Update display labels** (`TransitionTrack.tsx:205`):
   - Change `"{timelineDur} on timeline, {durationSeconds} video"` → `"{timelineDur} on timeline, {clipDuration}/{sourceVideoDuration} clip/source"`
   - Shows the trimmed portion vs total source length

5. **No visual changes yet** — existing drag/resize code keeps working. This task is purely plumbing.

6. **Type-check and smoke test**:
   - Run `npx tsc --noEmit` — no errors
   - Load editor for existing project — timeline renders unchanged
   - Verify WebSocket updates don't crash with new fields

---

## Verification

- [ ] Type definitions include the three new fields
- [ ] `fetchTimelineData` exposes the fields to the frontend
- [ ] `TransitionTrack.tsx` speed ratio computed from new model with fallback to legacy
- [ ] Existing projects load without errors
- [ ] Display label updated to show trim/source
- [ ] No TypeScript errors

---

**Next Task**: [Task 47: Bin/duplicate/split trim propagation](task-47-bin-duplicate-split.md)  
