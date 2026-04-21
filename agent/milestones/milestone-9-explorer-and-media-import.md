# Milestone 9: Explorer Panel and Media Import

**Goal**: Ship a two-panel Explorer column (Project + Import) backed by ACL-gated server-side filesystem browsing, content-hashed dedup, and `watchdog`-live ingest for video, image, and audio media.
**Duration**: 5-6 weeks
**Design**: [local.explorer-and-media-import](../design/local.explorer-and-media-import.md)
**Dependencies**: M7 panel-library work (`GroupNode`, `SplitNode` primitives already in place)
**Status**: Not Started

---

## Overview

Scenecraft has pool segments and a watched-folders API but no UI to see what's been ingested or where it came from, and no explicit flow to register new folders as rolling media sources. This milestone delivers that UI (two peer `GroupNode`s in a new left-edge Explorer column) and the backend underneath it: a flat `pool/` directory addressed via SQL, content-hashed dedup with a `source_locations` many-to-one table, a `watchdog`-backed live ingest path, and a server-level ACL gate on every filesystem surface.

The design is shaped by a **remote server-browser** assumption: the scenecraft server runs on one machine, the browser on another. Native OS reveal is out; native file pickers stay for the upload path; an in-app server FS browser (ACL-gated) is introduced for the folder-watch path.

Phases:
- **P1 — Foundation** (Tasks 70–72): schema, ACL, classifier + hasher helpers
- **P2 — Server services** (Tasks 73–75): browse endpoint, upload pipeline, watchdog ingest
- **P3 — Frontend Explorer** (Tasks 76–79): panel registration, Project panel, Import panel, FS browser modal
- **P4 — UX integrations** (Tasks 80–81): Focus Mode, missing-source recovery

---

## Deliverables

1. **Schema** — `source_hash` / `source_size` / `media_kind` on `pool_segments`, new `source_locations` and `acl_rules` tables, drop `original_filepath` (greenfield).
2. **ACL system** — server-level path-prefix grants, default-deny, implicit project-dir allow, longest-match + deny-on-tie evaluation, CLI (`grant`/`revoke`/`list`), first-user admin bootstrap.
3. **Server services** — `/api/browse` (ACL-gated), upload pipeline (streaming hash, flat pool dir, dedup), `watchdog`-backed watchers (2s debounce, rename detection, network-mount polling fallback).
4. **Explorer frontend** — `project` and `import` panels; new default layout with a collapsed Explorer column (~275 px expanded); Project panel with custom contextmenu; Import panel with Link Media button + per-row actions; in-app FS browser modal backing "Add folder to watch".
5. **Focus Mode** — `primary?: boolean` on `GroupNode`, `Shift+F` toggle, ellipsis-menu entry for marking primary; ephemeral snapshot/restore.
6. **Missing-source recovery** — detection on watchdog delete events; Relocate flow via the in-app browser with hash re-verification.

---

## Success Criteria

- [ ] Schema migrations apply cleanly; `source_locations` supports multi-source dedup; greenfield — no backfill required.
- [ ] ACL evaluator correctly implements longest-match-wins with deny > allow on ties; implicit project-dir allow works without a rule.
- [ ] `GET /api/browse` rejects denied paths with 403; symlink traversal denied; unauthenticated → 401.
- [ ] Same bytes imported from two sources converges to one `pool_segments` row + two `source_locations` rows.
- [ ] Rename in a watched folder updates `source_locations.source_ref` — does NOT create a duplicate pool row.
- [ ] Upload path hashes during the request (streaming); zero wall-clock overhead beyond the upload.
- [ ] Upload accepts video, image, and audio (single `accept="video/*,image/*,audio/*"` picker).
- [ ] Flat `pool/<uuid>.<ext>` layout; `media_kind` column drives categorization.
- [ ] Explorer column collapsed by default; expands to ~275 px; Project and Import are independent `GroupNode`s.
- [ ] Custom contextmenu replaces browser native on Explorer rows.
- [ ] "Link Media" menu offers Add File(s) (native picker) and Add Folder to Watch (in-app browser).
- [ ] `Shift+F` toggles Focus Mode (non-primary groups collapsed); second press restores.
- [ ] Missing-source detection + Relocate flow works end-to-end.

---

## Tasks

