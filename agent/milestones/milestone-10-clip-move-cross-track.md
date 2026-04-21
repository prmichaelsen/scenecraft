# Milestone 10: Clip Move — Drag and Drop Across Tracks

**Goal**: Enable body-drag of single or multiple clips for repositioning in time and moving between tracks, with overlap resolution (consume, trim, three-way split), auto-create tracks on overflow, and a Cmd/Ctrl+drag copy mode  
**Duration**: 3 weeks  
**Dependencies**: M7 tasks 44–49 (trim schema + boundary-drag infrastructure). Snap-on-drop deferred until M7 Tasks 50/51 ship  
**Status**: Not Started  

---

## Overview

Scenecraft's timeline supports clip editing via boundary zones (trim / rolling / remap) from M7, but has no gesture for moving whole clips in time or across tracks. This milestone adds the complementary body-drag interaction: mousedown on a transition bar's interior initiates a move; mouse-delta drives time delta; Y-delta drives track delta; Cmd+drag duplicates instead of moving.

The feature preserves the dragged clip's internal state exactly (trim, selected variant, effects, candidates) and mutates only its position + track assignment. Target-track overlaps are resolved by splitting or consuming existing clips, never by destroying dragged clips.

Phases:
- **P1** — Backend endpoint + move algorithm (same-track single-clip first, then cross-track, then overlap resolution, then copy mode)
- **P2** — Frontend gesture + ghost preview (same-track single-clip baseline)
- **P3** — Frontend cross-track + multi-clip + multi-track source selections
- **P4** — Frontend overlap preview + auto-create-track ghost rows + Cmd-drag visuals

---

## Deliverables

1. **Backend endpoint** — `POST /api/projects/:name/move-transitions` with delta-based body (`trackDelta`, `timeDeltaSeconds`, flat `transitionIds[]`, `mode: "move" | "copy"`, `autoCreateTracks`)
2. **Move algorithm** — interior-kf migration + boundary-kf duplication on source, auto-create tracks on overflow, source-track empty-tr bridge
3. **Overlap resolution** — soft-delete fully-inside targets, trim straddling targets with proportional trim_in/out adjustment, three-way split when drop lands entirely within one target, empty-tr kf-shift variant
4. **Copy mode** — `mode="copy"` preserves source, clones tr row + tr_candidates junction rows (no pool file duplication), refreshes selected_transitions cache
5. **Body-drag gesture** — mousedown on transition interior, 3-4 px threshold, `grab`/`grabbing` cursors, ghost preview anchored bottom-right of cursor, Escape-to-cancel
6. **Multi-clip + multi-track** — drag all selected clips under uniform `trackDelta`; `trackDelta` sourced from primary-dragged clip
7. **Overlap + new-track preview** — red tint on would-be-consumed, split lines on would-be-trimmed, dashed ghost rows for auto-created tracks, tooltip with timestamps + Δ + N-clips
8. **Copy-mode affordance** — Cmd/Ctrl captured at mousedown, `+` badge / green tint on ghost

---

## Success Criteria

- [ ] Body-drag on transition interior initiates a move after 3+ px of movement
- [ ] Single-clip same-track move shifts timestamps correctly, no other state changes
- [ ] Cross-track move changes `track_id` on the dragged tr, creates empty-tr bridge on source
- [ ] Multi-clip drag shifts all selected clips by the same `(timeDelta, trackDelta)`
- [ ] Multi-track source selections (e.g., clips on T2 + T3, drag from T3 to T2) apply uniform `trackDelta = -1` (T2→T1, T3→T2)
- [ ] `trackDelta` that overflows the track range auto-creates new tracks with safe defaults (`blendMode: "normal"`, `baseOpacity: 1.0`, `enabled: true`)
- [ ] Dragged clip's `trim_in`, `trim_out`, `selected`, effects, candidates unchanged after move
- [ ] Target-track tr fully inside drop span → soft-deleted
- [ ] Target-track tr straddles drop's `new_from` → trimmed to `[target.from → new_from_kf]` with proportional `trim_out` reduction
- [ ] Target-track tr straddles drop's `new_to` → trimmed to `[new_to_kf → target.to]` with proportional `trim_in` advance
- [ ] Drop fully inside a single target → three-way split (remainder-left + dropped + remainder-right) with variants/trims preserved on remainders
- [ ] Empty tr target → shrunk by kf move (no trim math)
- [ ] Cmd+drag copies instead of moving; source unchanged, target has tr with fresh id + cloned junction rows
- [ ] `+` badge / green tint visible on ghost during Cmd+drag
- [ ] Overlap preview shows red tint on would-be-consumed targets and split lines on would-be-trimmed targets during drag
- [ ] Auto-create-track ghost rows (dashed "New track" label) appear when drop would require new tracks
- [ ] Tooltip during drag shows new start/end timestamps, target track name, `Δ+X.YZs`, and "N clips" if multi-clip
- [ ] Escape during drag cancels cleanly (no mutation)
- [ ] One undo entry per gesture; undo restores exact prior layout including trims and variants
- [ ] `new_from >= 0` enforced (no negative timestamps)
- [ ] Drag past current timeline duration extends the timeline (no clamp)
- [ ] No-gap invariant preserved on every track after commit

