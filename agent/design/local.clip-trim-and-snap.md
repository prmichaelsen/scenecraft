# Clip Trim, Rolling Edit, Time Remap, and Snap

**Concept**: Convert transitions from "connections that time-remap" to "clips with trim in/out", with three-mode drag interactions (trim/rolling/time-remap) and timeline snap  
**Created**: 2026-04-16  
**Status**: Design Specification  

---

## Overview

Transitions in scenecraft are currently treated as "connections" between keyframes — they stretch/compress the underlying video to fit the timeline span defined by `from_kf.timestamp` and `to_kf.timestamp`. Dragging a keyframe implicitly changes the transition's time-remap factor.

This design introduces a "clip" model: every transition has an explicit `trim_in`/`trim_out` into its source video. Dragging transition boundaries trims the clip rather than time-remapping it. Modifier keys switch between trim, rolling edit, and explicit time remap modes. The timeline is always fully covered — trimming a clip shorter auto-inserts an empty (placeholder) kf+tr to fill the gap. Snap-to-boundary behavior aligns drag targets to keyframes, playhead, and origin.

---

## Problem Statement

Current model conflates two concepts:

1. **Timeline span** (how much time the clip occupies) — stored as `duration_seconds` on the transition
2. **Video length** (how much source footage exists) — determined by ffprobe at render time

The `duration_seconds` field:
- Is used as the Veo generation target (hint only — Veo clamps to 4-8s)
- Is overridden by probed file length at render time (`api_server.py:3551-3561`)
- Causes implicit time-remapping when kfs move without regenerating the video

There's no way to:
- Trim a clip to play only part of its source
- Leave a gap between clips
- Split a clip without a full re-generation
- Perform classical NLE editing operations (trim, rolling, ripple)

---

## Solution

### Data model

Three new columns on the `transitions` table:

```sql
ALTER TABLE transitions ADD COLUMN trim_in REAL NOT NULL DEFAULT 0;
ALTER TABLE transitions ADD COLUMN trim_out REAL;
ALTER TABLE transitions ADD COLUMN source_video_duration REAL;
```

- `trim_in` — in-point offset into the source video (seconds)
- `trim_out` — out-point offset (null means "use full source_video_duration")
- `source_video_duration` — probed length of the selected video file (cached)

Derived (not stored):
- `clip_duration = trim_out - trim_in`
- `timeline_duration = to_kf.timestamp - from_kf.timestamp`
- `time_remap_factor = clip_duration / timeline_duration` (1.0 = real-time)

**No changes to keyframes schema.** Empty-kf behavior derives from existing `selected IS NULL`.

**Empty transition**: a tr with `selected = '[]'` (no variant selected) renders as black frame. Can be filled via generation at any time — same UI as an unfilled user-created tr.

**Trim is per-transition**, not per-variant. When switching variants:
- If new source is shorter: clamp `trim_out = min(trim_out, new_source_duration)`, `trim_in = min(trim_in, new_source_duration - 0.1)`
- Show toast: "Clip auto-trimmed to fit shorter variant"

### Truthiness checks (DB-only, no filesystem)

Replace `has_selected = img_path.exists()` at `api_server.py:1945` with:
- Keyframes: `has_selected_image = (selected IS NOT NULL)`
- Transitions: `has_selected_video = (selected != '[]' AND contains non-null entry)`

File becomes a cached artifact. If `selected != null` but file is missing, surface as corruption error — don't silently fall back to "no image".

### Render-time seek math

Replace `video_time = progress * video_dur` at `api_server.py:3561-3562` with:

```python
progress = (t - tr_from_time) / timeline_duration
video_time = trim_in + (progress * (trim_out - trim_in))
```

### Timeline coverage invariant

**No gaps.** For any two consecutive keyframes kf_A and kf_B, exactly one transition exists with `from_kf=kf_A`, `to_kf=kf_B`, and `timeline_duration = kf_B.timestamp - kf_A.timestamp`.

When a trim operation creates a gap, auto-insert an empty kf + empty tr to bridge it. Empty trs render as black frame (no video to decode).

### Drag model — hover zones

Each boundary (shared kf between two trs) has three hover sub-regions within a few pixels:

```
LEFT clip       <]  <|>  [>       RIGHT clip
                 ▲   ▲   ▲
              trim  roll  trim
              LEFT only  RIGHT
```

**`<]` zone** (LEFT of boundary) — cursor: left-trim
- Plain drag: adjusts `trim_out_LEFT` only
- Shortening creates a gap → insert empty kf + empty tr
- Extending into downstream: consume empty fully (delete) or partially (shrink); split content tr by advancing its `trim_in` proportionally to `time_remap_factor`

