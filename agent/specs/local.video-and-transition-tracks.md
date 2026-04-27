# Spec: VideoTrack and TransitionTrack Components

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Retroactive (Draft — proofing pass required)

---

## Purpose

Define the exact observable behavior of the two timeline row components that render the keyframe+transition video plane: `VideoTrack` (keyframe clip cells; drop targets for video/image pool_segments) and `TransitionTrack` (transition bars with edge-trim/roll handles, body-drag move/copy, overlap previews, filmstrip thumbnails, and drop target for video pool_segments).

## Source

- **Mode**: Retroactive (`--from-draft` equivalent — code is the source of truth)
- **Primary code**:
  - `/home/prmichaelsen/.acp/projects/scenecraft/src/components/editor/VideoTrack.tsx` (148 LOC, full)
  - `/home/prmichaelsen/.acp/projects/scenecraft/src/components/editor/TransitionTrack.tsx` (1200 LOC)
  - `/home/prmichaelsen/.acp/projects/scenecraft/src/components/editor/TransitionFilmstrip.tsx` (105 LOC)
- **Architectural context**: `agent/reports/audit-2-architectural-deep-dive.md` §1D units 4–5 + §3 leak #4

---

## Scope

### In scope
- `VideoTrack` props contract, keyframe cell rendering, viewport culling, click/shift-click selection, pool-path and staging-path drop.
- `TransitionTrack` props contract; transition bar rendering (selected/hidden/highlighted variants); boundary-zone handles (`[>` trim-in, `<]` trim-out, `<|>` roll) with Shift (ripple) and Cmd/Ctrl (remap) modifiers; bounds derived from neighboring keyframes and source-video extents; persistence via `postUpdateTransitionTrim` / `postClipTrimEdge`.
- Body-drag gesture: single or multi-clip, move or copy (Cmd/Ctrl), cross-track via DOM hit-test on `[data-track-id]`, ghost overlay via `createPortal`, published previews (`onTargetTracksChange`, `onOverlapPreviewChange`, `onGhostOverflowChange`), Escape-to-cancel, commit via `postMoveTransitions`, `autoCreateTracks:true`.
- Overlap preview classification (four cases A/B/C/D) and overlay rendering on each affected transition.
- Pool-path drop on transition (`application/x-scenecraft-pool-path`, optional `application/x-scenecraft-source-tr`).
- `TransitionFilmstrip` thumbnail rendering: auto-measured height, thumb-count math, silent skip conditions.

### Out of scope
- Timeline orchestration (seek, playhead, pxPerSec calc, scrollLeft source, track ordering) — see `local.timeline-composition-and-playback-loop`.
- AudioLane / audio clips — see `local.audio-lane-and-clip-editing`.
- `pool_segments` schema, variant_kind, drag source provenance — see `local.pool-segments-and-variant-kind`.
- Backend endpoints (`postUpdateTransitionTrim`, `postClipTrimEdge`, `postMoveTransitions`, `/filmstrip`) — referenced only, specced separately.
- Keyframe and transition data shapes beyond what these components read.

---

## Interfaces

### VideoTrack props
```ts
type VideoTrackProps = {
  keyframes: KeyframeWithTime[]        // sorted by timeSeconds
  pxPerSec: number
  projectName: string
  selectedId: string | null            // current primary selection
  selectedIds: Set<string>             // multi-select set
  duration: number                     // timeline duration; used for tail-cell width fallback
  onKeyframeClick: (kf, shiftKey?: boolean) => void
  scrollRef: RefObject<HTMLDivElement | null>
  scrollLeft: number                   // viewport scroll offset, px
  viewportWidth: number                // visible px
  onDropVideo?: (keyframeId, poolPath) => void
  onDropImage?: (keyframeId, imagePath) => void
  onDropStagedImage?: (keyframeId, stagingId, variant) => void
}
```

### TransitionTrack props (abbreviated — see source for full comments)
```ts
type TransitionTrackProps = {
  transitions: Transition[]            // this row's transitions
  keyframes: KeyframeWithTime[]        // this row's keyframes
  allTransitions?: Transition[]        // project-wide, for body-drag
  allKeyframes?: KeyframeWithTime[]
  tracks?: Track[]                     // sorted, for track-delta math
  trackRowHeight?: number              // default 96 px
  onTargetTracksChange?: (ids | null) => void
  onOverlapPreviewChange?: (OverlapPreview | null) => void
  onGhostOverflowChange?: (GhostOverflow | null) => void
  overlapPreview?: OverlapPreview | null     // from Timeline; renders per-tr overlays
  pxPerSec: number
  selectedId: string | null
  highlightedId?: string | null        // yellow linked-to-selected glow (Task 124)
  duration: number
  projectName?: string
  onTransitionClick: (tr, shiftKey?) => void
  selectedIds?: Set<string>
  onTrimChange?: () => void            // parent refresh after trim persists
  onAfterBodyDrag?: (opts: { timeDelta, trackDelta, draggedTransitionIds }) => void
  onRetryRender?: (tr) => void
  onDropVideo?: (trId, poolPath, sourceTrId?) => void
  renderProgress?: Record<string, number>  // 0..1 per transition id
  scrollLeft: number
  viewportWidth: number
  isActiveTrack?: boolean              // false disables body-drag + boundary handles
}

type OverlapPreview = {
  consumedIds: string[]
  trimmedLeftIds: { id: string; boundaryX: number }[]
  trimmedRightIds: { id: string; boundaryX: number }[]
  splitInsideIds: { id: string; leftX: number; rightX: number }[]
}

type GhostOverflow = { topCount: number; bottomCount: number }
```

### DnD MIME types consumed
- `application/x-scenecraft-pool-path` — pool segment path (file ext discriminates image vs video)
- `application/x-scenecraft-staging-path` — staged image (VideoTrack only)
- `application/x-scenecraft-staging-id` + `application/x-scenecraft-variant` — staged image drop (VideoTrack)
- `application/x-scenecraft-source-tr` — optional source-transition id (TransitionTrack body drop)

### TransitionFilmstrip URL
`GET {SCENECRAFT_API_URL}/api/projects/{project}/transitions/{trId}/filmstrip?t={seconds}&height={px}`

---

## Requirements

### VideoTrack