---

## Tasks

1. [Task 93: Backend `/move-transitions` endpoint + same-track move](../tasks/milestone-10-clip-move-cross-track/task-93-backend-move-endpoint.md) — Endpoint skeleton, single-clip same-track move, timeDelta-only case, undo integration
2. [Task 94: Backend cross-track move + kf ownership + auto-create tracks](../tasks/milestone-10-clip-move-cross-track/task-94-backend-cross-track-and-auto-tracks.md) — Interior-kf migration, boundary-kf duplication, source empty-tr bridge, auto-create tracks on overflow
3. [Task 95: Backend overlap resolution](../tasks/milestone-10-clip-move-cross-track/task-95-backend-overlap-resolution.md) — Soft-delete consume, straddle trim, three-way split, empty-tr kf-shift
4. [Task 96: Backend copy mode](../tasks/milestone-10-clip-move-cross-track/task-96-backend-copy-mode.md) — `mode="copy"` path, fresh tr_id, tr_candidates clone, cache refresh
5. [Task 97: Frontend body-drag gesture + ghost preview (same-track, single-clip)](../tasks/milestone-10-clip-move-cross-track/task-97-frontend-body-drag.md) — Mousedown on interior, 3-4 px threshold, ghost preview bottom-right of cursor, Escape to cancel
6. [Task 98: Frontend cross-track + multi-clip + multi-track source](../tasks/milestone-10-clip-move-cross-track/task-98-frontend-cross-track-multi-clip.md) — Y-delta to trackDelta, multi-clip ghost composite, tooltip, target-track highlight
7. [Task 99: Frontend overlap preview + auto-create-track rows + copy-mode visuals](../tasks/milestone-10-clip-move-cross-track/task-99-frontend-overlap-preview-and-copy.md) — Red tint on consumed, split lines on trimmed, dashed ghost rows for new tracks, Cmd/Ctrl capture, `+` badge

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Overlap preview too expensive on mousemove | Medium | Medium | Memoize by `{timeDelta, trackDelta, mode}`; throttle to 60 fps; only recompute when target track or position changes |
| Boundary-kf duplication causes kf row sprawl | Low | Low | Kfs are cheap; optional later pass to merge duplicate kfs at identical timestamps |
| Auto-create tracks surprises users | Medium | Low | Always show dashed ghost rows during drag so track creation is signalled before commit |
| Multi-clip drag + overlap resolution has interaction bugs | High | Medium | Incremental rollout: same-track single → cross-track single → multi-clip → overlap preview. Each phase lands with tests before the next |
| Copy mode `tr_candidates` clone diverges from split semantics | Medium | Low | Reuse the exact junction-clone helper from M7 split implementation |
| Drop past timeline duration breaks existing audio/effects layouts | Low | Low | Timeline extension is additive; no existing state mutated except dragged clips' timestamps |

---

**Next Milestone**: TBD  
**Blockers**: None for P1–P4. Snap-on-drop (P5) blocked on M7 Tasks 50/51 — deferred as a follow-up.  
**Notes**: Design doc at [`agent/design/local.clip-move-cross-track.md`](../design/local.clip-move-cross-track.md). Clarification at [`agent/clarifications/clarification-6-clip-move-cross-track.md`](../clarifications/clarification-6-clip-move-cross-track.md).
