# Task 62: Action-Text Character Resolver + Veo Ingredient Wiring

**Objective**: At transition-generation time, scan the action prompt for character names and auto-include their ref images as Veo ingredients. Remove the manual `transitions.ingredients` field.
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 4
**Status**: Not Started

---

## Context

Characters own their reference images. Transitions no longer store loose ingredient paths; instead, the user writes natural prose in the action prompt ("Jane opens the door") and the backend resolves character names to their ref images. This is greenfield — the existing `ingredients` column is removed, not preserved.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — Character Name Resolution section

## Steps

1. Add `resolve_characters(project_dir, action_text) -> list[dict]` to `db.py` (or a new `characters.py` module):
   - Load all non-deleted characters via `list_characters`
   - Sort by name length descending (so "Janet" matches before "Jan")
   - For each character, run case-insensitive whole-word regex: `\b{re.escape(name)}\b`
   - Return matched characters in first-appearance order within the action text
   - Deduplicate (same character matched twice in the same action = one entry)

2. Update `_handle_generate_transition_candidates` in `api_server.py`:
   - Remove `ingredients` lookups from the transition row
   - Call `resolve_characters(project_dir, tr["action"])`
   - For each matched character, resolve `ref_image_hashes` → asset paths
   - Merge all ref images (dedupe by hash), pass as `ingredients` to `GoogleVideoClient.generate_video_transition` / `generate_video_from_image`
   - Log which characters were resolved for traceability

3. Remove the `ingredients` column from the `transitions` table schema. Update any code that reads/writes it — especially the transition serializer and any import/export flows.

4. Add endpoint helper `GET /api/projects/:name/transitions/:id/resolved-characters` that returns the list of matched characters for the current action text. The frontend uses this to surface which characters the transition is "about."

5. Write tests:
   - Action "Jane and Marcus talk" → resolves [Jane, Marcus] in order
   - Action "janet" does NOT match character "Jan" (whole-word)
   - Action mentioning Jane twice returns Jane once
   - Action with no character names returns empty list; downstream generation still works but without ref images

## Verification

- [ ] `resolve_characters` returns correct ordered list for sample action texts
- [ ] Veo generation includes the correct ref images when characters are named
- [ ] Veo generation without character names still works (no ingredients)
- [ ] `/resolved-characters` endpoint returns accurate data for the frontend
- [ ] `transitions.ingredients` column removed; no code references it
- [ ] Unit + integration tests pass

---

**Dependencies**: Task 57 (characters schema), Task 59 (CRUD — for test fixtures)
