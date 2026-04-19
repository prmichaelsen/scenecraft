# Task 61: Frontend Characters Panel

**Objective**: Build a top-level dockview panel for character management: list view, detail view, voice picker with preview, ref image grid
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft (frontend)
**Estimated Hours**: 8
**Status**: Not Started

---

## Context

Characters deserve their own first-class UI — not buried in project settings. This panel is where users define who's in their film, set their visual identity (ref images) and vocal identity (voice_id), and preview voice samples. Registered as a dockview panel similar to Extensions or Checkpoints.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — Frontend section

## Steps

1. Create `src/components/editor/CharactersPanel.tsx`:
   - List view (default): rows of characters with name, voice name, ref image count, edit + delete buttons
   - Detail view (when a character is selected): editable name, voice picker, ref image grid with drag-drop upload, add/remove ref images
   - "Add Character" button at top opens creation flow (modal or inline form)

2. Voice picker component:
   - Dropdown populated from `fetchElevenLabsVoices`
   - Each entry shows name + voice description + play button
   - Play button loads `elevenLabsVoicePreviewUrl` into a hidden `<audio>` element, plays
   - Only one preview plays at a time
   - Selected voice_id shown in the trigger

3. Ref image grid:
   - Drop zone accepts image drop, calls `uploadCharacterRefImage`
   - Thumbnails show uploaded images (use `scenecraftFileUrl` with `character_ref_images/{hash}.png`)
   - Click thumbnail to remove (with confirm)
   - Shows inline upload progress

4. Register the panel in `EditorLayout.tsx` and `EditorPanelLayout.tsx`:
   - Add `characters` to the panel registry
   - Expose in the dockview "add panel" menu
   - Default layout: optional — user opts in via Add Panel menu

5. Wire through the usual `EditorDataContext` if characters should be loadable on page load (or lazy-load on first panel open).

6. E2E-style test with mocked API covering create/rename/delete flow + ref image upload dedup.

## Verification

- [ ] Panel opens from dockview Add menu
- [ ] Create character with name + voice_id succeeds
- [ ] Case-insensitive duplicate name shows inline error
- [ ] Voice preview plays on button click, another click plays a different voice (first stops)
- [ ] Dragging an image onto the ref image grid uploads + thumbnail appears
- [ ] Deleting a ref image removes thumbnail; same image re-uploaded dedupes (same hash)
- [ ] Deleting a character removes it from the list

---

**Dependencies**: Task 59 (CRUD API), Task 60 (voice proxy)
