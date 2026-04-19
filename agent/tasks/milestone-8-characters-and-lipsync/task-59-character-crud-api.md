# Task 59: Character CRUD API + Content-Addressed Ref Image Upload

**Objective**: Expose REST endpoints for character CRUD and ref image management. Ref images stored content-addressed under `assets/character_ref_images/{sha256}.png`.
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 5
**Status**: Not Started

---

## Context

Characters are managed entirely through REST endpoints — the frontend Characters panel (task-61) drives creation, updates, and ref image uploads. Per VCS design, ref images are shared across all branches within a project, stored once by content hash so duplicate uploads dedupe automatically.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — API Endpoints section

## Steps

1. Add routes to `api_server.py`:
   - `GET /api/projects/:name/characters` — returns list of non-deleted characters, including resolved ref image URLs
   - `POST /api/projects/:name/characters` — body `{name, voiceId}`, returns created character with new `char_{hex8}` ID; 409 on name collision
   - `PATCH /api/projects/:name/characters/:id` — body accepts `{name?, voiceId?}`; 409 on name collision
   - `POST /api/projects/:name/characters/:id/ref-images` — multipart upload `file`; returns `{hash, url}` after hashing + storing + appending to `ref_image_hashes`
   - `DELETE /api/projects/:name/characters/:id/ref-images` — body `{hash}`; removes hash from `ref_image_hashes` (does NOT delete asset file — shared, manual GC)
   - `DELETE /api/projects/:name/characters/:id` — soft-delete

2. Ref image upload flow:
   - Read file bytes, compute SHA-256
   - Determine extension from Content-Type or file magic (png, jpg)
   - Write to `.scenecraft/orgs/{org}/projects/{project}/assets/character_ref_images/{sha256}.{ext}` if not already present
   - Append hash to the character's `ref_image_hashes` JSON array (dedup: don't append if already present)

3. File serving: ensure existing `/api/projects/:name/files/*` handler resolves `character_ref_images/{hash}.{ext}` from the assets dir.

4. Auth: wire through existing session middleware so `last_modified_by` is populated from the authenticated user.

5. Frontend client functions in `src/lib/scenecraft-client.ts`:
   - `fetchCharacters(project)`, `createCharacter`, `updateCharacter`, `uploadCharacterRefImage`, `removeCharacterRefImage`, `deleteCharacter`

6. Integration tests covering each endpoint + dedup behavior (upload same file twice → single asset file, two ref rows).

## Verification

- [ ] `GET /characters` returns empty array on fresh project
- [ ] `POST /characters` creates row, returns 409 on duplicate name (case-insensitive)
- [ ] `POST /characters/:id/ref-images` dedupes identical content across characters
- [ ] Uploaded image is accessible via `/api/projects/:name/files/character_ref_images/{sha256}.png`
- [ ] `DELETE /characters/:id/ref-images` removes from DB but leaves file on disk
- [ ] `last_modified_by` populated correctly
- [ ] Integration tests pass

---

**Dependencies**: Task 57 (characters schema)