- **R1**. Renders one cell per keyframe spanning `[kf.timeSeconds, next.timeSeconds] * pxPerSec`; the final cell's width is `60 px` when no next keyframe exists.
- **R2**. Viewport-culls cells whose rendered span falls outside `[scrollLeft - 300px, scrollLeft + viewportWidth + 300px]` (returns `null`).
- **R3**. A cell is visually selected when `kf.id === selectedId` or `selectedIds.has(kf.id)` (teal ring + tint).
- **R4**. Left-click on a cell calls `onKeyframeClick(kf, e.shiftKey)` and stops event propagation.
- **R5**. Shows the keyframe thumbnail (`selected_keyframes/{id}.png?v={kf.selected}`) only when `kf.hasSelectedImage` and cell width > 20 px; otherwise shows a placeholder with the kf id.
- **R6**. Accepts drop of `application/x-scenecraft-pool-path`:
  - If path matches `/\.(png|jpg|jpeg|webp)$/i` and `onDropImage` is provided → `onDropImage(kf.id, path)`.
  - Otherwise if `onDropVideo` is provided → `onDropVideo(kf.id, path)`.
- **R7**. Accepts staged-image drop when both `application/x-scenecraft-staging-id` and `application/x-scenecraft-variant` are present and `onDropStagedImage` is provided → `onDropStagedImage(kf.id, stagingId, parseInt(variant, 10))`.
- **R8**. Drop highlighting (green tint + ring) only activates when `dataTransfer.types` includes `application/x-scenecraft-pool-path` OR `application/x-scenecraft-staging-path`; other drag types are ignored (no `preventDefault`, no visual feedback).
- **R9**. `onDragLeave` clears the drop target only when the leaving cell is the current drop target (prevents flicker when hovering children).

### TransitionTrack — rendering

- **R10**. Renders a bar per transition from `fromKf.time*pxPerSec + 3` to `toKf.time*pxPerSec`, height = full row, bar body = bottom 12 px (`h-3`).
- **R11**. Skips bars with missing `fromKf` or `toKf` or non-positive width.
- **R12**. Viewport-culls bars outside `[scrollLeft - 300, scrollLeft + viewportWidth + 300]`.
- **R13**. Selected bars use orange ring; highlighted (linked-to-selected) non-selected bars use yellow ring + glow; hidden transitions use dashed yellow style.
- **R14**. When `renderProgress[tr.id]` is set, renders a progress fill at the bar top; clicking it calls `onRetryRender(tr)`.
- **R15**. Renders `TransitionFilmstrip` inside each bar when `projectName` is set; filmstrip is visual-only (`pointer-events: none`).

### TransitionTrack — boundary-zone trim handles

- **R16**. On each bar, three 8-px-wide zones are rendered when `isActiveTrack !== false`:
  - `[>` trim-in at left edge → calls `handleBoundaryDown('trim-in', fromKf, leftNeighborTr, thisTr)`.
  - `<]` trim-out at right edge → `handleBoundaryDown('trim-out', toKf, thisTr, rightNeighborTr)`.
  - `<|>` rolling edit (5 px, offset `-2px`) rendered only when a `rightTr` neighbor exists at `tr.to`.
- **R17**. Modifier behavior captured at mousedown (held through gesture):
  - Plain drag: trim; preserves clip speed factor of the affected side(s).
  - Shift: ripple trim (`mode: 'ripple'` on `postClipTrimEdge`).
  - Cmd/Ctrl (not both with Shift): remap — move shared kf only via `postUpdateTransitionTrim` with the relevant `{from,to}KfTimestamp` field.
- **R18**. Drag bounds (per `handleBoundaryDown`):
  - `minTime = prevKf.time + 0.1` (or 0).
  - `maxTime = nextKf.time − 0.1` (or `duration || Infinity`).
  - `trim-out` further clamps `maxTime` so left clip's `trimOut` cannot exceed `sourceVideoDuration`, converted through current speed factor.
  - `trim-in` further clamps `minTime` so right clip's `trimIn` cannot fall below 0.
  - **Any resulting clip span is additionally clamped to a 1-frame minimum (≈ 0.0333s at 30fps) so no clip collapses to zero/negative duration.**
- **R19**. Drag is considered "did drag" only if `|deltaX| > 2 px`; on no-drag mouseup the synthetic click is allowed to propagate normally.
- **R20**. On drag commit (`didDrag && projectName`):
  - Remap: `postUpdateTransitionTrim(projectName, { transitionId, {from|to}KfTimestamp })` on `leftTr ?? rightTr`.
  - `trim-out`: `postClipTrimEdge(projectName, { transitionId: leftTr.id, edge: 'right', newBoundaryTimestamp, newTrim, mode })`.
  - `trim-in`: `postClipTrimEdge(projectName, { transitionId: rightTr.id, edge: 'left', newBoundaryTimestamp, newTrim, mode })`.
  - `roll`: two parallel `postUpdateTransitionTrim` calls (one per neighbor), each with the recomputed trim plus shared-kf timestamp; Shift is ignored (roll ≠ ripple).
- **R21**. After commit (success or failure), `onTrimChange?.()` fires and `dragPreview` is cleared; post-drag synthetic click is swallowed via a one-shot capture-phase click listener.
- **R22**. Live drag preview (`dragPreview`) renders a colored vertical line at `newKfTime * pxPerSec` (purple for roll, cyan otherwise) with a tooltip showing zone glyph, modifier label, `Δs`, and trim values. Preview is viewport-culled.
- **R23**. If `projectName` is missing at commit, logs an error and skips persist (state still clears).

### TransitionTrack — body drag (move/copy)

- **R24**. Body-drag initiates on `onMouseDown` of the bar interior when `isActiveTrack !== false` and `e.button === 0`. Boundary-zone handles `stopPropagation` in their own `onMouseDown`, so body-drag does not fire from them.
- **R25**. Gesture scope:
  - If `tr.id ∈ selectedIds` → drag entire selection.
  - Else → drag only the clicked transition.
- **R26**. Mode:
  - `copy` when Cmd or Ctrl held at mousedown; else `move`.
