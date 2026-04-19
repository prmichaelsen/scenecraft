# Task 57: Characters Schema

**Objective**: Create the `characters` SQLite table with server-generated UUID IDs and case-insensitive unique names
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 3
**Status**: Not Started

---

## Context

Characters are the unit of identity in this feature — owning a name, an ElevenLabs voice_id, and a list of reference images (content-addressed hashes). They replace the loose `transitions.ingredients` field (removed in task-62). This task only covers the schema migration and ID generator; CRUD endpoints come in task-59.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — Data Model section

## Steps

1. Add a schema migration to `db.py` that creates the `characters` table:
   ```sql
   CREATE TABLE characters (
     id TEXT PRIMARY KEY,                          -- char_{hex8}
     name TEXT NOT NULL,
     voice_id TEXT NOT NULL,
     ref_image_hashes TEXT NOT NULL DEFAULT '[]', -- JSON array of SHA-256 hashes
     created_at TEXT NOT NULL,
     last_modified_by TEXT,
     deleted_at TEXT
   );
   CREATE UNIQUE INDEX idx_characters_name_unique ON characters(LOWER(name)) WHERE deleted_at IS NULL;
   CREATE INDEX idx_characters_active ON characters(deleted_at) WHERE deleted_at IS NULL;
   ```

2. Implement `_new_character_id()` helper: `return f"char_{uuid4().hex[:8]}"` — collision-check against existing rows; retry on collision.

3. Add basic DB-layer helpers in `db.py`:
   - `create_character(project_dir, name, voice_id, user) -> dict`
   - `list_characters(project_dir) -> list[dict]` (non-deleted only)
   - `get_character(project_dir, char_id) -> dict | None`
   - `update_character(project_dir, char_id, fields, user)`
   - `soft_delete_character(project_dir, char_id, user)`

4. Add `_ensure_schema` migration logic to create the table idempotently on existing projects (via `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS`).

5. Write unit tests (`tests/test_characters_schema.py`) covering:
   - Create + retrieve round-trip
   - Case-insensitive unique constraint rejects "jane" and "Jane"
   - Soft-delete hides from `list_characters` but allows re-creating a character with the same name
   - ID collision retry logic

## Verification

- [ ] Running the server on a fresh project creates the `characters` table
- [ ] Inserting a character returns a `char_{hex8}` ID
- [ ] Attempting to insert "Jane" twice returns a constraint error
- [ ] After soft-deleting "Jane", creating "jane" succeeds
- [ ] Unit tests pass

---

**Dependencies**: None
