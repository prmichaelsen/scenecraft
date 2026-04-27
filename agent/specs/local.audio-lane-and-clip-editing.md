# Spec: Audio Lane and Clip Editing

> **🤖 Agent Directive**: This is a retroactive black-box specification. It describes observable behavior of the already-shipped `AudioTrack` + `AudioLane` + `audio-overlap` surface as of 2026-04-27. Implementation details are deliberately omitted; the contract here is what a reimplementation must preserve.

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Active (retroactive)

---

## Purpose

Define the exact observable behavior of the scenecraft editor's audio-track surface: `AudioTrack` as playback master, `AudioLane` as clip host, and `resolveOverlapsWithSplit` as the DaVinci-style drop/trim arbitrator.

## Source

- Mode: retroactive, from code + audit
- Primary artifacts:
  - `src/components/editor/AudioTrack.tsx`
  - `src/components/editor/AudioLane.tsx`
  - `src/lib/audio-overlap.ts`
  - `src/lib/audio-clip-styling.ts`
- Architectural context: `agent/reports/audit-2-architectural-deep-dive.md` §1D unit 6, §1E unit 12, §3 leak #3

## Scope

### In scope
- `AudioTrack` playback-master role: owns a single `HTMLAudioElement`, publishes `seekRef` / `playPauseRef` / `audioElRef` to the parent, and drives the playhead via `timeupdate` → `onTimeUpdate`.
- Wavesurfer handoff: initial `canplay`-based seek/play handler is upgraded to Wavesurfer-backed handlers on `ready`.
- IndexedDB peaks cache (`scenecraft-waveform-cache` / `peaks` store) keyed by `audioUrl`.
- `AudioLane` clip rendering: time-window layout (`start_time * pxPerSec` → width from `end_time - start_time`), 4 px vertical inset, waveform overlay, clip label, 6 px edge-trim hit zones, selection ring, highlight glow, drag-ghost CSS transform, `variant_kind` coloring.
- Drop-target behavior for `application/x-scenecraft-pool-path` (Bin audio) and `application/x-scenecraft-stem` (AudioIsolationsPanel stems).
- Header-row behavior: sticky-left header, drag-reorder source/target, rename (double-click), mute/solo buttons, context menu (Rename / Move up / Move down / Delete track…).
- Clip context menu (Mute/Unmute, Align waveforms, Delete audio clip) with selection-promote on right-click.
- Mute toggle on clips (`clip.muted`) rendered as 40 % opacity.
- `resolveOverlapsWithSplit` DaVinci overwrite-with-split semantics: delete / left-trim (advances `source_offset`) / right-trim (does not) / split-insert.
- Trim preview: optimistic CSS-level edge shift via `trimPreview` prop until commit.
- Cross-track move: Y translation by `dragTrackDelta * laneHeight`.
- Variant-kind color mapping via `VARIANT_KIND_COLORS` with fallback to cyan.
- `headerless` mode (clip body only, header rendered elsewhere).