- **R27**. Drag "locks" when `hypot(dx, dy) ≥ 4 px`; below threshold the gesture is treated as a click.
- **R28**. `timeDelta` is clamped so `min(clip.fromTimeSeconds) + delta ≥ 0` (no clip can start before t=0). Unbounded in the positive direction. On the same track, `timeDelta` is additionally clamped so a clip's moved span cannot cross an adjacent keyframe on the same track (clamp to adjacent-keyframe edge).
- **R29**. `trackDelta` is computed by DOM hit-test: walk up from `elementFromPoint(clientX, clientY)` looking for `[data-track-id]`; the delta is `hitIndex − primary.sourceTrackIndex`. **When the cursor is not over a track row, `trackDelta` holds its last-known value** (does not reset to 0). Unclamped: values outside `[0, numTracks-1]` indicate overflow onto auto-created tracks.
- **R30**. Per mousemove (throttled via `requestAnimationFrame`), `TransitionTrack` publishes:
  - `onTargetTracksChange(Set<track_id>)` — set of existing-track ids receiving at least one dropped clip.
  - `onOverlapPreviewChange(OverlapPreview)` — classification per existing transition on each target track:
    - Case A (fully inside drop span) → `consumedIds`.
    - Case B (drop's `new_from` lands inside target) → `trimmedLeftIds` with `boundaryX = new_from * pxPerSec`.
    - Case C (drop's `new_to` lands inside target) → `trimmedRightIds` with `boundaryX = new_to * pxPerSec`.
    - Case D (drop fully inside target) → `splitInsideIds` with `leftX, rightX` in px.
  - `onGhostOverflowChange({ topCount, bottomCount })` — counts of auto-create "new track" rows above/below stack.
  - Classification uses `EPS = 0.001 s` to avoid boundary-touching false positives. Dragged clips and `hidden` transitions are excluded from overlap candidates.
- **R31**. Ghost overlay is rendered via `createPortal` to `document.body`, fixed-positioned at `(cursorX+4, cursorY+4)`:
  - One rect per dragged clip; offsets = `(clip.fromTime - primary.fromTime) * pxPerSec` horizontal, `(clip.sourceTrackIndex - primary.sourceTrackIndex + trackDelta) * rowHeight` vertical.
  - Copy mode: green tint on rects + green `+` badge on primary rect.
  - Move mode: orange tint.
  - Tooltip above primary rect: `{fromTs} → {toTs} · {targetTrackName} · Δ±{s}s[· Nclips | +N copies][· N consumed][· N split][· +N new tracks]`.
  - `targetTrackName` is `tracks[primaryTargetIndex].name` when in range, `"Track N"` fallback, `"New track"` when overflowing.
- **R32**. Mouseup commits only if drag locked AND `|timeDelta| ≥ 0.01 s || trackDelta ≠ 0`:
  - Calls `postMoveTransitions(projectName, { mode, trackDelta, timeDeltaSeconds, transitionIds, autoCreateTracks: true })`.
  - Then `onAfterBodyDrag({ timeDelta, trackDelta, draggedTransitionIds })` (Timeline uses this to shift un-linked selected audio clips).
  - Then `onTrimChange()`.
  - On error: logs, does not clear `didDrag` suppression.
- **R33**. Escape during drag cancels: no backend call, visuals clear, synthetic click suppressed if any.
- **R34**. Unmount during drag releases `document.body.style.cursor` and cancels any pending RAF.
- **R35**. Overlap overlays (from the `overlapPreview` prop, which Timeline pipes back from `onOverlapPreviewChange`) are rendered on EVERY transition in EVERY TransitionTrack row:
  - Consumed → full-bar red tint.
  - Trimmed-left (Case B) → red tint from `boundaryX` to bar right edge.
  - Trimmed-right (Case C) → red tint from bar left edge to `boundaryX`.
  - Split-inside (Case D) → two vertical blue split lines.
  - Overlays are `pointer-events: none`.

### TransitionTrack — pool-path drop

- **R36**. Bar body accepts drop of `application/x-scenecraft-pool-path`:
  - `onDragOver` sets dropEffect `'copy'` and marks `dropTarget = tr.id` only when that MIME is present AND the path is a video kind (ext matches `/\.(mp4|mov|webm|mkv|avi|m4v)$/i`).
  - `onDrop` calls `onDropVideo(tr.id, poolPath, sourceTrId)` only when the path is a video kind; non-video drops are rejected (no callback).
  - Non-video pool segments (images, audio) surface a brief rejection indicator (red tint during drag; no drop target on drop).

### TransitionTrack — click vs drag disambiguation

- **R37**. On a plain click (no body-drag lock and no boundary drag) → `onTransitionClick(tr, e.shiftKey)` and `stopPropagation`.
- **R38**. When `didDrag` is true at click time, the click is swallowed and `didDrag` resets.

### TransitionFilmstrip

- **R39**. Skips rendering (returns empty spacer) when any of:
  - `transition.hasSelectedVideo` is false.
  - `transition.sourceVideoDuration` is null or ≤ 0.
  - measured container height < 16 px.
  - `fitCount < 2` (block too narrow for ≥2 thumbs) OR computed `thumbWidth < minThumbWidthPx (32)`.
  - `sourceSpan = trimOut − trimIn ≤ 0`.
- **R40**. Thumb count `n = min(floor(blockWidth / thumbWidth), maxThumbs=12)`.
- **R41**. Samples at `t = trimIn + i * (sourceSpan / (n-1))` for i in `[0, n)`; hits `/filmstrip?t=...&height=...`.
- **R42**. Image `onError` hides (`visibility: hidden`) the broken thumb; does not retry or log.
- **R43**. `ResizeObserver` remeasures height; re-renders with new thumbHeight/thumbWidth on row-height change.

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | VideoTrack renders cell per keyframe | Width spans to next kf, last cell is 60px | `video-track-renders-one-cell-per-keyframe`, `video-track-tail-cell-default-width` |
| 2 | VideoTrack cell outside viewport | Not rendered | `video-track-culls-offscreen-cells` |
| 3 | VideoTrack left-click a cell | Calls onKeyframeClick with shiftKey; stops propagation | `video-track-click-fires-callback` |
| 4 | VideoTrack drop image pool-path on cell | Calls onDropImage | `video-track-drop-image` |
| 5 | VideoTrack drop video pool-path on cell | Calls onDropVideo | `video-track-drop-video` |
| 6 | VideoTrack drop staged image | Calls onDropStagedImage with parsed variant | `video-track-drop-staged-image` |
| 7 | VideoTrack drag of unknown MIME | No visual feedback, drop ignored | `video-track-ignores-unknown-mime` |
| 8 | VideoTrack selected by id or id-set | Shows teal ring | `video-track-selected-styling` |
| 9 | VideoTrack thumb when cell < 20px | Placeholder only, no img | `video-track-no-thumb-when-narrow` |
| 10 | TransitionTrack renders bar from→to | Bar spans `[fromX+3, toX]` | `transition-track-renders-bars` |
| 11 | Transition missing kf endpoints | Bar not rendered | `transition-track-skips-missing-kfs` |
| 12 | Bar outside viewport | Not rendered | `transition-track-culls-offscreen-bars` |
| 13 | Hover trim-in handle → drag right | Persists via postClipTrimEdge edge:'left', mode:'trim' | `trim-in-drag-persists` |
| 14 | Hover trim-out handle → drag left | Persists via postClipTrimEdge edge:'right', mode:'trim' | `trim-out-drag-persists` |
| 15 | Shift+drag trim-out | Persists with mode:'ripple' | `trim-out-ripple` |
| 16 | Cmd+drag boundary | Remap: postUpdateTransitionTrim with kf timestamp only | `boundary-remap` |
| 17 | Rolling edit drag (shared boundary) | Two postUpdateTransitionTrim calls in parallel | `roll-edit-persists` |
| 18 | Trim past neighbor kf | Clamped at `neighbor ± 0.1s` | `trim-clamps-to-neighbor-kf` |
| 19 | Trim-out past sourceVideoDuration | Clamped via speed-adjusted maxExtend | `trim-out-clamps-to-source-video` |
| 20 | Trim-in below trimIn=0 | Clamped via speed-adjusted maxRetreat | `trim-in-clamps-to-zero` |
| 21 | Boundary mousedown without movement | No drag, click handler runs normally | `boundary-click-no-drag` |
| 22 | Trim commit with missing projectName | Error logged, no persist, preview clears | `trim-commit-no-project-name` |
| 23 | Body-drag unselected transition | Drags only that clip | `body-drag-single-clip` |
| 24 | Body-drag selected transition | Drags all selectedIds | `body-drag-multi-clip` |
| 25 | Body-drag with Cmd held | Mode copy; green tint + `+` badge on ghost | `body-drag-copy-mode` |
| 26 | Body-drag movement < 4px | Not locked; click still fires | `body-drag-threshold` |
| 27 | Body-drag timeDelta into negative | Clamped so min(from)+delta ≥ 0 | `body-drag-clamps-to-zero` |
| 28 | Body-drag cursor off all track rows | trackDelta holds last-known value (not reset to 0) | `body-drag-holds-last-track-delta` |
| 29 | Body-drag past top of stack | Reports topCount overflow; renders "New track" tooltip | `body-drag-overflow-top` |
| 30 | Body-drag overlaps existing tr fully | Preview consumed; red full-bar overlay on target | `overlap-case-a-consumed` |
| 31 | Body-drag new_from inside target | Preview trimmedLeft; red tint on right portion | `overlap-case-b-trim-left` |
| 32 | Body-drag new_to inside target | Preview trimmedRight; red tint on left portion | `overlap-case-c-trim-right` |
| 33 | Body-drag fully inside target | Preview splitInside; two blue split lines | `overlap-case-d-split` |
| 34 | Body-drag over hidden transition | Hidden trs excluded from overlap classification | `overlap-skips-hidden` |
| 35 | Body-drag Escape | State cleared; no postMoveTransitions | `body-drag-escape-cancels` |
| 36 | Body-drag mouseup with no net delta | No backend call | `body-drag-no-op-mouseup` |
| 37 | Body-drag mouseup success | postMoveTransitions; onAfterBodyDrag; onTrimChange in order | `body-drag-commit` |
| 38 | Body-drag mouseup error | Logs; does not throw; visuals cleared | `body-drag-commit-error` |
| 39 | Body-drag mid-gesture unmount | cursor reset; RAF cancelled | `body-drag-unmount-cleanup` |
| 40 | Drop video pool-path on bar | Calls onDropVideo(trId, path, sourceTrId?) | `transition-drop-video` |
| 41 | Transition click after drag | Click swallowed; didDrag resets | `transition-click-after-drag-swallowed` |
| 42 | Transition click no drag | onTransitionClick fires with shiftKey | `transition-click-plain` |
| 43 | Filmstrip bar width fits ≥2 thumbs | Renders n thumbs at even intervals | `filmstrip-renders` |
| 44 | Filmstrip narrow bar | Renders empty spacer | `filmstrip-narrow-skips` |
| 45 | Filmstrip no selected video | Renders empty spacer | `filmstrip-no-video-skips` |
| 46 | Filmstrip thumb 404 | Hides that thumb silently | `filmstrip-thumb-error-hides` |
| 47 | isActiveTrack=false | Body-drag & boundary handles disabled; click still works | `inactive-track-disables-drag` |
| 48 | Highlighted but not selected | Yellow glow (distinct from orange selected ring) | `highlight-vs-select-distinct` |
| 49 | renderProgress set | Progress bar rendered; click retries | `render-progress-retry` |
| 50 | Trim drag to zero timeline duration | Clamped to 1 frame minimum (assuming 30fps ≈ 0.0333s) before persist; resolver never produces ≤0-duration result | `trim-clamps-to-one-frame-min` |
| 51 | Body-drag past adjacent keyframe on same track | Clamped at adjacent-keyframe edge (cannot cross a same-track keyframe boundary) | `body-drag-clamps-to-adjacent-keyframe` |
| 52 | Drop non-video pool segment (audio/image) on transition | Client-side MIME/kind validation rejects: `onDropVideo` NOT called for non-video kinds | `transition-drop-rejects-non-video` |
| 53 | Snap target missing (no beats/sections detected) | **Deferred**: snap feature not shipped; revisit when it is | → [OQ-4](#open-questions) |
| 54 | Drag initiated while candidate render in progress | Drag allowed; render-state UI shows in-progress indicator on the transition; not blocked | `drag-during-candidate-render-allowed` |
| 55 | Body-drag of mixed selection across tracks with multi-select | **Deferred**: multi-select body-drag not supported; single-clip drag only | → [OQ-6](#open-questions) |
| 56 | VideoTrack multi-select drag | **Deferred**: no drag gesture implemented on VideoTrack | → [OQ-7](#open-questions) |
| 57 | Body-drag cursor leaves all track rows mid-gesture | `trackDelta` holds the last-known value (not reset to 0) until cursor re-enters a row | `body-drag-holds-last-track-delta` |

---

## Behavior (step-by-step)

### VideoTrack render pass
1. For each `kf` in `keyframes`: compute `x = kf.timeSeconds * pxPerSec`, `nextX = nextKf ? nextKf.timeSeconds * pxPerSec : x+60`, `width = max(nextX-x, 2)`.
2. Cull if `nextX < scrollLeft-300 || x > scrollLeft+viewportWidth+300`.
3. Render cell; thumbnail if `kf.hasSelectedImage && width > 20`, else placeholder.
4. Selected styling overlays iff `kf.id === selectedId || selectedIds.has(kf.id)`.

### VideoTrack drop
1. `onDragOver`: if MIME set contains `application/x-scenecraft-pool-path` or `application/x-scenecraft-staging-path` → `preventDefault`, set `dropEffect='copy'`, `setDropTarget(kf.id)`.
2. `onDrop`:
   - Read `pool-path`; classify by ext → `onDropImage` or `onDropVideo`.
   - Else read `staging-id` + `variant` → `onDropStagedImage`.

### TransitionTrack boundary-zone drag
1. Mousedown on a zone captures `isRipple = shiftKey`, `isRemap = metaKey||ctrlKey`, computes `minTime`/`maxTime` from neighbor kfs and source-video extents.
2. Mousemove: compute `newKfTime`, derive `leftTrimOut`/`rightTrimIn` via speed factor; update live `dragPreview`.
3. Mouseup: if `didDrag`, dispatch per-zone-per-mode persist call; fire `onTrimChange()`; clear `dragPreview`; swallow next synthetic click.
4. On mouseup with no drag → just clear `dragPreview`.

### TransitionTrack body-drag
1. Mousedown captures selection-or-single set, snapshots `DraggedClipInfo` per clip, stashes in `bodyDragState` ref.
2. Mousemove: pass `hypot≥4` threshold, then every frame compute `timeDelta`/`trackDelta`, publish `onTargetTracksChange`, `onOverlapPreviewChange`, `onGhostOverflowChange`; RAF-commit `GhostState` for ghost render.
3. Overlap classification: skip dragged & hidden; build per-track list of other trs; loop over `bodyDragState.clips` and each existing tr, check four cases with EPS=0.001.
4. Escape → cleanup, no commit.
5. Mouseup: if not locked → cleanup and let click through. If locked and delta significant → `postMoveTransitions` → `onAfterBodyDrag` → `onTrimChange`.

### TransitionFilmstrip
1. Measure container via `ResizeObserver`; bail if h<16.
2. Compute `thumbWidth = round(h * aspect)`, `fitCount = floor(blockWidth/thumbWidth)`.
3. Bail if `fitCount<2 || thumbWidth<minThumbWidthPx || sourceSpan<=0`.
4. Emit `n = min(fitCount, 12)` img tags at `t = trimIn + i*step`.

---

## Acceptance Criteria

- [ ] VideoTrack renders, culls, and selects per R1–R9.
- [ ] TransitionTrack renders, culls, styles per R10–R15.
- [ ] All three boundary zones visible, hover-highlighted, disabled when `isActiveTrack === false` (R16, R47).
- [ ] Trim drag produces correct persist call per zone × modifier combination (R17, R20).
- [ ] Trim drag respects all three clamp sources (neighbor kfs, source duration, trimIn floor) (R18).
- [ ] Body-drag single vs multi-select resolution matches R25.
- [ ] Overlap preview classifies all four cases with correct boundaryX coords (R30).
- [ ] Ghost overlay rendered via portal, positioned at cursor, copy-mode visual variant correct (R31).
- [ ] Escape cancels without persist (R33).
- [ ] Unmount mid-drag releases cursor and RAF (R34).
- [ ] TransitionFilmstrip respects all five skip conditions (R39).
- [ ] Filmstrip thumb 404 hides silently (R42).
- [ ] `undefined` rows (50–56) are linked to Open Questions and do NOT have implementation-binding tests.

---

## Tests

### Base Cases

#### Test: video-track-renders-one-cell-per-keyframe (covers R1)
**Given**: three keyframes at t=0,2,5 with pxPerSec=100.
**When**: VideoTrack renders.
**Then**:
- **cell-count**: exactly 3 cells rendered.
- **cell-widths**: cells have widths 200, 300, 60 px respectively.
- **cell-x**: cells positioned at x=0, 200, 500.

#### Test: video-track-tail-cell-default-width (covers R1)
**Given**: single keyframe at t=0 with no successor.
**When**: render.
**Then**:
- **tail-default**: last cell width = 60 px.

#### Test: video-track-culls-offscreen-cells (covers R2)
**Given**: kf at t=0 and t=100 with pxPerSec=100, scrollLeft=5000, viewportWidth=500.
**When**: render.
**Then**:
- **culled-left**: t=0 cell is not in DOM (x=0, nextX=10000 — both within buffered range actually; pick tighter: t=0 with next=0.5 (nextX=50)).
- **culled-right**: cell with x=8000, nextX=8060 (>5500+300=5800) is not in DOM.

#### Test: video-track-click-fires-callback (covers R4)
**Given**: VideoTrack rendered with onKeyframeClick spy.
**When**: left-click cell for kf1 with shiftKey=true.
**Then**:
- **callback-called**: `onKeyframeClick` called once with `(kf1, true)`.
- **propagation-stopped**: parent onClick does not receive event.

#### Test: video-track-drop-image (covers R6)
**Given**: cell with `onDropImage` and `onDropVideo` spies.
**When**: drop event with `application/x-scenecraft-pool-path = "pool/foo.png"`.
**Then**:
- **image-handler-called**: `onDropImage(kf.id, "pool/foo.png")` called once.
- **video-handler-not-called**: `onDropVideo` not called.
- **drop-target-cleared**: green highlight removed after drop.

#### Test: video-track-drop-video (covers R6)
**Given**: cell with drop spies.
**When**: drop `pool-path = "pool/bar.mp4"`.
**Then**:
- **video-handler-called**: `onDropVideo(kf.id, "pool/bar.mp4")` called.
- **image-handler-not-called**: `onDropImage` not called.

#### Test: video-track-drop-staged-image (covers R7)
**Given**: cell, spies present.
**When**: drop with `staging-id="st1"` and `variant="3"` (and no `pool-path`).
**Then**:
- **staged-handler-called**: `onDropStagedImage(kf.id, "st1", 3)` called.

#### Test: video-track-ignores-unknown-mime (covers R8)
**Given**: cell, drop spies.
**When**: drag of `text/plain`.
**Then**:
- **no-prevent-default**: `dragOver` did not call `preventDefault`.
- **no-drop-target-highlight**: no green tint applied.
- **no-handler**: none of the drop callbacks fire.

#### Test: video-track-selected-styling (covers R3)
**Given**: VideoTrack with `selectedId='kf1'`, `selectedIds={'kf2','kf3'}`.
**When**: render.
**Then**:
- **kf1-selected**: kf1 cell has teal ring class.
- **kf2-selected**: kf2 cell has teal ring class (from set).
- **other-unselected**: kf4 has no teal styling.

#### Test: video-track-no-thumb-when-narrow (covers R5)
**Given**: kf with `hasSelectedImage=true` where computed width = 15 px.
**When**: render.
**Then**:
- **no-img-tag**: no `<img>` rendered.
- **placeholder-rendered**: placeholder div with kf id shown.

#### Test: transition-track-renders-bars (covers R10)
**Given**: transition from kf@t=1 to kf@t=3, pxPerSec=100.
**When**: render.
**Then**:
- **bar-x**: bar left = 103, width = 197.
- **bar-height**: body `<div>` is 12 px tall (h-3).

#### Test: transition-track-skips-missing-kfs (covers R11)
**Given**: transition refs a kf id not in `keyframes`.
**When**: render.
**Then**:
- **bar-absent**: bar for that transition is not in DOM.

#### Test: transition-track-culls-offscreen-bars (covers R12)
**Given**: transition rendering outside `[scrollLeft-300, scrollLeft+vw+300]`.
**When**: render.
**Then**:
- **bar-culled**: DOM does not contain that bar.

#### Test: trim-in-drag-persists (covers R17, R20)
**Given**: two adjacent transitions sharing kfB; body-drag ignored; projectName set.
**When**: mousedown on right transition's `[>` zone, move cursor +30 px, mouseup.
**Then**:
- **persist-called-once**: `postClipTrimEdge` called exactly once.
- **persist-shape**: args include `{transitionId: right.id, edge: 'left', mode: 'trim', newBoundaryTimestamp, newTrim}`.
- **on-trim-change-fired**: `onTrimChange` called after persist.
- **preview-cleared**: drag preview line no longer in DOM after mouseup.

#### Test: trim-out-drag-persists (covers R17, R20)
**Given**: two adjacent transitions.
**When**: mousedown on left's `<]` zone, move −20 px, mouseup.
**Then**:
- **persist-shape**: `postClipTrimEdge({transitionId: left.id, edge: 'right', mode: 'trim', ...})`.

#### Test: trim-out-ripple (covers R17)
**Given**: drag with Shift held at mousedown.
**When**: complete the drag.
**Then**:
- **mode-ripple**: persist arg `mode` is `'ripple'`.

#### Test: boundary-remap (covers R17)
**Given**: Cmd held at mousedown of `<|>` zone.
**When**: drag, mouseup.
**Then**:
- **remap-call**: `postUpdateTransitionTrim` called on `leftTr ?? rightTr` with only the relevant `{from|to}KfTimestamp` set (no trim fields).

#### Test: roll-edit-persists (covers R17, R20)
**Given**: `<|>` zone on a shared boundary.
**When**: drag + mouseup.
**Then**:
- **two-calls**: `postUpdateTransitionTrim` called twice (once per neighbor) via `Promise.all`.
- **left-arg**: first call has `trimOut` + `toKfTimestamp`.
- **right-arg**: second call has `trimIn` + `fromKfTimestamp`.

#### Test: trim-clamps-to-neighbor-kf (covers R18)
**Given**: `[>` drag with prevKf at t=1.0, thisKf at t=2.0.
**When**: drag cursor 10,000 px left (far past prevKf).
**Then**:
- **newKfTime-lower-bound**: `newKfTime >= 1.1`.

#### Test: trim-out-clamps-to-source-video (covers R18)
**Given**: left clip with `sourceVideoDuration=5`, `trimOut=5`, `trimIn=0`, speed=1, fromTime=0, startTime=5.
**When**: drag `<]` right.
**Then**:
- **cannot-extend**: `maxTime == startTime` (`maxExtend=0`); drag cursor further right does not increase `newKfTime`.

#### Test: trim-in-clamps-to-zero (covers R18)
**Given**: right clip with `trimIn=0`, `trimOut=5`, speed=1, toTime=10, startTime=5.
**When**: drag `[>` left far.
**Then**:
- **min-time-held**: `newKfTime >= startTime` (`maxRetreat=0`).

#### Test: boundary-click-no-drag (covers R19)
**Given**: boundary mousedown then mouseup at same coords.
**When**: gesture completes.
**Then**:
- **no-persist**: no POST call made.
- **preview-cleared**: `dragPreview` is null.

#### Test: trim-commit-no-project-name (covers R23)
**Given**: `projectName = undefined`; drag completes.
**When**: mouseup fires.
**Then**:
- **no-http-call**: no `postClipTrimEdge` invocation observable.
- **error-logged**: `console.error` with "missing projectName" text.
- **state-cleared**: `dragPreview` is null.

#### Test: body-drag-single-clip (covers R24, R25)
**Given**: `tr.id` is NOT in `selectedIds`; mousedown on bar interior; `isActiveTrack=true`.
**When**: drag locks, mouseup with significant delta.
**Then**:
- **dragged-ids**: `postMoveTransitions.transitionIds` = `[tr.id]`.

#### Test: body-drag-multi-clip (covers R25)
**Given**: `selectedIds = {trA, trB, trC}`; mousedown on trA.
**When**: drag + commit.
**Then**:
- **dragged-ids-superset**: `transitionIds` contains all three ids.

#### Test: body-drag-copy-mode (covers R26, R31)
**Given**: Cmd held at mousedown.
**When**: drag locks.
**Then**:
- **ghost-tint-green**: ghost rect has green-tinted class.
- **plus-badge-visible**: `+` badge rendered on primary rect only.
- **commit-mode-copy**: `postMoveTransitions.mode === 'copy'`.

#### Test: body-drag-threshold (covers R27)
**Given**: mousedown, move 2 px total, mouseup.
**When**: gesture.
**Then**:
- **not-locked**: no ghost appears.
- **click-fires**: `onTransitionClick` is called normally.
- **no-commit**: no `postMoveTransitions` call.

#### Test: body-drag-clamps-to-zero (covers R28)
**Given**: clip with fromTime=1; mousedown; move cursor left by 500 px at pxPerSec=100.
**When**: mousemove.
**Then**:
- **time-delta-clamped**: computed `timeDelta === -1` (not `-5`).

#### Test: body-drag-overflow-top (covers R29, R30)
**Given**: numTracks=2; primary sourceTrackIndex=0; cursor Y far above stack (hits no track).
**When**: drag (manual injection: pretend DOM hit-test returns index=-2 by having a synthetic row data-track-id).
**Then**:
- **overflow-top-count**: `onGhostOverflowChange` publishes `{topCount: >=1, bottomCount: 0}`.
- **ghost-label**: tooltip contains "New track".

#### Test: overlap-case-a-consumed (covers R30)
**Given**: target tr spans [2,3]; drop span computed as [1.5, 3.5].
**When**: mousemove publishes preview.
**Then**:
- **consumed-list**: `overlapPreview.consumedIds` contains target.id.
- **overlay-full-red**: on Timeline re-render, target bar's overlay covers full bar width.

#### Test: overlap-case-b-trim-left (covers R30)
**Given**: target spans [2,5]; drop span [3, 6].
**When**: preview computed.
**Then**:
- **trimmed-left-entry**: `trimmedLeftIds` contains `{id: target.id, boundaryX: 3*pxPerSec}`.

#### Test: overlap-case-c-trim-right (covers R30)
**Given**: target [2,5]; drop [1, 3].
**When**: preview.
**Then**:
- **trimmed-right-entry**: `trimmedRightIds` contains `{id: target.id, boundaryX: 3*pxPerSec}`.

#### Test: overlap-case-d-split (covers R30)
**Given**: target [1, 6]; drop [2, 4].
**When**: preview.
**Then**:
- **split-entry**: `splitInsideIds` contains `{id: target.id, leftX: 2*pxPerSec, rightX: 4*pxPerSec}`.

#### Test: overlap-skips-hidden (covers R30)
**Given**: hidden transition would otherwise be consumed.
**When**: preview computed.
**Then**:
- **consumed-empty**: `consumedIds` does not include hidden tr.

#### Test: body-drag-escape-cancels (covers R33)
**Given**: body-drag locked, overlap preview published.
**When**: Escape keydown.
**Then**:
- **state-cleared**: `onTargetTracksChange(null)`, `onOverlapPreviewChange(null)`, `onGhostOverflowChange(null)` all called.
- **no-commit**: no `postMoveTransitions` call after cancel.
- **ghost-removed**: ghost portal content no longer in DOM.

#### Test: body-drag-no-op-mouseup (covers R32)
**Given**: locked drag with `timeDelta=0.005` and `trackDelta=0`.
**When**: mouseup.
**Then**:
- **no-http**: no `postMoveTransitions` call.
- **ghost-cleared**: ghost removed.

#### Test: body-drag-commit (covers R32)
**Given**: locked drag with timeDelta=1.5 and trackDelta=1.
**When**: mouseup succeeds.
**Then**:
- **move-call-args**: `postMoveTransitions` args `{mode:'move', trackDelta:1, timeDeltaSeconds:1.5, transitionIds:[...], autoCreateTracks:true}`.
- **after-body-drag-called**: `onAfterBodyDrag({timeDelta:1.5, trackDelta:1, draggedTransitionIds:[...]})`.
- **trim-change-called**: `onTrimChange` called after.
- **call-order**: `postMoveTransitions` resolves before `onAfterBodyDrag` fires.

#### Test: body-drag-commit-error (covers R32)
**Given**: `postMoveTransitions` throws.
**When**: mouseup.
**Then**:
- **error-logged**: `console.error` emitted.
- **no-throw**: no uncaught exception surfaces.
- **visuals-cleared**: ghost + overlays gone.

#### Test: body-drag-unmount-cleanup (covers R34)
**Given**: drag locked, ghost rendered.
**When**: TransitionTrack unmounts.
**Then**:
- **cursor-reset**: `document.body.style.cursor === ''`.
- **raf-cancelled**: no pending RAF for ghost updates.

#### Test: transition-drop-video (covers R36)
**Given**: bar with `onDropVideo` spy.
**When**: drop with `pool-path = "pool/clip.mp4"` and `source-tr = "trZ"`.
**Then**:
- **drop-call**: `onDropVideo("trThis", "pool/clip.mp4", "trZ")` called.
- **drop-target-cleared**: green tint removed.

#### Test: transition-click-after-drag-swallowed (covers R38)
**Given**: body-drag completed (`didDrag = true`).
**When**: synthetic click fires on bar.
**Then**:
- **click-handler-not-called**: `onTransitionClick` is NOT called.
- **did-drag-reset**: next click fires callback normally.

#### Test: transition-click-plain (covers R37)
**Given**: bar without any drag.
**When**: click with shiftKey=true.
**Then**:
- **callback-called**: `onTransitionClick(tr, true)` called.
- **propagation-stopped**: parent onClick not called.

#### Test: filmstrip-renders (covers R40, R41)
**Given**: transition with sourceVideoDuration=10, trimIn=0, trimOut=10; container h=40 (→ thumbWidth≈71 with 16:9); blockWidth=500.
**When**: render.
**Then**:
- **img-count**: 7 `<img>` tags rendered (fitCount=7, <12 cap).
- **img-src-first**: first src contains `t=0.000`.
- **img-src-last**: last src contains `t=10.000`.
- **img-src-height**: all srcs contain `height=40`.

#### Test: filmstrip-narrow-skips (covers R39)
**Given**: blockWidth=40, thumbWidth=50 (→ fitCount=0 or 1).
**When**: render.
**Then**:
- **no-imgs**: zero `<img>` tags.
- **spacer-rendered**: empty positioned div remains (for ResizeObserver).

#### Test: filmstrip-no-video-skips (covers R39)
**Given**: `transition.hasSelectedVideo = false`.
**When**: render.
**Then**:
- **no-imgs**: zero `<img>`.

### Edge Cases

#### Test: video-track-drag-leave-other-cell (covers R9)
**Given**: drop target set to kfA; dragLeave fires on kfB (different cell).
**When**: leave.
**Then**:
- **drop-target-unchanged**: kfA still highlighted.

#### Test: inactive-track-disables-drag (covers R47)
**Given**: `isActiveTrack = false`.
**When**: mousedown on bar interior.
**Then**:
- **no-body-drag**: no ghost appears even with large movement.
- **no-boundary-handles**: `[>`, `<]`, `<|>` zones are not rendered.
- **click-still-works**: onclick fires `onTransitionClick` normally.

#### Test: highlight-vs-select-distinct (covers R13)
**Given**: `selectedId=null`, `highlightedId='tr1'`.
**When**: render.
**Then**:
- **yellow-glow**: tr1 bar has yellow ring + glow class.
- **no-orange-ring**: tr1 does not have orange ring.

#### Test: render-progress-retry (covers R14)
**Given**: `renderProgress = {tr1: 0.4}`.
**When**: click progress bar.
**Then**:
- **retry-called**: `onRetryRender(tr1)` fires.
- **propagation-stopped**: bar click handler not also triggered.

#### Test: filmstrip-thumb-error-hides (covers R42)
**Given**: filmstrip rendered; one img URL returns 404.
**When**: `error` event on that img.
**Then**:
- **style-hidden**: that `<img>` has `style.visibility === 'hidden'`.
- **others-visible**: siblings unchanged.

#### Test: filmstrip-resize-rerenders (covers R43)
**Given**: filmstrip mounted with h=20.
**When**: container resizes to h=60.
**Then**:
- **new-thumb-height**: `<img>` height attribute = 60 on next render.
- **new-thumb-count**: recomputed from new `thumbWidth = 60*16/9`.

#### Test: trim-preview-cull-offscreen (covers R22)
**Given**: drag preview line at x = scrollLeft + viewportWidth + 500.
**When**: render tick.
**Then**:
- **line-culled**: line element not in DOM.

#### Test: body-drag-ghost-portal-target (covers R31)
**Given**: drag locked.
**When**: render.
**Then**:
- **in-body**: ghost element's `parentElement === document.body` (portal).
- **fixed-position**: computed style `position === 'fixed'`.

#### Test: body-drag-cross-track-tint (covers R30)
**Given**: drag of multi-clip selection that lands across two existing tracks.
**When**: mousemove.
**Then**:
- **target-set-size**: `onTargetTracksChange` publishes Set of size 2.

#### Test: multi-modifier-shift-plus-cmd-boundary (covers R17)
**Given**: boundary mousedown with both Shift AND Cmd held.
**When**: commit.
**Then**:
- **remap-wins**: takes remap path (Cmd/Ctrl branch checked first in code); no `mode:'ripple'` field set, ripple flag has no effect.

#### Test: trim-clamps-to-one-frame-min (covers R18, OQ-1 resolution)
**Given**: trim drag that would produce a resulting clip span < 1 frame (e.g., ≤ 0.033s at 30fps)
**When**: mouseup fires
**Then**:
- **clip-span-≥-one-frame**: persisted `(end - start)` ≥ 0.0333s for both affected clips

#### Test: body-drag-clamps-to-adjacent-keyframe (covers R28, OQ-2 resolution)
**Given**: a clip on track T with an adjacent keyframe on the same track at `t = kfNext`
**When**: body-drag moves the clip past `kfNext`
**Then**:
- **timedelta-clamped**: final `timeDelta` clamps to keep clip's trailing edge at `kfNext` (no cross)

#### Test: transition-drop-rejects-non-video (covers R36, OQ-3 resolution)
**Given**: drag of `application/x-scenecraft-pool-path = "pool/foo.wav"` (audio) over a transition bar
**When**: dragover + drop
**Then**:
- **no-drop-target-highlight**: no green tint
- **on-drop-video-not-called**: `onDropVideo` NOT invoked

#### Test: drag-during-candidate-render-allowed (covers OQ-5 resolution)
**Given**: `renderProgress[tr.id] = 0.5` on the dragged transition
**When**: body-drag mousedown + lock + mouseup with delta
**Then**:
- **drag-commits**: `postMoveTransitions` called normally
- **progress-preserved**: renderProgress entry still present for tr.id after drag (drag does not cancel render)

#### Test: body-drag-holds-last-track-delta (covers R29, body-drag=0 bug fix)
**Given**: body-drag locked with `trackDelta=2`; cursor then moves off all track rows
**When**: mousemove after cursor leaves rows
**Then**:
- **trackdelta-held**: `trackDelta === 2` (NOT reset to 0)
- **ghost-position-stable**: ghost rects do not snap back to original rows

*Note*: No concurrency tests — the component is single-threaded, DOM-event-driven. Drag state is held in a ref and a single in-flight drag at a time is guaranteed by mousedown → mousemove/up listener lifecycle.

---

## Non-Goals

- Snap-to-beat / snap-to-section / snap-to-clip-edge behavior: **not implemented** in either component in the current code (no snap math, no beat-grid read). Out of scope for this spec.
- Keyboard-driven trim / move (arrow keys nudge): not present; deferred.
- Touch / pointer-event parity: the handlers are mouse-only.
- Undo stack: trim/move persist directly; undo is a Timeline-level concern.
- Validation of `pool_segment` MIME semantics (image vs video vs audio): partial in VideoTrack (extension regex), absent in TransitionTrack.
- Collision with audio-clip links during body-drag: handled by Timeline via `onAfterBodyDrag`, not in TransitionTrack.

---

## Open Questions

- **OQ-4 — Snap when no beats/sections detected** (row 53). **Deferred**: snap feature not shipped; revisit when it is.
- **OQ-6 — Multi-select body-drag spanning multiple source tracks with overflow** (row 55). **Deferred**: multi-select body-drag not supported; current codified contract is single-clip drag only.
- **OQ-7 — VideoTrack multi-select drag** (row 56). **Deferred**: no drag gesture implemented on VideoTrack; revisit if multi-select-drag is a product requirement.

### Resolved

- **OQ-1 (row 50) — Trim drag to zero duration**: Resolved as **fix** — clamp to 1-frame minimum (≈0.0333s at 30fps). R18 updated; test `trim-clamps-to-one-frame-min`.
- **OQ-2 (row 51) — Body-drag past adjacent keyframe on same track**: Resolved as **fix** — clamp to adjacent keyframe edge; clip cannot cross a same-track keyframe. R28 updated; test `body-drag-clamps-to-adjacent-keyframe`.
- **OQ-3 (row 52) — Drop non-video pool_segment on transition**: Resolved as **fix** — client-side MIME/kind validation rejects non-video drops. R36 updated; test `transition-drop-rejects-non-video`.
- **OQ-5 (row 54) — Drag during candidate render in progress**: Resolved as **codify** — drag is allowed; render-state UI shows in-progress indicator on the transition; drag is not blocked. Test `drag-during-candidate-render-allowed`.
- **body-drag trackDelta=0 bug (beyond numbered OQs)**: Resolved as **fix** — hold last-known `trackDelta` rather than resetting to 0 when cursor leaves track rows. R29 updated; test `body-drag-holds-last-track-delta`; Behavior Table row 28 updated.

---

## Related Artifacts

- `agent/reports/audit-2-architectural-deep-dive.md` — §1D unit 4 (VideoTrack), unit 5 (TransitionTrack), §3 leak #4 (TransitionTrack reaches into Timeline state).
- Sibling specs (pending): `local.timeline-composition-and-playback-loop`, `local.audio-lane-and-clip-editing`, `local.pool-segments-and-variant-kind`.
- Backend endpoints used (specced elsewhere): `postUpdateTransitionTrim`, `postClipTrimEdge`, `postMoveTransitions`, `GET /api/projects/:n/transitions/:id/filmstrip`.

---

**Spec**: local.video-and-transition-tracks
**Status**: Draft — awaiting user proofing of Behavior Table rows 50–56 (`undefined`) and of acceptance criteria.
