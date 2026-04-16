# Milestone 7: Clip Trim, Rolling Edit, Time Remap, and Snap

**Goal**: Convert transitions from "connections that time-remap" to clips with trim in/out, add three-mode drag interactions (trim/rolling/time-remap) with hover-zone disambiguation, and implement timeline snap  
**Duration**: 3-4 weeks  
**Dependencies**: None (touches transitions hot path — Phase 1 flag-gated)  
**Status**: Not Started  

---

## Overview

Transitions currently conflate timeline span with video length via `duration_seconds`. This milestone splits those concepts (`source_video_duration`, `trim_in`, `trim_out`), introduces NLE-standard drag modes via three per-boundary hover zones (`<]` / `<|>` / `[>`), and adds snap-to-boundary with an `s` toggle and magnet toolbar button.

Phases:
- **P1** — DB schema + backend trim support (flag-gated, no UI changes)
- **P2** — Trim drag UI (right edge, no modifiers), empty tr insertion
- **P3** — Left edge drag, modifier modes (rolling/ripple/remap), snap toggle infrastructure + targets + feedback

---

## Deliverables

1. **Schema migration** — 3 new columns on `transitions` (`trim_in`, `trim_out`, `source_video_duration`), undo triggers updated, backfill script
2. **Backend trim support** — render seek math uses trim_in/out, DB-based truthiness checks (drop filesystem stat), variant selection probes duration, generation skips empty trs, split/duplicate/bin carry trim values
3. **Trim drag UI** — right-edge handle with hover zone detection, cursor feedback, collision rules (consume/shrink empty, split/soft-delete content), per-gesture reversibility
4. **Full drag modes** — left-edge handles (mirror of right), shift-drag (ripple), cmd-drag (time remap), rolling edit on `<|>` zone
5. **Snap system** — toggle store (s key + toolbar button + localStorage persistence), target computation, 8px hit-testing, blue-line + sticky-cursor feedback

---

## Success Criteria

- [ ] Existing transitions migrate to `trim_out = source_video_duration`, render behavior unchanged
- [ ] New columns present on `transitions` table with correct undo trigger coverage
- [ ] Filesystem `stat()` at `api_server.py:1945` removed; `selected IS NOT NULL` used instead
- [ ] Render path seeks video at `trim_in + (progress * clip_duration)`
- [ ] Empty transitions render as black frame
- [ ] Drag handles appear on tr boundaries with hover-zone cursors (`<]` / `<|>` / `[>`)
- [ ] Plain drag on `<]`/`[>` trims single side and inserts empty kf+tr if space is created
- [ ] Plain drag on `<|>` performs rolling edit (both trims adjust, no cascade)
- [ ] Shift+drag ripples all downstream kfs
- [ ] Cmd+drag moves only the dragged boundary kf (no kf cascade)
- [ ] Collision with downstream empty: partial→shrink, full→consume
- [ ] Collision with downstream content: partial→split (advance trim_in), full→soft-delete
- [ ] All drag changes reversible within a gesture (drag-back undoes insertions/deletions)
- [ ] Snap toggle works via `s` key (when not focused on text input) and magnet toolbar button
- [ ] Snap state persists to `localStorage['scenecraft-snap-enabled']`, default ON
- [ ] Snap targets: keyframes, tr boundaries, 0:00, playhead (no beats/sections/ruler)
- [ ] Snap threshold: 8px pixel-based, visual feedback = blue line + sticky cursor
- [ ] No soft clamps on `time_remap_factor` (only hard trim_in < trim_out ≤ source_duration)
- [ ] `duration_seconds` deprecated (column kept, no code reads it)

---

## Tasks

1. [Task 44: Schema migration + undo triggers](../tasks/milestone-7-clip-trim-and-snap/task-44-schema-migration.md) — Add columns, update triggers, write backfill script
2. [Task 45: Backend trim support](../tasks/milestone-7-clip-trim-and-snap/task-45-backend-trim-support.md) — Render seek math, DB truthiness, variant probe, generation skip empty
3. [Task 46: Frontend trim plumbing](../tasks/milestone-7-clip-trim-and-snap/task-46-frontend-trim-plumbing.md) — Add trimIn/trimOut/sourceVideoDuration to types and client, no UI changes
4. [Task 47: Bin/duplicate/split trim propagation](../tasks/milestone-7-clip-trim-and-snap/task-47-bin-duplicate-split.md) — Preserve trim values in bin copy, split, and duplicate flows
5. [Task 48: Trim drag UI — right edge only](../tasks/milestone-7-clip-trim-and-snap/task-48-trim-drag-right.md) — Drag handle, cursor, collision rules, per-gesture reversibility, empty tr render
6. [Task 49: Left-edge drag + modifier modes](../tasks/milestone-7-clip-trim-and-snap/task-49-left-edge-and-modifiers.md) — Hover zones, rolling/ripple/remap modifiers, keyframe drag
7. [Task 50: Snap toggle infrastructure](../tasks/milestone-7-clip-trim-and-snap/task-50-snap-toggle.md) — Snap state store, `s` key, toolbar button, localStorage persistence
8. [Task 51: Snap target + feedback](../tasks/milestone-7-clip-trim-and-snap/task-51-snap-targets.md) — Target computation, 8px hit-testing, blue-line indicator, sticky cursor

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| DB migration breaks existing projects | High | Low | Phase 1 flag-gated; backfill idempotent; `duration_seconds` kept as safety net |
| Drag math bugs cause video desync | Medium | Medium | Unit tests for seek math; manual verification of time-remap preservation post-migration |
| Undo triggers miss new columns | High | Low | Explicit enumeration in triggers; test undo/redo across trim operations |
| Hover-zone detection feels finicky | Medium | Medium | 12px total boundary zone (4px per sub-region); clear cursor feedback |
| Cmd+drag conflicts with multi-select | Low | Low | Scope cmd-drag to boundary handles only; confirmed no existing conflict |
| Snap performance drops at 1000+ targets | Low | Low | Precompute sorted array at drag-start; O(log n) binary search per frame |

---

**Next Milestone**: TBD  
**Blockers**: None  
**Notes**: Design doc at `agent/design/local.clip-trim-and-snap.md`. Clarification at `agent/clarifications/clarification-4-clip-trim-and-snap.md`.