**`<|>` zone** (CENTER on boundary) — cursor: double-arrow
- Plain drag: rolling edit — shared kf moves, both trims adjust
- `trim_out_LEFT += delta × time_remap_factor_LEFT`
- `trim_in_RIGHT += delta × time_remap_factor_RIGHT`
- Total timeline unchanged, no cascade
- Clamped by both sides' source availability (whichever runs out first halts the drag)

**`[>` zone** (RIGHT of boundary) — cursor: right-trim
- Plain drag: adjusts `trim_in_RIGHT` only (mirror of `<]`)
- Rightward (shorten): insert empty kf + empty tr before the content
- Leftward (extend): split previous tr by advancing its `trim_out`; consume empty trs; soft-delete if fully overlapped

**Modifier overrides (any zone):**

- **Shift + drag**: ripple — shift all downstream kfs by delta. Preserves all non-dragged trs' time_remap_factors. Changes total timeline duration.
- **Cmd + drag**: time remap — only the dragged kf boundary moves. `trim_in`, `trim_out` unchanged on both adjacent trs. The two adjacent trs see their `time_remap_factor` change (shared-boundary physics, not cascade). No other kfs move. Scope: only applies to tr boundary drags, no conflict with cmd+click elsewhere.

**Hard limits:**
- `trim_in < trim_out` (positive duration)
- `0 ≤ trim_in`, `trim_out ≤ source_video_duration`
- Drag can't extend past available source

**Soft limits**: none on `time_remap_factor` — extreme slow-mo or fast playback is a valid creative choice. No clamp, no warning.

### Drag collision rules (summary)

When `<]` (or `[>`) drag extends toward a neighbor:

| Neighbor | Partial overlap | Full coverage (drag past `to_kf`) |
|----------|-----------------|-----------------------------------|
| Empty tr | Shrink (boundary kf moves) | Consume (delete empty tr + its kf) |
| Content tr | Split (advance neighbor's `trim_in` or `trim_out` by `delta × remap_factor`) | Soft-delete (recoverable from bin) |

All changes within a gesture are reversible (drag back to undo). Commits on mouseup.

### Cleanup policy

**Per-gesture** — empties inserted during a drag are consumed/deleted if the drag reverses past the insertion point, within the same gesture. After mouseup, inserted kf/tr become ordinary nodes indistinguishable from any other.

**No auto-merge** of adjacent empty trs — preserves per-tr metadata (prompts, labels, notes).

### Snap

Snap is a drag-time alignment system that pulls the dragged position to nearby meaningful time markers. Applies to all drag modes (trim / rolling / ripple / time remap / keyframe drag).

**Targets** (precomputed once at drag-start as a sorted time array, binary-searched for nearest on each mouse-move):
- Other keyframe timestamps (including the from/to kfs of all trs)
- Transition boundaries (these are the same kfs, listed separately here for clarity — a tr's `from_kf.timestamp` and `to_kf.timestamp` are snap candidates)
- 0:00 (timeline origin)
- Playhead position (current `currentTime`)
- ~~Beat markers~~ — NOT a snap target (opt-out; may enable as future preference)
- ~~Section boundaries~~ — NOT a snap target
- ~~Ruler marks~~ — NOT a snap target (too noisy, every second would snap)

The dragged node itself is excluded from the target set (can't snap to your own position).

**Threshold**: 8 pixels (fixed regardless of zoom level). At any zoom, "within 8px visually" triggers a snap. Time equivalent: `8 / px_per_second` at current zoom.

**Snap math** (per mouse-move frame during drag):
```
for each target in targets:
  target_px = target * px_per_second
  if abs(mouse_px - target_px) <= 8:
    snap to target (use target value instead of mouse value)
    record snapped_target for visual feedback
    break
```

**Visual feedback** (both applied simultaneously):
1. **Vertical blue line** — rendered at the snap target's x-coordinate during the drag, so the user sees which specific target they're snapping to
2. **Sticky cursor** — the dragged handle stays locked to the snap target until the cursor moves more than 8px away, giving tactile "click-in" feel

**Performance**:
- Snap targets precomputed at drag-start, not re-computed on every mouse-move
- Sorted array + binary search for nearest = O(log n) lookup per frame
- Handles 1000+ targets without performance impact

**Toggle behavior** (must be implemented for snap to be usable):

The snap toggle is a global editor state that must exist before snap logic can be gated behind it. Implementation:

1. **Snap state store**: new React context or store holding a single boolean `snapEnabled`
   - Initial value: read from `localStorage.getItem('scenecraft-snap-enabled')`; default to `true` if absent
   - Setter: updates state AND writes to localStorage
2. **Keyboard handler** (Timeline.tsx or a dedicated hotkeys hook):
   - Listen for `keydown` with `key === 's'` (case-insensitive)
   - Bail early if any modifier is held (`ctrlKey/metaKey/shiftKey/altKey`)
   - Bail early if `document.activeElement.tagName` is `INPUT`, `TEXTAREA`, or has `contentEditable='true'`
   - Call the snap toggle setter, show a brief toast ("Snap: On" / "Snap: Off")
3. **Toolbar button**: new button in the main toolbar area (next to the Transform T button at `Timeline.tsx:1969-1976`)
   - Uses a magnet icon (lucide `Magnet` component)
   - Pressed/active style when `snapEnabled === true`
   - `onClick` calls the same setter
   - `title` attribute: "Snap (S)"
4. **Drag integration**: every drag handler reads `snapEnabled` from the store. If false, skip snap logic entirely (no target computation, no feedback, normal drag).
5. **Cursor hint during drag**: if snap is OFF, show no snap feedback. If ON, show blue line when snapping is active.

**Default state**: ON (conservative — users opt out for fine control, consistent with Premiere/Resolve).

**Persistence**: localStorage key `scenecraft-snap-enabled`, value `'1'` (on) or `'0'` (off). Survives across browser sessions.

**No conflict check**: `s` key is currently unbound in Timeline.tsx (confirmed via `src/lib/hotkeys.ts` review — no existing `s` binding). Future "split" shortcut (a common `s` in other editors) can use `shift+s` or `cmd+k` instead.

---

## Implementation

### Phase 1 — Data migration + backend trim support (no UI)

**scenecraft-engine changes:**

1. **Schema migration** (`db.py`):
   - Add three columns to `transitions` table
   - Update undo triggers to enumerate new columns
2. **Migration script** (one-time):
   - For each transition with a selected variant: ffprobe the video, set `source_video_duration = probe_dur`, `trim_in = 0`, `trim_out = probe_dur`
   - For transitions without selected variants: leave nullable fields null
   - Preserve existing time-remap: `trim_out = probe_dur`, `timeline_duration = duration_seconds` (derived from kf spacing)
3. **Render path** (`api_server.py:3551-3567`):
   - Replace `has_selected = img_path.exists()` with `has_selected = kf["selected"] is not None`
   - Replace `video_time = progress * video_dur` with `video_time = trim_in + (progress * clip_duration)`
4. **Variant selection hook**: when a variant is selected, ffprobe and cache `source_video_duration`
5. **Generation endpoints** (`api_server.py:4670`, `narrative.py`):
   - Skip transitions where `selected == '[]'` (empty trs)
   - Generation duration target becomes a request param, not persisted
6. **Bin/pool copy** (`api_server.py:2915`): carry `trim_in`, `trim_out`, `source_video_duration` when copying a transition
7. **Split/duplicate** (`api_server.py:3812, 3989, 2491`): compute new trim values when splitting a transition
8. **Deprecate `duration_seconds`**: keep column for safety net, drop in follow-up migration after verification

**Frontend changes** (`src/lib/scenecraft-client.ts`, `src/routes/project/$name/editor.tsx`):
- Add `trimIn`, `trimOut`, `sourceVideoDuration` to the transition type
- No UI changes yet — all trims initialize to "full video"

### Phase 2 — Trim drag UI (right edge, no modifiers)

1. **TransitionTrack.tsx**: add drag handles at transition right edges
2. **Hover zone detection**: 12px boundary zones (`<]` 4px, `<|>` 4px, `[>` 4px)
3. **Cursor feedback**: set appropriate cursor per zone on hover
4. **Trim drag handler**: update `trim_out` on drag, collision rules for downstream trs (empty consume/shrink, content split/soft-delete)
5. **Empty tr insertion/removal**: detect gaps during drag and insert/remove empty kf+tr accordingly
6. **Per-gesture reversibility**: track insertions/deletions within a gesture, roll back on drag-back
7. **Render empty trs**: black frame when `selected == '[]'`

### Phase 3 — Full modes + snap

1. **Modifier handlers**: shift+drag (ripple), cmd+drag (time remap)
2. **Left-edge trim**: `[>` zone + modifiers (mirror of right edge)
3. **Rolling edit**: `<|>` zone (plain drag)
4. **Snap toggle infrastructure** (prerequisite for snap logic):
   - Snap state store/context holding `snapEnabled: boolean`
   - Initial value from `localStorage['scenecraft-snap-enabled']`, default `true`
   - Setter updates state + persists to localStorage
   - `s` key handler (gated on no modifiers, no text-input focus)
   - Magnet toolbar button next to Transform T button (`Timeline.tsx:1969-1976` area)
   - Toast feedback on toggle ("Snap: On" / "Snap: Off")
5. **Snap target computation**: at drag-start, build sorted array of all snap candidates (kfs, tr boundaries, 0:00, playhead) excluding the dragged node
6. **Snap hit-testing**: on each mouse-move during drag, if `snapEnabled`, binary-search for nearest target within 8px; if found, replace mouse value with target value
7. **Snap visual feedback**: blue vertical line rendered at snapped target's x-coordinate; sticky cursor behavior until 8px threshold exceeded
8. **Integration with drag handlers**: every drag handler (trim/rolling/ripple/remap/kf-drag) checks `snapEnabled` before running snap logic — if off, normal drag with no feedback

---

## Benefits

- **Clean separation of concerns**: timeline span (kf timestamps) is independent from video length (source_video_duration) and trim (trim_in/out)
- **NLE-standard drag model**: three modes match user mental models from Premiere/Resolve/Avid
- **Hover-zone interaction** gives clear visual feedback before commit — no guessing which behavior will trigger
- **No schema flags** for empty states — existing DB columns (`selected`) are sufficient
- **Reversible drags** within a gesture (natural undo feel)
- **Backward compatible**: existing transitions migrate to `trim_out = full_source_duration`, behavior unchanged until user trims

---

## Trade-offs

- **Hot path touched**: Phase 1 modifies render, generation, and bin code paths. Should be gated behind a branch or feature flag.
- **Drag UX complexity**: three hover zones + three modifier states = 9 interaction combinations. Cursor feedback is critical.
- **Per-gesture reversibility**: requires tracking inserted/deleted nodes during drag; moderate implementation effort.
- **No soft clamps on time remap**: extreme values can produce jarring playback. Acceptable per user — creative choice over paternalistic clamp.

---

## Dependencies

- `sqlite3` schema changes with undo-trigger updates
- `ffprobe` for probing video durations (already used in render path)
- Existing WebSocket job progress infrastructure (no changes)
- No new external libraries

---

## Testing Strategy

**Phase 1 (data migration):**
- Verify all existing transitions get `source_video_duration` probed correctly
- Verify render seek math produces identical playback to pre-migration (trim_in=0, trim_out=full)
- Verify split/duplicate operations carry trim values
- Verify generation skips empty trs

**Phase 2 (trim drag):**
- Shrink clip → empty kf+tr inserted
- Extend clip over empty → empty consumed/shrunk correctly
- Extend clip over content → content tr's trim_in advanced (split behavior)
- Drag back within gesture → insertions/deletions reverse
- Variant switch with shorter video → trim clamped and gap auto-filled

**Phase 3 (full modes + snap):**
- Left-edge drag mirrors right-edge rules
- Rolling edit preserves both sides' time_remap_factor, total timeline unchanged
- Ripple edit shifts all downstream, preserves non-dragged trs' remap factors
- Time remap drag only moves one kf, adjacent trs' remap factors change
- Snap: drag near kf timestamp snaps at 8px; toggle via `s` key and toolbar button
- Snap persistence: state survives reload

---

## Migration Path

Gated behind a dev flag `SCENECRAFT_CLIP_MODEL=1` for Phase 1 rollout. Once verified stable:
1. Run migration script on all existing projects (idempotent — skips already-migrated rows)
2. Remove `duration_seconds` column in a follow-up migration
3. Remove the feature flag

Phase 2 and 3 UI changes ship without flags (new drag handles, no existing UI to break).

---

## Key Design Decisions

### Data Model

| Decision | Choice | Rationale |
|---|---|---|
| Replace `duration_seconds` | 3 fields: `source_video_duration`, `trim_in`, `trim_out` | Current field conflates timeline span with video length; render path already prefers probed duration |
| Store `source_video_duration` | Yes, cached on transition | Avoids per-render ffprobe; UI needs it for drag clamping |
| Trim scope | Per-transition (not per-variant) | User picks trim once; variant switch clamps to new source length |
| Store `time_remap_factor` | Derived at render time | Single source of truth; no drift risk |
| Empty entity flags | None — use `selected IS NULL` / `selected != '[]'` | Existing columns already encode the state |
| Keyframe truthiness | `selected IS NOT NULL` in DB | Drops filesystem stat at `api_server.py:1945`; DB becomes sole source of truth |

### Timeline Coverage

| Decision | Choice | Rationale |
|---|---|---|
| Gap handling | Auto-insert empty kf + empty tr | Every span has explicit identity; boundaries are directly draggable |
| Empty tr display | Black frame | Consistent with "no selected video" regardless of context |
| Cleanup policy | Per-gesture drag-back | Natural undo feel; no persistent flags; post-gesture empties are ordinary nodes |
| Auto-merge adjacent empties | No | Preserves per-tr metadata (prompts, labels) |
| Explicit vs auto empty | No distinction — both are plain trs | Empty is a display state, not a semantic flag |

### Drag Model

| Decision | Choice | Rationale |
|---|---|---|
| Boundary hit regions | Three hover zones (`<]` / `<|>` / `[>`) | Cursor tells user what will happen before commit |
| Plain drag on `<]`/`[>` | Single-side trim, insert empty if space created | Predictable — no implicit boundary motion |
| Plain drag on `<|>` | Rolling edit (both trims adjust) | Classical NLE rolling; localized, no cascade |
| Shift + drag | Ripple edit (all downstream shift) | Matches Premiere/Resolve; preserves speeds |
| Cmd + drag | Time remap (only dragged kf moves) | Mutation scoped to the boundary; no cascading kf motion |
| Rolling propagation | All downstream | "Only next" would unexpectedly change next tr's remap factor |
| Preserve empties during rolling | Yes | Least-surprise; intentional pauses preserved |
| Time remap limits | None (hard physical limits only) | Extreme slow-mo/fast is valid creative use; no clamp, no warn |

### Collision Rules

| Condition | Behavior |
|---|---|
| Drag extends into empty tr, partial overlap | Empty tr shrinks (boundary kf moves) |
| Drag extends over entire empty tr | Consume (delete empty tr + its kf) |
| Drag extends into content tr, partial | Split-like — advance neighbor's `trim_in`/`trim_out` by `delta × remap_factor` |
| Drag extends over entire content tr | Soft-delete content tr (recoverable from bin) |
| Rolling drag | Clamped by both sides' source availability |

### Snap

| Decision | Choice | Rationale |
|---|---|---|
| Targets | keyframes, tr boundaries, 0:00, playhead | Essential alignment points; no music/section/ruler noise |
| Threshold | 8px pixel-based | Matches Premiere/Resolve; consistent feel at any zoom |
| Feedback | Blue line + sticky cursor | Visual (which target) + tactile (confirms snap) |
| Toggle | `s` key + magnet toolbar button | Hotkey + discoverable UI |
| Persistence | localStorage (`scenecraft-snap-enabled`) | Users develop preferences |
| Default | ON | Conservative default; opt-out for fine control |

### Migration

| Decision | Choice | Rationale |
|---|---|---|
| Schema approach | Add columns to `transitions` | Clip IS a transition in this model; no new join complexity |
| Columns | `trim_in`, `trim_out`, `source_video_duration` | Only these; no flags for empty/cleanup |
| Backfill | Probe videos for `source_video_duration`; set `trim_in=0`, `trim_out=probe_dur` | Preserves existing behavior; time-remap preserved via kf spacing |
| `duration_seconds` | Deprecate, keep as safety net, drop later | Low-risk migration |

### Phasing

| Phase | Scope | Blocking? |
|---|---|---|
| 1 | DB migration + backend trim support | Hot path — flag-gated |
| 2 | Trim drag UI (right edge, no modifiers) | UI-only, parallel-safe |
| 3 | Rolling + remap + snap + left edge | UI-only, parallel-safe |

---

## Future Considerations

- **Split tool** (cmd+k or similar) — slice a clip at the playhead. May conflict with `s` key; use `shift+s` or `cmd+k` when added.
- **Per-empty-tr `fill_mode`** (hold_prev / hold_next / black) — currently always black; user override later if needed.
- **Drag-and-drop video assets onto timeline** — convert empty tr to content tr by dropping a bin video.
- **Keyboard trim** (`[` / `]` at playhead) — trim to playhead shortcut.
- **Visual time-remap factor indicator** on clips (speed badge: "1.5x") — already computed in `TransitionTrack.tsx:101`.
- **Soft clamp warnings** (optional, per-user preference) — if extreme time remaps become a support burden.

---

**Status**: Design Specification  
**Recommendation**: Proceed to Phase 1 implementation (schema migration + backend trim support, flag-gated)  
**Related Documents**:
- [`clarification-4-clip-trim-and-snap.md`](../clarifications/clarification-4-clip-trim-and-snap.md) — source of decisions