1. [Task 70: Schema foundation](../tasks/milestone-9-explorer-and-media-import/task-70-schema-foundation.md) — Schema additions, `source_locations` table, drop `original_filepath`
2. [Task 71: ACL system](../tasks/milestone-9-explorer-and-media-import/task-71-acl-system.md) — `acl_rules` table, evaluator, CLI, admin bootstrap
3. [Task 72: Media classifier + streaming hasher](../tasks/milestone-9-explorer-and-media-import/task-72-media-classifier-and-hasher.md) — Shared helpers
4. [Task 73: /api/browse endpoint](../tasks/milestone-9-explorer-and-media-import/task-73-browse-endpoint.md) — ACL-gated directory listing
5. [Task 74: Upload pipeline](../tasks/milestone-9-explorer-and-media-import/task-74-upload-pipeline.md) — Streaming hash, dedup, `source_locations`
6. [Task 75: Watchdog ingest](../tasks/milestone-9-explorer-and-media-import/task-75-watchdog-ingest.md) — Live watcher, debounce, rename, polling fallback
7. [Task 76: Panel registration + default layout](../tasks/milestone-9-explorer-and-media-import/task-76-panel-registration-and-layout.md) — Register `project`/`import`, Explorer column
8. [Task 77: Project panel](../tasks/milestone-9-explorer-and-media-import/task-77-project-panel.md) — Tree view + custom contextmenu + row actions
9. [Task 78: Import panel](../tasks/milestone-9-explorer-and-media-import/task-78-import-panel.md) — Flat roots + icons + Link Media
10. [Task 79: In-app FS browser modal](../tasks/milestone-9-explorer-and-media-import/task-79-fs-browser-modal.md) — ACL-gated server path picker
11. [Task 80: Focus Mode](../tasks/milestone-9-explorer-and-media-import/task-80-focus-mode.md) — `primary?` flag + `Shift+F` + ellipsis toggle
12. [Task 81: Missing-source recovery](../tasks/milestone-9-explorer-and-media-import/task-81-missing-source-recovery.md) — Detection + Relocate UI

---

## Dependency Graph

```
70 (schema) ──┬── 71 (ACL) ──┬── 73 (browse endpoint) ──┐
              │              │                          │
              └── 72 (helpers) ──┬── 74 (upload) ──────┐ │
                                 │                     │ │
                                 └── 75 (watchdog) ────┤ │
                                                       │ │
76 (panels+layout) ──┬── 77 (Project panel) ───────────┤ │
                     ├── 78 (Import panel) ────────────┤ │
                     └── 79 (FS browser modal) ────────┼─┘
                                                       │
80 (Focus Mode) ── (after 76) ─────────────────────────┤
                                                       │
81 (missing-source) ── (after 74, 75, 79) ─────────────┘
```

Tasks 70/71/72 are foundation; 73/74/75 can parallelize once 72 is done; frontend 77/78/79 can parallelize after 76.

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| ACL evaluator bugs allow filesystem traversal | High | Low | Targeted tests for `..`, symlinks, longest-match precedence; real resolve before eval |
| Watchdog doesn't fire on network mounts | Medium | Medium | Detect SMB/NFS via `statvfs`; fall back to 5s polling |
| Large initial folder scan blocks the request | Medium | Low | Initial scan runs in background thread; per-file streaming hash; WS progress events |
| Streaming hash adds upload latency | Low | Low | Benchmark confirms ~40× headroom; streaming is free on modern SSDs |
| Custom contextmenu loses browser defaults users expect | Low | Medium | Standard tradeoff (Figma/Linear precedent); Inspect still works outside the Explorer |
| Layout migration corrupts saved workspace views | Medium | Low | Insert Explorer column only if absent; `primary` flag applied defensively |
| Content-hash dedup rejects legitimately-duplicate uploads | Low | Low | Dedup returns existing row cleanly; user sees the item in their pool either way |

---

**Status**: Not Started
**Recommendation**: Implement in phase order. Foundation (70–72) must land before the server services (73–75); server services must land before the frontend panels can be wired to real data. Focus Mode (80) and missing-source recovery (81) are strictly additive and can slip to the end.
**Related Documents**:
- [Clarification 5: Explorer Panel and Media Import](../clarifications/clarification-5-explorer-panel-and-media-import.md)
- [local.explorer-and-media-import](../design/local.explorer-and-media-import.md)