### Out of scope
- WebAudio mixer graph internals (`audio-mixer.ts`, `mix-graph.ts`) — separate spec.
- Waveform rendering internals (`AudioWaveform.tsx`, waveform cache fetch) — separate spec.
- Effects/curves/sends — separate spec.
- Backend `batch-ops` endpoint implementation — separate spec (this spec only defines what ops `resolveOverlapsWithSplit` emits).
- Actual HTTP calls made by Timeline after drop (this spec bounds `AudioLane`'s payload to the parent callback).

## Requirements

1. **R1** — `AudioTrack` MUST create exactly one `HTMLAudioElement` per `audioUrl` and publish it through `audioElRef` (when provided) before playback is possible.
2. **R2** — `AudioTrack` MUST wire `seekRef.current` and `playPauseRef.current` no later than the `canplay` event, and MUST upgrade them to Wavesurfer-backed handlers once the waveform is `ready`.
3. **R3** — `AudioTrack` MUST emit `onTimeUpdate` at the native `HTMLAudioElement` `timeupdate` cadence (and at Wavesurfer's `timeupdate` cadence once ready), giving the playhead continuous position updates while playing.
4. **R4** — `AudioTrack` MUST null out `seekRef.current` and `playPauseRef.current` during unmount (destroy Wavesurfer instance), so callers do not invoke stale playback handlers.
5. **R5** — `AudioTrack` MUST cache exported peaks in IndexedDB keyed by `audioUrl`, and MUST consume a cached peaks record when present to skip redecoding on subsequent mounts. Cache failures MUST be non-fatal.
6. **R6** — When `pxPerSec` changes, `AudioTrack` MUST update Wavesurfer's `minPxPerSec` without destroying the instance.
7. **R7** — `AudioLane` MUST render each clip as an absolutely positioned block with `left = clip.start_time * pxPerSec` and `width = max(2, (clip.end_time - clip.start_time) * pxPerSec)`.
8. **R8** — A clip with `variant_kind` matching a key in `VARIANT_KIND_COLORS` MUST use that key's color palette; otherwise the default cyan palette MUST be used. Null/undefined/unknown variant kinds MUST fall back to cyan.
9. **R9** — A clip with `muted === true` MUST render at 40 % opacity (`opacity-40`); the whole lane MUST render at 50 % opacity (`opacity-50`) when `track.muted === true`.
10. **R10** — Clicking an empty area of the lane MUST select the track (via `setSelectedAudioTrackId`). Clicking a clip MUST invoke `onClipClick(clip, shiftKey)` if provided, else select the single clip via `setSelectedAudioClipId`.
11. **R11** — Right-clicking a clip MUST show a context menu with "Mute/Unmute", "Align waveforms", and "Delete audio clip" items, and MUST promote the right-clicked clip into the selection batch (`batchIds`) even when it was not already in `selectedIds`.
12. **R12** — "Align waveforms" MUST be disabled unless `batchIds.length >= 2` AND `onRequestAlignWaveforms` is wired.
13. **R13** — "Mute/Unmute" target state MUST be `!clip.muted` (the right-clicked clip's inverted state) and MUST apply to the full `batchIds` set.
14. **R14** — Left-edge trim (6 px hit zone) MUST call `onClipTrimMouseDown(clip, 'left', e)`; right-edge trim MUST call `onClipTrimMouseDown(clip, 'right', e)`. Clips narrower than 12 px MUST NOT render trim hit zones.
15. **R15** — When `trimPreview.clipIds.has(clip.id)` and `trimPreview.edge === 'left'`, the rendered `baseStart` MUST be `clip.start_time + trimPreview.offsetSeconds`; when `edge === 'right'`, `baseEnd` MUST be `clip.end_time + trimPreview.offsetSeconds`. The underlying `clip` data MUST NOT be mutated.
16. **R16** — When `draggingIds?.has(clip.id)`, the block MUST translate by `(dragOffsetSeconds * pxPerSec, dragTrackDelta * laneHeight)` via CSS `transform` and MUST set `pointer-events: none` so `elementFromPoint` resolves to the target lane below.
17. **R17** — `AudioLane` MUST accept drops of `application/x-scenecraft-pool-path` (Bin pool audio) and `application/x-scenecraft-stem` (isolation stem), and MUST ignore drags with any other MIME. A valid drag MUST call `preventDefault()` and set `dropEffect='copy'`, and the lane MUST paint the `poolDropActive` cyan tint.
18. **R18** — The drop's `startTime` MUST equal `max(0, (clientX − laneLeft + scrollLeft) / pxPerSec)`, where `scrollLeft` is read from the nearest horizontally-scrollable ancestor.
19. **R19** — A stem drop MUST call `onDropStem(track.id, startTime, payload, clips)` passing the current clip snapshot. A pool-audio drop MUST call `onDropPoolAudio(track.id, startTime, poolPath)`. A malformed stem JSON payload MUST be logged and swallowed (no callback fired, no throw).
20. **R20** — `resolveOverlapsWithSplit(dropped, existing, genId)` MUST emit ops per clip `c` in `existing` according to:
    - No overlap (`c.end_time <= dropped.start || c.start_time >= dropped.end`) → no op.
    - `dropped` fully covers `c` → `{op:'delete', id:c.id}`.
    - `dropped` covers left edge only → `{op:'trim', id, start_time: dropped.end, source_offset: c.source_offset + (dropped.end - c.start_time)}`.
    - `dropped` covers right edge only → `{op:'trim', id, end_time: dropped.start}` (NO `source_offset` change).
    - `dropped` fits strictly inside `c` → two ops: `{op:'trim', id, end_time: dropped.start}` and `{op:'insert', clip:{id: genId(), track_id: c.track_id, source_path, start_time: dropped.end, end_time: c.end_time, source_offset: c.source_offset + (dropped.end - c.start_time), volume_curve, muted, remap}}`.
21. **R21** — `resolveOverlapsWithSplit` MUST NOT emit an op for the dropped clip itself — the caller appends the terminal insert.
22. **R22** — `resolveOverlapsWithSplit` MUST be a pure function (no DOM, no fetch, no mutation of `existing`).
23. **R23** — Track header drag-source MUST be the `A{n}` prefix badge only; the wrapper MUST NOT be HTML5-draggable (otherwise M/S button clicks are eaten). Drag MUST set `application/x-audio-track-id` to `track.id`.
24. **R24** — Header drop target MUST compute `position = (clientY < rect.top + rect.height/2) ? 'before' : 'after'` and call `onRequestReorderTracks(draggedId, track.id, position)`. A drop with `draggedId === track.id` MUST be a no-op.
25. **R25** — Track rename MUST commit on Enter or blur, MUST revert on Escape, and MUST no-op when the trimmed draft is empty or equal to the current name.
26. **R26** — When `headerless === true`, `AudioLane` MUST NOT render the sticky header block; clip body + drop behavior MUST be unaffected.
27. **R27** — Extraction ghost blocks (from `ghosts` prop) MUST render above clips at `z-30`, use the striped repeating-linear-gradient background, and be non-interactive (`pointer-events: none`).
28. **R28** — Clip selection styling precedence: `selected` ring overrides `highlighted` glow; a highlighted-but-not-selected clip gets the yellow ring/shadow; neither → palette default border.

## Interfaces / Data Shapes

### AudioLane props
See `AudioLaneProps` in `AudioLane.tsx` (quoted verbatim in source). Key shapes:

```ts
type StemDropPayload = {
  pool_segment_id: string
  pool_path: string
  stem_type: 'vocal' | 'background'
  duration_seconds: number
  source_label: string
}

type TrimPreview = {
  clipIds: Set<string>
  edge: 'left' | 'right'
  offsetSeconds: number
}
```

### AudioTrack props

```ts
type AudioTrackProps = {
  audioUrl: string
  pxPerSec: number
  onTimeUpdate: (time: number) => void
  onDurationChange: (duration: number) => void
  onPlayingChange: (playing: boolean) => void
  seekRef: MutableRefObject<((time: number) => void) | null>
  playPauseRef: MutableRefObject<(() => void) | null>
  audioElRef?: MutableRefObject<HTMLAudioElement | null>
}
```

### Overlap resolver

```ts
type ClipRow = {
  id: string
  track_id: string
  start_time: number
  end_time: number
  source_offset: number
  source_path: string
  volume_curve?: unknown
  muted?: boolean
  remap?: unknown
}

type Range = { start: number; end: number }

type BatchOp =
  | { op: 'trim'; id: string; start_time?: number; end_time?: number; source_offset?: number }
  | { op: 'delete'; id: string }
  | { op: 'split'; id: string; at: number; new_id: string; source_offset_right?: number }
  | { op: 'insert'; clip: { id; track_id; source_path; start_time; end_time; source_offset; volume_curve?; muted?; remap? } }

resolveOverlapsWithSplit(dropped: Range, existing: ClipRow[], genId: () => string): BatchOp[]
```

Note: `BatchOp.split` is declared in the type but not currently emitted by `resolveOverlapsWithSplit` (splits are expressed as `trim` + `insert`). Included here for interface completeness.

### Variant-kind palette

```ts
VARIANT_KIND_COLORS = {
  music:   { bg: bg-purple-900/30, ... },
  lipsync: { bg: bg-teal-900/30,   ... },
  foley:   { bg: bg-orange-900/30, ... },
}
DEFAULT_CLIP_COLORS = cyan (bg-cyan-900/30, ...)
```

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | AudioTrack mounts with a new `audioUrl` | Creates one `<audio>`, publishes `audioElRef`, wires seek/play on `canplay` | `audiotrack-wires-refs-on-canplay`, `audiotrack-publishes-audio-el-ref` |
| 2 | Playback advances | `timeupdate` events call `onTimeUpdate` continuously | `audiotrack-timeupdate-drives-playhead` |
| 3 | Wavesurfer finishes decoding | `seekRef`/`playPauseRef` are upgraded to Wavesurfer-backed handlers; duration reported | `audiotrack-upgrades-handlers-on-ready` |
| 4 | `pxPerSec` prop changes | Wavesurfer `minPxPerSec` updated without recreating instance | `audiotrack-updates-zoom-without-rebuild` |
| 5 | Cached peaks exist for URL | Wavesurfer initialized with cached peaks (no re-decode) | `audiotrack-uses-cached-peaks` |
| 6 | No cache; decode succeeds | `exportPeaks()` written to IDB after ready | `audiotrack-writes-peaks-cache` |
| 7 | IDB throws during cache read/write | Non-fatal; init proceeds; no re-throw | `audiotrack-swallows-idb-errors` |
| 8 | AudioTrack unmounts | Wavesurfer destroyed; `seekRef.current`/`playPauseRef.current` nulled | `audiotrack-cleans-up-on-unmount` |
| 9 | AudioLane renders a clip at `start_time=10, end_time=12, pxPerSec=100` | Block at `left=1000, width=200` | `audiolane-positions-clip-block` |
| 10 | Clip with `variant_kind='music'` | Purple palette applied | `audiolane-colors-music-purple` |
| 11 | Clip with `variant_kind='foley'` | Orange palette applied | `audiolane-colors-foley-orange` |
| 12 | Clip with `variant_kind='lipsync'` | Teal palette applied | `audiolane-colors-lipsync-teal` |
| 13 | Clip with `variant_kind=null` | Default cyan palette applied | `audiolane-defaults-to-cyan` |
| 14 | Clip with unknown `variant_kind='bogus'` | Default cyan palette applied (no throw) | `audiolane-unknown-variant-falls-back` |
| 15 | `clip.muted === true` | Block rendered at 40 % opacity | `audiolane-mutes-clip-visually` |
| 16 | `track.muted === true` | Entire lane rendered at 50 % opacity | `audiolane-mutes-track-visually` |
| 17 | Click on empty lane area | Track selected via `setSelectedAudioTrackId` | `audiolane-empty-click-selects-track` |
| 18 | Click on clip with `onClipClick` wired | `onClipClick(clip, shiftKey)` invoked; no track selection | `audiolane-clip-click-delegates` |
| 19 | Click on clip without `onClipClick` | `setSelectedAudioClipId(clip.id)` invoked | `audiolane-clip-click-fallback` |
| 20 | Right-click unselected clip | Clip promoted into batch; context menu opens | `audiolane-right-click-promotes` |
| 21 | "Mute" on batch of 3 clips, all currently unmuted | `onRequestToggleMute(batchIds, true)` | `audiolane-mute-batch` |
| 22 | "Unmute" on muted clip right-click | `onRequestToggleMute(batchIds, false)` | `audiolane-unmute-batch` |
| 23 | "Align waveforms" with only 1 clip selected | Item disabled | `audiolane-align-disabled-single` |
| 24 | Left-edge mousedown on clip | `onClipTrimMouseDown(clip, 'left', e)` fired | `audiolane-left-trim-fires` |
| 25 | Right-edge mousedown on clip | `onClipTrimMouseDown(clip, 'right', e)` fired | `audiolane-right-trim-fires` |
| 26 | Clip narrower than 12 px | Trim hit zones not rendered | `audiolane-narrow-clip-no-trim-zones` |
| 27 | `trimPreview` with `edge='left', offsetSeconds=0.5` on matching clip | Rendered `left` shifts by +0.5 s; `clip` not mutated | `audiolane-trim-preview-left` |
| 28 | `trimPreview` with `edge='right', offsetSeconds=-1.0` | Rendered right edge shifts back by 1 s | `audiolane-trim-preview-right` |
| 29 | Clip in `draggingIds` with `dragOffsetSeconds=2, dragTrackDelta=1` | CSS transform `translate(200px, laneHeight px)`; `pointer-events: none` | `audiolane-drag-transform` |
| 30 | Drop pool-path payload on lane | `onDropPoolAudio(track.id, startTime, poolPath)` with correct `startTime` | `audiolane-drop-pool-audio` |
| 31 | Drop stem payload on lane | `onDropStem(track.id, startTime, payload, clips)` | `audiolane-drop-stem` |
| 32 | Drop with malformed stem JSON | Logged; no callback; no throw | `audiolane-drop-bad-stem-swallowed` |
| 33 | Drag of unrelated MIME over lane | Ignored; no `poolDropActive`; drop does nothing | `audiolane-ignores-foreign-drag` |
| 34 | `startTime` accounts for scroll offset | `(clientX − laneLeft + scrollLeft) / pxPerSec`, clamped to ≥ 0 | `audiolane-drop-scroll-aware` |
| 35 | Header drag-source from `A{n}` badge | `application/x-audio-track-id = track.id` set | `audiolane-header-drag-source` |
| 36 | Header drop on top half | `onRequestReorderTracks(draggedId, track.id, 'before')` | `audiolane-header-drop-before` |
| 37 | Header drop on bottom half | `onRequestReorderTracks(draggedId, track.id, 'after')` | `audiolane-header-drop-after` |
| 38 | Header drop with `draggedId === track.id` | No-op | `audiolane-header-drop-self-noop` |
| 39 | Rename commit with new value | `onUpdateTrack(id, {name})` called | `audiolane-rename-commits` |
| 40 | Rename Escape | Draft reverted; `onUpdateTrack` not called | `audiolane-rename-cancels` |
| 41 | Rename commit to empty / unchanged | No `onUpdateTrack` call | `audiolane-rename-noop-empty` |
| 42 | `headerless=true` | No header rendered; clips + drop behavior intact | `audiolane-headerless-mode` |
| 43 | Ghost array provided | Ghost blocks rendered at `z-30`, non-interactive | `audiolane-renders-ghosts` |
| 44 | Overlap resolver: dropped fully covers existing | `{op:'delete', id}` | `resolve-deletes-consumed` |
| 45 | Overlap resolver: dropped covers LEFT edge only | `trim` with new `start_time` AND advanced `source_offset` | `resolve-left-trim-advances-source-offset` |
| 46 | Overlap resolver: dropped covers RIGHT edge only | `trim` with new `end_time` only; `source_offset` untouched | `resolve-right-trim-preserves-source-offset` |
| 47 | Overlap resolver: dropped strictly inside existing | `trim` left half + `insert` right half with advanced `source_offset` | `resolve-split-inside` |
| 48 | Overlap resolver: no overlap | No ops emitted for that clip | `resolve-skip-non-overlapping` |
| 49 | Overlap resolver: does not emit terminal insert for dropped clip | Caller is responsible for inserting dropped | `resolve-omits-terminal-insert` |
| 50 | Overlap resolver: does not mutate `existing` | Input array and its entries unchanged | `resolve-is-pure` |
| 51 | Highlighted clip that is ALSO selected | Selected ring takes precedence; no yellow glow | `audiolane-selection-beats-highlight` |
| 52 | Drop clip exactly at existing clip boundary (`dropped.start === c.end_time`) | **undefined** — touch-but-not-overlap treated as no-overlap per `!(c.end_time <= dropped.start ...)`, but symmetry of drop onto zero-gap is untested | → [OQ-1](#open-questions) |
| 53 | Trim that would collapse clip to zero duration | **undefined** | → [OQ-2](#open-questions) |
| 54 | Drop onto muted track | **undefined** (drop is accepted; no special behavior coded) | → [OQ-3](#open-questions) |
| 55 | Drop of non-audio pool_segment (e.g. video pool-path) | **undefined** — `AudioLane` accepts the MIME regardless of segment kind | → [OQ-4](#open-questions) |
| 56 | AudioTrack unmounted mid-playback | **undefined** — refs nulled, but caller's stale `seekRef.current?.()` becomes no-op; playback stall semantics are not contracted here (see audit leak #3) | → [OQ-5](#open-questions) |
| 57 | Clip spans negative time (`start_time < 0`) | **undefined** — renderer computes negative `left`; clamping not specified | → [OQ-6](#open-questions) |
| 58 | Left-trim whose computed `source_offset` becomes negative (existing had small `source_offset`, trim advances past 0 … but formula is `c.source_offset + (dropped.end − c.start_time)`, always ≥ `c.source_offset`, so negative would require negative delta) | **undefined** — resolver does not clamp, but currently no input can drive it negative given the overlap precondition | → [OQ-7](#open-questions) |

## Behavior

### AudioTrack lifecycle (playback master)
1. On mount (or `audioUrl` change), `AudioTrack`:
   - Calls `openCacheDb()` and `getCachedPeaks(audioUrl)`.
   - Creates `new Audio(audioUrl)` with `crossOrigin='anonymous'`, `preload='auto'`.
   - Assigns `audioElRef.current = audio` (if provided).
   - Wires `canplay` once: sets `playPauseRef.current` (toggle play/pause on the `<audio>`), sets `seekRef.current` (sets `audio.currentTime` + calls `onTimeUpdate`).
   - Wires `durationchange` → `onDurationChange(audio.duration)` when finite.
   - Wires `timeupdate` → `onTimeUpdate(audio.currentTime)`.
   - Creates a WaveSurfer instance bound to that `<audio>` as `media`, using cached peaks if present.
   - On Wavesurfer `ready`: upgrades `seekRef.current` to `ws.setTime(time) + onTimeUpdate(time)`, upgrades `playPauseRef.current` to `ws.playPause()`, calls `onDurationChange(ws.getDuration())`, and caches peaks if they weren't pre-loaded.
   - Wires Wavesurfer `timeupdate`/`play`/`pause` to their respective callbacks.
2. On `pxPerSec` change (separate effect): `ws.setOptions({ minPxPerSec })`.
3. On unmount: sets `destroyed=true`, destroys Wavesurfer, nulls both refs.

### AudioLane rendering pipeline
1. Read `clips = track.clips ?? []`.
2. For each clip, compute `baseStart`/`baseEnd` (apply `trimPreview` if matched), then `left = baseStart * pxPerSec`, `width = max(2, (baseEnd - baseStart) * pxPerSec)`.
3. Apply CSS classes from `getClipColors(clip.variant_kind)`.
4. If `clip.muted`, add `opacity-40`.
5. If selected, add `borderSelected` + `ring-1 ring-cyan-300/60`; else if highlighted, yellow glow; else default border.
6. If `draggingIds.has(clip.id)`, add transform + `pointer-events: none` + `z-40`.
7. Render waveform, label (if width > 48), short clip-id hash, and 6 px trim zones (if width > 12 AND `onClipTrimMouseDown` wired).

### Drop handling
1. `onDragOver`: accept only `application/x-scenecraft-pool-path` or `application/x-scenecraft-stem`. If accepted → `preventDefault`, `dropEffect='copy'`, set `poolDropActive=true`.
2. `onDragLeave`: `poolDropActive=false`.
3. `onDrop`:
   - Read `stemRaw` and `poolPath` from dataTransfer.
   - If both empty → return.
   - Compute `startTime = max(0, (clientX − rect.left + scrollLeft) / pxPerSec)` using nearest scrollable ancestor's `scrollLeft`.
   - If `stemRaw` and `onDropStem`: try `JSON.parse`, call `onDropStem(track.id, startTime, payload, clips)`, return. On parse failure: `console.error` only.
   - Else if `poolPath` and `onDropPoolAudio`: call `onDropPoolAudio(track.id, startTime, poolPath)`.

### Overlap resolution (DaVinci semantics)
For each `c` in `existing`:
- Skip if non-overlapping.
- `coversLeft = dropped.start <= c.start_time`
- `coversRight = dropped.end >= c.end_time`
- Both → delete.
- `coversLeft` only → trim: `start_time = dropped.end`, `source_offset = c.source_offset + (dropped.end - c.start_time)`.
- `coversRight` only → trim: `end_time = dropped.start`. **No** `source_offset` change (the preserved left portion reads the same source region).
- Neither (strictly inside) → trim existing's `end_time` to `dropped.start` + insert new right-half clip from `dropped.end` to `c.end_time` with advanced `source_offset`.

Caller appends a terminal insert for the dropped clip.

## Acceptance Criteria

- [ ] All rows in the Behavior Table have a corresponding test (`undefined` rows link to Open Questions).
- [ ] All listed Tests pass.
- [ ] `resolveOverlapsWithSplit` is a pure function (tested via frozen-input or deep-equal-before-after).
- [ ] Left-trim advances `source_offset`; right-trim does NOT.
- [ ] Playback refs (`seekRef`/`playPauseRef`) are null after AudioTrack unmount.
- [ ] Variant-kind coloring fires for music / foley / lipsync; cyan fallback for null/unknown.
- [ ] Drop of malformed stem JSON never throws.
- [ ] The five tests under "Edge Cases" exercise boundary conditions documented in Open Questions are added once those OQs are resolved.

## Tests

### Base Cases

#### Test: audiotrack-wires-refs-on-canplay (covers R1, R2)
**Given**: AudioTrack mounts with a fresh `audioUrl` and `seekRef`/`playPauseRef`/`audioElRef` initially `null`.
**When**: The audio element fires `canplay`.
**Then**:
- **audio-el-ref-set**: `audioElRef.current` is the created `HTMLAudioElement`.
- **seek-ref-set**: `seekRef.current` is a function.
- **play-ref-set**: `playPauseRef.current` is a function.
- **crossorigin-anonymous**: The created `<audio>` has `crossOrigin = 'anonymous'`.

#### Test: audiotrack-publishes-audio-el-ref (covers R1)
**Given**: Parent passes `audioElRef`.
**When**: AudioTrack initializes.
**Then**:
- **ref-assigned-before-canplay**: `audioElRef.current` is non-null immediately after mount (before `canplay` fires).

#### Test: audiotrack-timeupdate-drives-playhead (covers R3)
**Given**: AudioTrack is mounted and playing.
**When**: The underlying `<audio>` fires `timeupdate` with `currentTime = 2.5`.
**Then**:
- **forwards-to-callback**: `onTimeUpdate` is called with `2.5`.

#### Test: audiotrack-upgrades-handlers-on-ready (covers R2)
**Given**: AudioTrack has passed `canplay` and wired `seekRef`.
**When**: Wavesurfer fires `ready`.
**Then**:
- **seek-uses-wavesurfer**: Calling `seekRef.current(t)` routes through `ws.setTime(t)` and also calls `onTimeUpdate(t)`.
- **playpause-uses-wavesurfer**: Calling `playPauseRef.current()` routes through `ws.playPause()`.
- **duration-reported**: `onDurationChange(ws.getDuration())` is called.

#### Test: audiotrack-updates-zoom-without-rebuild (covers R6)
**Given**: AudioTrack is mounted; wavesurfer instance `W` is active.
**When**: `pxPerSec` prop changes from 100 to 200.
**Then**:
- **setoptions-called**: `W.setOptions({ minPxPerSec: 200 })` is invoked.
- **same-instance**: The wavesurfer instance reference is unchanged.

#### Test: audiotrack-uses-cached-peaks (covers R5)
**Given**: IDB contains peaks for `audioUrl`.
**When**: AudioTrack mounts.
**Then**:
- **peaks-passed-to-wavesurfer**: Wavesurfer is created with the cached peaks + duration.
- **no-redecode-write**: `exportPeaks` + cache write is NOT called on ready.

#### Test: audiotrack-writes-peaks-cache (covers R5)
**Given**: IDB is empty for the URL.
**When**: Wavesurfer fires `ready`.
**Then**:
- **peaks-persisted**: IDB record is written keyed by `audioUrl` with `{peaks, duration}`.

#### Test: audiotrack-cleans-up-on-unmount (covers R4)
**Given**: AudioTrack is mounted.
**When**: The component unmounts.
**Then**:
- **ws-destroyed**: `ws.destroy()` was called.
- **seek-ref-nulled**: `seekRef.current` is `null`.
- **playpause-ref-nulled**: `playPauseRef.current` is `null`.

#### Test: audiolane-positions-clip-block (covers R7)
**Given**: A clip `{start_time: 10, end_time: 12}` on a lane with `pxPerSec=100`.
**When**: The lane renders.
**Then**:
- **left-1000**: Block's computed `left` is `1000`.
- **width-200**: Block's computed `width` is `200`.

#### Test: audiolane-colors-music-purple (covers R8)
**Given**: A clip with `variant_kind='music'`.
**When**: Rendered.
**Then**:
- **purple-bg**: Block has `bg-purple-900/30`.

#### Test: audiolane-colors-foley-orange (covers R8)
**Given**: `variant_kind='foley'`.
**Then**:
- **orange-bg**: Block has `bg-orange-900/30`.

#### Test: audiolane-colors-lipsync-teal (covers R8)
**Given**: `variant_kind='lipsync'`.
**Then**:
- **teal-bg**: Block has `bg-teal-900/30`.

#### Test: audiolane-defaults-to-cyan (covers R8)
**Given**: `variant_kind=null`.
**Then**:
- **cyan-bg**: Block has `bg-cyan-900/30`.

#### Test: audiolane-mutes-clip-visually (covers R9)
**Given**: `clip.muted = true`.
**Then**:
- **opacity-40**: Block has class `opacity-40`.

#### Test: audiolane-mutes-track-visually (covers R9)
**Given**: `track.muted = true`.
**Then**:
- **lane-opacity-50**: Lane root has class `opacity-50`.

#### Test: audiolane-empty-click-selects-track (covers R10)
**Given**: A mounted `AudioLane`.
**When**: User clicks the lane outside any clip.
**Then**:
- **select-track-called**: `setSelectedAudioTrackId(track.id)` is called.

#### Test: audiolane-clip-click-delegates (covers R10)
**Given**: `onClipClick` is wired.
**When**: User clicks a clip (shiftKey=false).
**Then**:
- **delegate-called**: `onClipClick(clip, false)` fires.
- **no-context-select**: `setSelectedAudioClipId` is NOT called.

#### Test: audiolane-clip-click-fallback (covers R10)
**Given**: `onClipClick` is not wired.
**When**: User clicks a clip.
**Then**:
- **ctx-select-called**: `setSelectedAudioClipId(clip.id)` fires.

#### Test: audiolane-right-click-promotes (covers R11)
**Given**: `selectedIds` does NOT contain clip `C`.
**When**: User right-clicks `C`.
**Then**:
- **batch-includes-c**: The context-menu actions' `batchIds` includes `C.id`.

#### Test: audiolane-mute-batch (covers R11, R13)
**Given**: `selectedIds = {A, B}` all unmuted; user right-clicks A, picks "Mute 2 clips".
**Then**:
- **toggle-called**: `onRequestToggleMute([A.id, B.id], true)` fires.

#### Test: audiolane-unmute-batch (covers R13)
**Given**: User right-clicks a muted clip.
**Then**:
- **target-false**: `onRequestToggleMute(batchIds, false)` fires.

#### Test: audiolane-align-disabled-single (covers R12)
**Given**: Only one clip in `batchIds`.
**Then**:
- **align-disabled**: "Align waveforms" menu item is rendered `disabled`.
- **callback-not-called**: Clicking the item is a no-op.

#### Test: audiolane-left-trim-fires (covers R14)
**Given**: A clip wider than 12 px.
**When**: User `mousedown` on left 6 px strip.
**Then**:
- **left-trim**: `onClipTrimMouseDown(clip, 'left', e)` fires exactly once.

#### Test: audiolane-right-trim-fires (covers R14)
**Given**: Same.
**When**: User `mousedown` on right 6 px strip.
**Then**:
- **right-trim**: `onClipTrimMouseDown(clip, 'right', e)` fires.

#### Test: audiolane-trim-preview-left (covers R15)
**Given**: `trimPreview = {clipIds:{C}, edge:'left', offsetSeconds:0.5}` and clip C at start=10.
**When**: Rendered.
**Then**:
- **left-shift**: Block `left = (10+0.5) * pxPerSec`.
- **no-mutation**: `C.start_time` remains `10`.

#### Test: audiolane-trim-preview-right (covers R15)
**Given**: `trimPreview = {clipIds:{C}, edge:'right', offsetSeconds:-1.0}` and C with `end_time=12`.
**Then**:
- **right-shift**: Block's rendered end is `11 * pxPerSec`.

#### Test: audiolane-drag-transform (covers R16)
**Given**: `draggingIds={C}, dragOffsetSeconds=2, dragTrackDelta=1, laneHeight=56, pxPerSec=100`.
**Then**:
- **translate-200-56**: Block `transform` is `translate(200px, 56px)`.
- **pointer-events-none**: Block has `pointer-events: none`.

#### Test: audiolane-drop-pool-audio (covers R17, R18, R19)
**Given**: `onDropPoolAudio` wired.
**When**: User drops `application/x-scenecraft-pool-path` payload `"pool/audio/foo.wav"` at clientX corresponding to t=5 on a lane.
**Then**:
- **callback**: `onDropPoolAudio(track.id, 5, 'pool/audio/foo.wav')` fires.
- **drop-active-cleared**: `poolDropActive` is `false` after drop.

#### Test: audiolane-drop-stem (covers R17, R19)
**Given**: Stem payload JSON is valid and `onDropStem` wired.
**When**: Drop fires.
**Then**:
- **stem-callback**: `onDropStem(track.id, startTime, payload, clips)` fires.
- **clips-snapshot-passed**: The `clips` arg equals the current `track.clips`.

#### Test: audiolane-drop-bad-stem-swallowed (covers R19)
**Given**: Stem payload is `"{not-json"`.
**When**: Drop fires.
**Then**:
- **no-callback**: `onDropStem` is NOT called.
- **logged**: `console.error` was called once.
- **no-throw**: Drop handler does not throw.

#### Test: audiolane-header-drop-before (covers R24)
**Given**: User drags track A over track B; release on top half.
**Then**:
- **reorder-before**: `onRequestReorderTracks(A.id, B.id, 'before')` fires.

#### Test: audiolane-header-drop-after (covers R24)
**Given**: Release on bottom half.
**Then**:
- **reorder-after**: `onRequestReorderTracks(A.id, B.id, 'after')` fires.

#### Test: audiolane-rename-commits (covers R25)
**Given**: User double-clicks name, types "Vocals", presses Enter.
**Then**:
- **update-called**: `onUpdateTrack(track.id, {name:'Vocals'})` fires.

#### Test: audiolane-rename-cancels (covers R25)
**Given**: User enters edit mode, types, presses Escape.
**Then**:
- **no-update**: `onUpdateTrack` NOT called.
- **draft-reverted**: Displayed name equals original.

#### Test: audiolane-rename-noop-empty (covers R25)
**Given**: User commits empty or unchanged name.
**Then**:
- **no-update**: `onUpdateTrack` NOT called.

#### Test: resolve-deletes-consumed (covers R20)
**Given**: `existing = [{start:1, end:3, source_offset:0, ...}]`, `dropped={start:0, end:4}`.
**Then**:
- **single-op**: Returns one op.
- **delete-op**: Op is `{op:'delete', id:...}`.

#### Test: resolve-left-trim-advances-source-offset (covers R20)
**Given**: `existing=[{start:1, end:5, source_offset:10}]`, `dropped={start:0, end:3}`.
**Then**:
- **trim-start-3**: Op has `start_time = 3`.
- **offset-12**: Op has `source_offset = 10 + (3 - 1) = 12`.

#### Test: resolve-right-trim-preserves-source-offset (covers R20)
**Given**: `existing=[{start:1, end:5, source_offset:10}]`, `dropped={start:4, end:7}`.
**Then**:
- **trim-end-4**: Op has `end_time = 4`.
- **no-offset-field**: Op does NOT include `source_offset`.

#### Test: resolve-split-inside (covers R20)
**Given**: `existing=[{id:X, start:0, end:10, source_offset:5, source_path:'p', track_id:'T'}]`, `dropped={start:3, end:6}`, `genId()='NEW'`.
**Then**:
- **two-ops**: Returns exactly two ops.
- **trim-left**: First op is `{op:'trim', id:X, end_time:3}`.
- **insert-right**: Second op is `{op:'insert', clip:{id:'NEW', track_id:'T', source_path:'p', start_time:6, end_time:10, source_offset: 5 + (6 - 0) = 11, ...}}`.

#### Test: resolve-skip-non-overlapping (covers R20)
**Given**: Existing clip ends exactly at or before `dropped.start`, OR starts at or after `dropped.end`.
**Then**:
- **no-ops**: No ops emitted for that clip.

#### Test: resolve-omits-terminal-insert (covers R21)
**Given**: Any overlap.
**Then**:
- **no-self-insert**: None of the returned ops is an `insert` whose clip fields match the dropped range end-to-end (other than the right-half split, which has a different `start_time`).

#### Test: resolve-is-pure (covers R22)
**Given**: A deep clone `E'` of `existing`.
**When**: `resolveOverlapsWithSplit(dropped, existing, genId)` is called.
**Then**:
- **input-unchanged**: `existing` deep-equals `E'`.

### Edge Cases

#### Test: audiotrack-swallows-idb-errors (covers R5)
**Given**: `indexedDB.open` throws or `getCachedPeaks` rejects.
**When**: AudioTrack mounts.
**Then**:
- **mount-succeeds**: Component renders; `<audio>` still created.
- **no-unhandled-rejection**: No unhandled-promise-rejection event fires.

#### Test: audiolane-unknown-variant-falls-back (covers R8)
**Given**: `variant_kind='totally-bogus'`.
**Then**:
- **cyan-bg**: Block has `bg-cyan-900/30` (default palette).

#### Test: audiolane-narrow-clip-no-trim-zones (covers R14)
**Given**: Clip with rendered `width=10px`.
**Then**:
- **no-left-zone**: Left trim strip is not in the DOM.
- **no-right-zone**: Right trim strip is not in the DOM.

#### Test: audiolane-ignores-foreign-drag (covers R17)
**Given**: A drag whose types are `['application/x-some-other-thing']`.
**When**: `dragover` fires.
**Then**:
- **no-prevent-default**: `event.defaultPrevented` is `false`.
- **no-drop-active-paint**: `poolDropActive` stays `false`.

#### Test: audiolane-drop-scroll-aware (covers R18)
**Given**: Lane is inside a horizontally-scrolled container with `scrollLeft=400`; drop at `clientX=laneLeft+100`; `pxPerSec=100`.
**When**: Drop fires.
**Then**:
- **startTime-5**: Callback `startTime` argument is `(100 + 400) / 100 = 5`.

#### Test: audiolane-drop-scroll-clamps-to-zero (covers R18)
**Given**: Drop at `clientX < laneLeft` (cursor past left edge).
**Then**:
- **startTime-nonnegative**: `startTime >= 0`.

#### Test: audiolane-header-drop-self-noop (covers R24)
**Given**: User drags a track onto itself.
**Then**:
- **no-reorder-call**: `onRequestReorderTracks` NOT called.

#### Test: audiolane-header-drag-source (covers R23)
**Given**: User starts drag on the `A{n}` prefix badge.
**Then**:
- **mime-set**: dataTransfer has `application/x-audio-track-id = track.id`.
- **effect-move**: `effectAllowed='move'`.
- **wrapper-not-draggable**: The header wrapper element has no `draggable` attribute (drag eating M/S clicks regression guard).

#### Test: audiolane-headerless-mode (covers R26)
**Given**: `headerless=true`.
**Then**:
- **no-header-dom**: The sticky header block is not rendered.
- **clips-rendered**: Clips still render.
- **drop-still-works**: Pool-path drop still invokes `onDropPoolAudio`.

#### Test: audiolane-renders-ghosts (covers R27)
**Given**: `ghosts = [{startTime:1, endTime:2}]`.
**Then**:
- **ghost-in-dom**: One ghost element rendered.
- **z-30**: It has class `z-30`.
- **pointer-events-none**: It has `pointer-events-none`.

#### Test: audiolane-selection-beats-highlight (covers R28)
**Given**: Clip is both `selected` and `highlighted`.
**Then**:
- **selected-border**: Block has `borderSelected` class.
- **no-yellow-glow**: Block does NOT have yellow ring/shadow classes.

#### Test: audiotrack-is-single-audio-element (covers R1, R3)
**Given**: AudioTrack mount → same `audioUrl` re-render → unmount.
**Then**:
- **only-one-audio**: Exactly one `new Audio()` was constructed for that URL.
- **refs-not-double-wired**: `seekRef.current` was set exactly twice (once on `canplay`, once on `ready`) — not three times.

#### Test: audiotrack-is-synchronous-playback-master (covers R3, R4)
**Given**: No concurrency primitives are expected; audio element callbacks are main-thread.
**Then**:
- **no-worker-usage**: AudioTrack does not spawn Web Workers or AudioWorklet nodes.
- **no-shared-array-buffer**: No SharedArrayBuffer usage.

*(Negative assertion: locks future refactors from silently introducing concurrency without updating this spec.)*

## Non-Goals

- Spec does NOT define the mixer graph (see `local.webaudio-mixer-and-mix-graph` target).
- Spec does NOT define waveform-peak computation or fetch (see waveform-cache spec target).
- Spec does NOT define backend SQL for `audio_clips` / `audio_candidates` (see pool-segments spec target).
- Spec does NOT define the `batch-ops` REST endpoint (only the ops it consumes).
- Spec does NOT define Timeline's cross-lane drag state machine (AudioLane only exposes mousedown hooks).
- Spec does NOT guarantee that left-trim advancing `source_offset` produces sample-accurate alignment with the underlying audio file (mixer spec owns that invariant).
- Spec does NOT cover `BatchOp.split`, which is declared but currently unused by `resolveOverlapsWithSplit`.

## Open Questions

- **OQ-1** — Drop exactly at existing clip boundary (`dropped.start === c.end_time`): The predicate `!(c.end_time <= dropped.start || c.start_time >= dropped.end)` evaluates `overlaps = false` at exact touch, so no op is emitted. Is this the intended behavior (touch = no overlap), or should adjacency trigger a merge/crossfade? Not decided.
- **OQ-2** — Trim to zero duration: If a left-trim advances `start_time` past `end_time` (or vice versa for right-trim), the resulting clip has `end_time <= start_time`. Resolver does not guard. Should callers clamp, should the resolver emit `delete` instead, or should zero-duration be a permitted transient state?
- **OQ-3** — Drop onto muted track: Current code accepts the drop and fires callbacks unchanged — muting is purely visual. Should drop be prevented, or should the new clip be auto-muted to match the track's state?
- **OQ-4** — Drop of non-audio pool_segment: `AudioLane` accepts any `application/x-scenecraft-pool-path` regardless of segment kind (video, image, etc.). `onDropPoolAudio` is invoked with the raw path; the backend decides. Should `AudioLane` pre-validate the MIME/kind, or is backend-side rejection the contract?
- **OQ-5** — AudioTrack unmount mid-playback: Refs are nulled on unmount; `CurrentTimeContext`'s last `currentTime` persists. Audit §3 leak #3 flags this as a known coupling issue. Is the contract "playback stalls silently" or "playhead is reset"? Currently unspecified.
- **OQ-6** — Clip spans negative time: Renderer produces negative `left`; no clamp. Is this allowed input (bug-tolerance) or a precondition violation?
- **OQ-7** — `source_offset` negative after left-trim: Given the resolver formula `c.source_offset + (dropped.end - c.start_time)` and the overlap precondition (`dropped.end > c.start_time`), the delta is always positive and the result is always `>= c.source_offset`. A negative result is only reachable if `c.source_offset` is already negative — which itself is undefined. Should resolver clamp to `0` or error?

## Related Artifacts

- Audit: `agent/reports/audit-2-architectural-deep-dive.md` §1D unit 6, §1E unit 12, §3 leak #3
- Source: `src/components/editor/AudioLane.tsx`, `src/components/editor/AudioTrack.tsx`, `src/lib/audio-overlap.ts`, `src/lib/audio-clip-styling.ts`
- Related spec targets (fan-out list):
  - `local.timeline-composition-and-playback-loop` (owns `seekRef` consumer + playhead)
  - `local.webaudio-mixer-and-mix-graph` (owns bit-identical live/offline audio)
  - `local.waveform-cache-and-rendering`
  - `local.pool-segments-and-variant-kind` (owns `variant_kind` DB invariant)

---

**Namespace**: local
**Spec**: audio-lane-and-clip-editing
**Version**: 1.0.0
**Created**: 2026-04-27
**Status**: Active (retroactive)
