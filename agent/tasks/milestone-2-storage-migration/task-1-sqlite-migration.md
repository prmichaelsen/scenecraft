# Task 1: SQLite Storage Migration

**Milestone**: M2 - Storage Migration
**Design Reference**: N/A (infrastructure)
**Estimated Time**: 12-16 hours
**Dependencies**: None
**Status**: In Progress

---

## Objective

Replace YAML file read/write in the beatlab server with SQLite for instant operations on large projects. Maintain YAML import/export for portability.

---

## Progress

### Done
- [x] `db.py` — SQLite storage layer with all CRUD operations
- [x] 22 integration tests passing (meta, keyframes, transitions, effects, suppressions, YAML roundtrip)
- [x] `import_from_yaml` / `export_to_yaml` functions
- [x] WAL mode, indexes, per-thread connection pool

### TODO
- [ ] Auto-import on first access (if project.db missing but YAML exists)
- [ ] Migrate `_handle_get_keyframes` to use db.py
- [ ] Migrate `_handle_update_prompt` to use db.py
- [ ] Migrate `_handle_update_transition_action` to use db.py
- [ ] Migrate `_handle_update_transition_remap` to use db.py
- [ ] Migrate `_handle_add_keyframe` to use db.py
- [ ] Migrate `_handle_delete_keyframe` to use db.py
- [ ] Migrate `_handle_restore_keyframe` to use db.py
- [ ] Migrate `_handle_delete_transition` to use db.py
- [ ] Migrate `_handle_restore_transition` to use db.py
- [ ] Migrate `_handle_set_base_image` to use db.py
- [ ] Migrate `_handle_assign_pool_video` to use db.py
- [ ] Migrate `_handle_get_bin` to use db.py
- [ ] Migrate `_handle_update_meta` to use db.py
- [ ] Migrate effects handlers to use db.py
- [ ] Remove per-project YAML write lock (SQLite handles concurrency)
- [ ] CLI: `beatlab db import` / `beatlab db export` commands
- [ ] Frontend SQLite cache (sql.js replacing IndexedDB)
