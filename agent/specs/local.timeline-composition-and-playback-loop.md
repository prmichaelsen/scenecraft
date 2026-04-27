# Spec: Timeline Composition and Playback Loop

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-27
**Last Updated**: 2026-04-27
**Status**: Retroactive — describes shipped behavior as of commit 392960b
**Source**: `--from-draft` (retroactive reverse-engineering from source). Primary sources:
- `src/components/editor/Timeline.tsx` (4273 LOC; this spec covers only the orchestrator layer — see Out-of-scope)
- `src/components/editor/CurrentTimeContext.tsx`
- `src/lib/playback-sync-ref.ts`
- Context: `agent/reports/audit-2-architectural-deep-dive.md` §1D units 3, 11 + §3 leak #3

---

## Purpose

Specify the Timeline component's role as an **orchestrator** — composing sub-tracks (VideoTrack, TransitionTrack, AudioTrack, RulesTrack, Playhead, SectionBands, MarkerTrack), owning viewport/zoom/scroll/selection state, and coordinating playback with the AudioTrack via the `seekRef` / `playPauseRef` action-ref pattern exposed by `CurrentTimeContext`.

This spec does **not** redefine sub-track internals. It defines the contract between Timeline and its children, the playback-master delegation to AudioTrack, and the re-render discipline enforced by splitting `CurrentTimeContext` from `PlaybackStateContext`.

---

## Scope

### In-scope
- Composition tree rendered by `Timeline` (sub-track order, props wired down, callbacks wired up)
- Playback state model: `currentTime`, `isPlaying`, `seekRef`, `playPauseRef`, `audioElRef`
- `CurrentTimeContext` / `PlaybackStateContext` split (high-freq vs low-freq re-render surfaces)
- Click-to-seek on time ruler + track area (`handleTrackClick`)
- Playhead component seek wiring
- Seek delegation to AudioTrack via `seekRef.current?.(time)`; fallback to `setCurrentTime(time)` when ref is null
- Play/pause delegation via `playPauseRef.current?.()`; rAF fallback timer when no AudioTrack is mounted
- Zoom (`pxPerSec`) — Ctrl+wheel handler, zoom-around-playhead preservation, localStorage persistence, epsilon floor `1e-6`
- Scroll state (`scrollRef`, `scrollLeft`, `scrollTop`) and viewport-width measurement for virtualization
- Drag-select rectangle state (`dragSelectRef`, `dragSelectRect`) — hold-150ms + 5px threshold; Cmd / Shift modifiers
- Selection mutex coordination: `handleKeyframeClick`, `handleTransitionClick` close all panels, update `selectedTrackId`, drive `selectedKeyframeIds` / `selectedTransitionIds`
- v2 mode: Timeline reads `currentTime` / `isPlaying` / refs from context vs local state
- Playhead auto-follow-during-play (observable: the "Jump to playhead" button centers viewport on demand; no automatic follow is implemented — stated as negative assertion)
- Persistence: `scenecraft-playhead-<project>`, `scenecraft-zoom`, `scenecraft-playback-speed` in localStorage

### Out-of-scope (separate specs)
- VideoTrack internals (keyframe rendering, drag-select hit testing inside the track)
- TransitionTrack internals (body-drag, overlap preview, ghost overflow, cross-track drag)
- AudioLane / AudioTrack internals — scheduling, trimming, candidate assignment, waveform rendering
- AudioMixer / MixGraph / WebAudio routing
- Playhead scrub-drag internals (this spec only covers the `onSeek` callback contract)
- Chat / job state / keyframe panel / transition panel / bin panel / settings panel content
- Preview viewport / MSE playback / video blocked overlay (`playback-sync-ref.ts` is in-scope only as supporting context for why audio playhead keeps running during seeks)
- Audio clip body-drag and trim gestures (separate audio-lane spec)
- Effects / suppressions / markers CRUD behavior beyond render composition

---

## Requirements

1. **R1** — Timeline composes the following sub-components per video track, in this DOM order top-to-bottom: `TrackHeader`, `SectionBands` (only on the active track), `VideoTrack`, `TransitionTrack`. Global (non-per-track) rows: `TimeRuler`, `MarkerTrack`, `BeatMarkers`, `AudioTrack` (single — the main `data.audioFile`), per-track `AudioLane` rows, `RulesTrack`, `Playhead`.
2. **R2** — Timeline exposes one and only one `AudioTrack` instance as the playback master clock, mounted when `data.audioFile` is truthy. It wires `onTimeUpdate` → `setCurrentTime`, `onDurationChange` → `setDuration`, `onPlayingChange` → `setIsPlaying`, and assigns `seekRef`, `playPauseRef`, `audioElRef` down for the child to populate.
3. **R3** — `CurrentTimeContext` exposes only `{ currentTime, setCurrentTime }`; `PlaybackStateContext` exposes `{ isPlaying, setIsPlaying, seekRef, playPauseRef, audioElRef }`. Consumers of `isPlaying` / refs MUST NOT re-render when `currentTime` ticks.
4. **R4** — When `v2 === true`, Timeline reads playback state from the two contexts; when `v2` is falsy it uses local `useState` + local refs. Both modes preserve identical observable behavior for click-to-seek, play/pause, zoom, drag-select, and sub-track composition.
5. **R5** — `handleTrackClick` converts a mouse click on the time ruler into `time = (clientX - rectLeft + scrollLeft) / pxPerSec` and seeks via `seekFnRef.current?.(time)` if present, else `setCurrentTime(time)`. The seek is clamped to `[0, effectiveDuration]`; out-of-range clicks are dropped (no-op).
6. **R6** — `Playhead.onSeek` callback follows the same pattern: `seekFnRef.current?.(time) ?? setCurrentTime(time)`.
7. **R7** — `handlePlayPause`: if `playPauseFnRef.current` is set, delegate to it and cancel any running fallback rAF timer; otherwise toggle `isPlaying` locally and drive `currentTime` via rAF using `performance.now()` deltas until `effectiveDuration` is reached.
8. **R8** — Ctrl+wheel (`ctrlKey || metaKey`) on the scroll container zooms by `factor = deltaY > 0 ? 0.85 : 1.18`, clamped to `pxPerSec ≥ 1e-6`, preserving the playhead's viewport-relative X position. New value is persisted to `localStorage["scenecraft-zoom"]`. Non-Ctrl wheel scrolls normally.
9. **R9** — Drag-select: mouse-down on track area starts a 150ms hold timer; on timer expiry the drag is "armed"; a subsequent mouse move of ≥5px activates the rectangle. Cmd-drag selects kfs + transitions fully contained in time range; Cmd+Shift-drag restricts to the dragged track; Shift-drag restricts to current `selectedTrackId`; plain drag selects keyframes across all tracks. Mouse-up clears `dragSelectRect` and `dragSelectRef`.
10. **R10** — `handleKeyframeClick` and `handleTransitionClick` implement the EditorState selection mutex: plain click closes all side panels, sets selected track id to the clicked entity's track, seeds the multi-select set to `{clicked.id}`, and clicking the same entity twice clears selection. Shift-click toggles the clicked id in the multi-select set without closing panels.
11. **R11** — Timeline persists `currentTime` to `localStorage["scenecraft-playhead-<projectName>"]` with a 500ms debounce on the trailing edge of the last change, and restores it on mount.
12. **R12** — Timeline persists `pxPerSec` to `localStorage["scenecraft-zoom"]` (written on every wheel-zoom) and reads it on mount; persists `playbackRate` to `localStorage["scenecraft-playback-speed"]` and applies it to `audioElRef.current.playbackRate` when a `scenecraft-playback-speed` CustomEvent fires.
13. **R13** — Timeline does NOT implement automatic viewport follow-on-play. Auto-follow is user-initiated via the "◎ Jump to playhead" button which sets `scrollRef.current.scrollLeft = currentTime * pxPerSec - clientWidth / 2`. This is a design choice, not a bug.
14. **R14** — Timeline renders `SectionBands` only behind the active (selected) track's `VideoTrack`, not globally.
15. **R15** — Timeline passes `scrollLeft` and `viewportWidth` down to `MarkerTrack` and `RulesTrack` for virtualization; children render only items whose X is within `[scrollLeft - 300, scrollLeft + viewportWidth + 300]`.
16. **R16** — Timeline's `onScroll` handler updates `scrollLeft` and `scrollTop` state and passes `scrollTop` into `Playhead` (for sticky vertical positioning).
17. **R17** — Timeline creates one AudioMixer via `useAudioMixer(projectName, localAudioTracks, isPlaying, currentTime)` that is independent of the `data.audioFile` HTMLAudioElement; when `isPlaying` is true, both the HTMLAudioElement (via AudioTrack) and the mixer run in parallel, with the HTMLAudioElement acting as the master clock (`onTimeUpdate` → `setCurrentTime`) and the mixer following `currentTime` passively.
18. **R18** — The split of `CurrentTimeContext` vs `PlaybackStateContext` is load-bearing: any refactor that collapses them into one context is forbidden by this spec because it causes the ~20Hz `currentTime` tick to re-render every `isPlaying` consumer.

---

## Interfaces / Data Shapes

### `CurrentTimeContext`
```ts
type CurrentTimeContextValue = {
  currentTime: number              // seconds; updated ~20Hz during play
  setCurrentTime: (t: number) => void
}
```

### `PlaybackStateContext`
```ts
type PlaybackStateContextValue = {
  isPlaying: boolean
  setIsPlaying: (p: boolean) => void
  seekRef: MutableRefObject<((time: number) => void) | null>
  playPauseRef: MutableRefObject<(() => void) | null>
  audioElRef: MutableRefObject<HTMLAudioElement | null>
}
```

### Timeline props
```ts
{ data: EditorData; v2?: boolean }
```

### Action-ref contract (populated by child, called by parent)
- `seekRef.current` is set to a `(time: number) => void` by `AudioTrack` when its `<audio>` element mounts; cleared (null) on unmount.
- `playPauseRef.current` is set to a zero-arg toggler by `AudioTrack`.
- `audioElRef.current` is set to the raw `HTMLAudioElement`.

### LocalStorage keys (schema)
| Key | Shape |
|---|---|
| `scenecraft-playhead-<projectName>` | stringified float seconds |
| `scenecraft-zoom` | stringified float pxPerSec |
| `scenecraft-playback-speed` | stringified float (1.0 default) |
| `scenecraft-video-track-height` | integer px |
| `scenecraft-preview-height` | integer px |
| `scenecraft-audio-track-height` | integer px |

---

## Behavior Table

| # | Scenario | Expected Behavior | Tests |
|---|----------|-------------------|-------|
| 1 | Timeline mounts with `data.audioFile` set | Renders one AudioTrack; `seekRef.current` becomes non-null after mount | `mounts-with-audio-file`, `audio-track-populates-seek-ref` |
| 2 | Timeline mounts with no `data.audioFile` | No AudioTrack rendered; `seekFnRef.current` stays null; fallback rAF drives time on play | `mounts-without-audio-file`, `fallback-timer-drives-playback` |
| 3 | User clicks time ruler at x=200, pxPerSec=20, scrollLeft=0 | Seeks to t=10.0s via `seekRef.current(10)` if set, else `setCurrentTime(10)` | `track-click-seeks-via-ref`, `track-click-seeks-via-setstate-fallback` |
| 4 | User clicks time ruler past `effectiveDuration` | Seek is dropped; no state change | `track-click-past-end-dropped` |
| 5 | User clicks time ruler at negative x (shouldn't happen but bounds check) | `time < 0` dropped; no seek | `track-click-negative-dropped` |
| 6 | User presses space / play button, `playPauseRef` is set | Delegates to `playPauseRef.current()`; cancels any running fallback rAF | `play-delegates-to-audio-track`, `play-cancels-fallback-timer` |
| 7 | User presses play, `playPauseRef` is null | Starts rAF-driven fallback timer advancing `currentTime` | `play-starts-fallback-timer` |
| 8 | Ctrl+wheel on scroll container, deltaY > 0 | `pxPerSec *= 0.85`, persisted to localStorage, playhead stays at same viewport X | `ctrl-wheel-zoom-out-preserves-playhead-x`, `ctrl-wheel-persists-zoom` |
| 9 | Ctrl+wheel with `pxPerSec` already tiny | Clamps to ≥ 1e-6 (never reaches zero or negative) | `zoom-clamped-to-epsilon` |
| 10 | Plain wheel (no ctrl) | Scrolls normally; no zoom | `plain-wheel-scrolls-not-zooms` |
| 11 | `v2 === true` | Uses context for time + refs; consumers of isPlaying don't re-render on time tick | `v2-uses-context`, `playback-state-consumers-stable-on-time-tick` |
| 12 | `v2 === false` / undefined | Uses local state + local refs; same observable behavior | `v1-uses-local-state` |
| 13 | `currentTime` changes | Persisted to localStorage 500ms after the last change (trailing debounce) | `currenttime-debounced-persistence` |
| 14 | User clicks a keyframe, no shift | All panels close, `selectedKeyframeIds` = `{kf.id}`, `selectedTrackId` = `kf.trackId` | `keyframe-click-mutex-clears-panels` |
| 15 | User shift-clicks a keyframe | Toggles id in `selectedKeyframeIds`; no panel close | `keyframe-shift-click-toggles` |
| 16 | User clicks same keyframe twice | Second click clears `selectedKeyframeIds` and `selectedKeyframe` | `keyframe-click-twice-deselects` |
| 17 | User holds mouse for 150ms then moves 5px | Drag-select rectangle appears; selection updates on move | `drag-select-armed-after-hold-then-move` |
| 18 | User holds <150ms then mouse-up | No drag-select; treated as normal click | `drag-select-canceled-short-hold` |
| 19 | Cmd+drag across kfs + transitions | Selects both kfs and transitions fully contained in time range | `cmd-drag-selects-kfs-and-transitions` |
| 20 | Cmd+Shift+drag | Same but restricted to dragged track | `cmd-shift-drag-restricts-to-track` |
| 21 | User presses "◎ Jump to playhead" | `scrollLeft = currentTime * pxPerSec - clientWidth/2` | `jump-to-playhead-centers-viewport` |
| 22 | Playback is active | Viewport does NOT auto-scroll to follow playhead | `no-auto-follow-during-play` |
| 23 | `MarkerTrack` / `RulesTrack` — a marker is outside viewport±300px buffer | That marker is not rendered to DOM | `markers-outside-viewport-virtualized` |
| 24 | Active track selection changes | `SectionBands` re-parents to new active `VideoTrack`; only one SectionBands in the tree | `section-bands-follow-active-track` |
| 25 | `onTimeUpdate` from AudioTrack | Calls `setCurrentTime` with the HTMLAudio's currentTime | `audio-timeupdate-drives-currenttime` |
| 26 | `audioElRef.current.playbackRate` is mutated via Settings CustomEvent | Timeline updates `playbackRate` state and writes rate to the element | `playback-speed-event-applies-rate` |
| 27 | Timeline remounts while `isPlaying === true` | **undefined** | → [OQ-1](#open-questions) |
| 28 | Seek to `time < 0` via `seekRef.current(-1)` | **undefined** (Timeline's `handleTrackClick` clamps, but a direct `seekRef.current(-1)` call bypasses Timeline) | → [OQ-2](#open-questions) |
| 29 | Seek to `time > effectiveDuration` via ref | **undefined** | → [OQ-3](#open-questions) |
| 30 | `pxPerSec` forced to exactly 0 (dev tools) | **undefined** — epsilon prevents wheel-zoom reaching 0, but external setter bypass not defined | → [OQ-4](#open-questions) |
| 31 | A sub-track component throws during render | **undefined** — Timeline has no internal error boundary; EditorPanelLayout has per-panel boundaries at a higher level | → [OQ-5](#open-questions) |
| 32 | User holds mouse, then scrolls (via arrow-keys / trackpad) before drag-select activates | **undefined** — drag-select coords are captured in `scrollLeft + clientX` space at mouse-down and at move; scrolling between events will skew the rectangle | → [OQ-6](#open-questions) |
| 33 | `isPlaying = true` is set but no AudioTrack is mounted (seekFnRef null) | **undefined** — `handlePlayPause` starts rAF, but if `isPlaying` becomes true by some other path (e.g., context sync from another component), rAF is not started here | → [OQ-7](#open-questions) |
| 34 | Two Timelines mount simultaneously (split panel) sharing one `PlaybackStateContext` | **undefined** — both would write to the same `seekRef`; last mount wins | → [OQ-8](#open-questions) |

---

## Behavior (step-by-step)

### Mount
1. Read `scenecraft-playhead-<projectName>`, `scenecraft-zoom`, `scenecraft-playback-speed` from localStorage (defaulting to 0, 20, 1).
2. Initialize state: `currentTime`, `pxPerSec`, `playbackRate`; selection sets empty.
3. In v2 mode: subscribe to `CurrentTimeContext` and `PlaybackStateContext`; use their setters. Otherwise use local `useState` + local refs.
4. Register `ResizeObserver` on `scrollRef` to track `viewportWidth`.
5. Register passive+false-`wheel` listener on scroll element to `preventDefault` on Ctrl+wheel.
6. Register `scenecraft-playback-speed` window event listener.
7. Render composition tree (see Render section).

### Click-to-seek
1. `handleTrackClick(e)` computes `clickX = e.clientX - rect.left + scrollLeft`, `time = clickX / pxPerSec`.
2. If `0 ≤ time ≤ effectiveDuration`: call `seekFnRef.current?.(time)` (drives HTMLAudioElement.currentTime, which emits `timeupdate` → `setCurrentTime`); if ref is null, call `setCurrentTime(time)` directly.
3. Out-of-range: no-op.

### Play/pause
1. `handlePlayPause()`: ensure `audioElRef.current.playbackRate = playbackRate`.
2. If `playPauseFnRef.current` is set: cancel any running fallback rAF, then call it.
3. Else: toggle `isPlaying`. On transition false→true, kick off rAF loop that increments `currentTime` by wall-clock deltas until `effectiveDuration`.

### Zoom
1. `handleWheel(e)`: if `!(e.ctrlKey || e.metaKey)`, return (let scroll happen).
2. Else: `preventDefault`, compute `factor`, read playhead viewport-offset, compute new `pxPerSec` (clamped ≥ `1e-6`), compute new playhead X, assign `scrollLeft = newPlayheadX - viewportOffset`, update state, persist to localStorage.

### Drag-select
1. `handleDragSelectDown(e, trackId?)`: snapshot start coords (scroll-adjusted), start 150ms timer.
2. On timer fire: mark `armed = true`.
3. Document `mousemove`: if armed and movement ≥ 5px, set `active = true`, compute rect, compute time range, branch on modifiers to update `selectedKeyframeIds` / `selectedTransitionIds`.
4. Document `mouseup`: clear timer, clear rect, clear drag ref.

### Persistence (debounced playhead)
1. `useEffect` on `currentTime`: set 500ms timeout writing `localStorage["scenecraft-playhead-<projectName>"]`.
2. Cleanup cancels timeout if `currentTime` changes again within 500ms.

### Render (composition order inside the scroll container)
```
<div ref=scrollRef onScroll=... onWheel=...>
  <TimeRuler onClick=handleTrackClick />
  <MarkerTrack markers scrollLeft viewportWidth ... />
  <for each track>
    <TrackHeader track scrollLeft onSelect onUpdate ... />
    <!-- body -->
    {isActive && <SectionBands sections pxPerSec />}
    <VideoTrack
      pxPerSec
      onKeyframeClick=handleKeyframeClick
      scrollRef
      ...
    />
    <TransitionTrack
      pxPerSec
      onTransitionClick=handleTransitionClick
      ...
    />
    <AudioLane track pxPerSec ... />
  </for>
  <BeatMarkers beats audioEvents pxPerSec />
  {data.audioFile && <AudioTrack
     audioUrl onTimeUpdate onDurationChange onPlayingChange
     seekRef=seekFnRef playPauseRef=playPauseFnRef audioElRef />}
  {aiAudioRules.length > 0 && <RulesTrack ... />}
  {dragSelectRect && <rect overlay />}
  <Playhead currentTime pxPerSec duration onSeek audioElRef scrollTop />
</div>
```

---

## Acceptance Criteria

- [ ] A user can click anywhere on the time ruler within `[0, effectiveDuration]` and the playhead seeks there, with or without AudioTrack mounted
- [ ] Pressing play with an audio file starts the HTMLAudioElement; pressing play without one advances `currentTime` via rAF
- [ ] Ctrl+wheel zooms around the playhead (playhead keeps its viewport column) and persists the value
- [ ] `pxPerSec` never becomes 0 or negative via the zoom handler
- [ ] `isPlaying`-only consumers of `PlaybackStateContext` do NOT re-render when `currentTime` ticks (verifiable via `React.Profiler` or render-count probe)
- [ ] Playhead position is restored from localStorage on reload
- [ ] Drag-select requires both the 150ms hold AND 5px movement before activating
- [ ] Cmd / Shift / Cmd+Shift modifiers during drag-select behave per R9
- [ ] Keyframe / transition click clears all side panels and seeds the multi-select set
- [ ] Shift-clicking the same keyframe twice toggles it out of the multi-select set
- [ ] `MarkerTrack` / `RulesTrack` virtualize items outside `[scrollLeft-300, scrollLeft+viewportWidth+300]`
- [ ] Timeline does NOT auto-scroll during playback — auto-follow is only via the "◎" button
- [ ] Timeline works in both v1 (`v2=false`) and v2 (`v2=true`) modes with identical user-observable behavior

---

## Tests

### Base Cases

#### Test: mounts-with-audio-file (covers R1, R2)
**Given**: `data.audioFile` is a non-empty string
**When**: Timeline mounts
**Then**:
- **audio-track-rendered**: exactly one `<AudioTrack>` is rendered
- **audio-url-wired**: its `audioUrl` prop equals `scenecraftFileUrl(projectName, data.audioFile)`
- **time-handlers-wired**: `onTimeUpdate`, `onDurationChange`, `onPlayingChange` props are the Timeline's setters

#### Test: mounts-without-audio-file (covers R2, R7)
**Given**: `data.audioFile` is falsy
**When**: Timeline mounts
**Then**:
- **no-audio-track**: no `AudioTrack` in the render tree
- **seek-ref-null**: `seekFnRef.current` is `null`
- **play-pause-ref-null**: `playPauseFnRef.current` is `null`

#### Test: audio-track-populates-seek-ref (covers R2)
**Given**: Timeline rendered with an audio file
**When**: AudioTrack effect runs
**Then**:
- **seek-ref-set**: `seekFnRef.current` is a function of shape `(time: number) => void`
- **play-pause-ref-set**: `playPauseFnRef.current` is a zero-arg function
- **audio-el-ref-set**: `audioElRef.current` is an `HTMLAudioElement`

#### Test: track-click-seeks-via-ref (covers R5)
**Given**: `pxPerSec=20`, `scrollLeft=0`, `effectiveDuration=60`, `seekFnRef.current` set
**When**: user clicks the TimeRuler at clientX=200 (rect.left=0)
**Then**:
- **seek-called-with-10**: `seekFnRef.current` was called with `10`
- **set-current-time-not-called**: `setCurrentTime` was NOT called directly by the handler

#### Test: track-click-seeks-via-setstate-fallback (covers R5)
**Given**: `seekFnRef.current === null`, otherwise as above
**When**: user clicks at x=200
**Then**:
- **set-current-time-called**: `setCurrentTime(10)` was called

#### Test: play-delegates-to-audio-track (covers R7)
**Given**: `playPauseFnRef.current` is set, `isPlaying=false`
**When**: user calls `handlePlayPause`
**Then**:
- **play-pause-ref-invoked**: `playPauseFnRef.current` was called once
- **playback-rate-applied**: `audioElRef.current.playbackRate` equals the current `playbackRate` state

#### Test: play-starts-fallback-timer (covers R7)
**Given**: no audio file mounted, `isPlaying=false`
**When**: user calls `handlePlayPause`
**Then**:
- **is-playing-true**: `isPlaying` becomes `true`
- **raf-scheduled**: `requestAnimationFrame` was called at least once
- **current-time-advances**: after ~100ms of wall-clock, `currentTime` has increased

#### Test: play-cancels-fallback-timer (covers R7)
**Given**: fallback rAF timer is running, then an AudioTrack mounts and populates `playPauseFnRef`
**When**: user presses play again
**Then**:
- **cancel-animation-frame-called**: `cancelAnimationFrame` was called with the stored handle
- **using-fallback-false**: `usingFallbackTimer.current === false`

#### Test: currenttime-debounced-persistence (covers R11)
**Given**: Timeline mounted
**When**: `currentTime` changes from 0 to 5 and stays for 500+ms
**Then**:
- **localstorage-written**: `localStorage["scenecraft-playhead-<projectName>"]` equals `"5"`
- **no-write-before-debounce**: localStorage was not written within the first 499ms after the change

#### Test: v2-uses-context (covers R3, R4)
**Given**: `<CurrentTimeProvider>` wrapping `<Timeline v2 />`
**When**: `setCurrentTime(3)` is called by the provider
**Then**:
- **ctx-time-read**: Timeline's rendered playhead is at `3 * pxPerSec`
- **local-state-unused**: Timeline does not maintain a parallel `localCurrentTime` that diverges

#### Test: v1-uses-local-state (covers R4)
**Given**: `<Timeline />` without the provider (v2 falsy)
**When**: user clicks ruler
**Then**:
- **local-state-updated**: Timeline's `localCurrentTime` advances
- **no-context-access**: no error thrown from `useCurrentTime` / `usePlaybackState`

#### Test: keyframe-click-mutex-clears-panels (covers R10)
**Given**: `showBin=true`, `selectedEffect` non-null
**When**: `handleKeyframeClick(kf)` fires without shiftKey
**Then**:
- **bin-closed**: `showBin === false`
- **selected-effect-cleared**: `selectedEffect === null`
- **selected-kf-set**: `selectedKeyframe?.id === kf.id`
- **selected-kf-ids**: `selectedKeyframeIds` is a Set of exactly `{kf.id}`
- **selected-track-id**: `selectedTrackId === kf.trackId`

#### Test: keyframe-shift-click-toggles (covers R10)
**Given**: `selectedKeyframeIds = {a, b}`
**When**: `handleKeyframeClick({id: c}, shiftKey=true)`
**Then**:
- **ids-extended**: `selectedKeyframeIds === {a, b, c}`
- **panels-not-closed**: `showBin` unchanged

#### Test: keyframe-click-twice-deselects (covers R10)
**Given**: `selectedKeyframe.id === 'a'`, `selectedKeyframeIds === {a}`
**When**: `handleKeyframeClick({id: 'a'}, shiftKey=false)` fires again
**Then**:
- **selected-kf-null**: `selectedKeyframe === null`
- **selected-kf-ids-empty**: `selectedKeyframeIds.size === 0`

#### Test: audio-timeupdate-drives-currenttime (covers R2, R17)
**Given**: AudioTrack mounted, `<audio>` element playing
**When**: `<audio>` emits `timeupdate` with `currentTime=4.2`
**Then**:
- **timeline-ct-4-2**: Timeline's `currentTime` state is `4.2`

#### Test: playback-speed-event-applies-rate (covers R12)
**Given**: Timeline mounted with `playbackRate=1`, audio element mounted
**When**: `window.dispatchEvent(new CustomEvent('scenecraft-playback-speed', {detail: 2}))`
**Then**:
- **rate-state-updated**: internal `playbackRate` state is `2`
- **audio-el-rate-updated**: `audioElRef.current.playbackRate === 2`

### Edge Cases

#### Test: track-click-past-end-dropped (covers R5)
**Given**: `effectiveDuration=60`, `pxPerSec=20`, user clicks at x=2000 (→ t=100s)
**When**: `handleTrackClick` fires
**Then**:
- **no-seek**: `seekFnRef.current` was NOT called
- **no-set-current-time**: `setCurrentTime` was NOT called

#### Test: track-click-negative-dropped (covers R5)
**Given**: user somehow clicks at a negative computed time (clientX < rect.left, scrollLeft=0)
**When**: `handleTrackClick` fires with computed `time < 0`
**Then**:
- **no-seek**: neither seek path was invoked

#### Test: ctrl-wheel-zoom-out-preserves-playhead-x (covers R8)
**Given**: `pxPerSec=20`, `currentTime=5`, `scrollLeft=50` (playhead at viewport x=50)
**When**: Ctrl+wheel with `deltaY>0` (zoom-out)
**Then**:
- **new-pxpersec**: `pxPerSec === 20 * 0.85 === 17`
- **playhead-viewport-x-preserved**: `currentTime * newPxPerSec - scrollLeft` equals the pre-zoom viewport-x within 1 px tolerance
- **zoom-persisted**: `localStorage["scenecraft-zoom"] === "17"`

#### Test: ctrl-wheel-persists-zoom (covers R8, R12)
**Given**: `pxPerSec=20`
**When**: Ctrl+wheel deltaY<0
**Then**:
- **persisted-value**: `localStorage["scenecraft-zoom"]` is the new pxPerSec as a string

#### Test: zoom-clamped-to-epsilon (covers R8)
**Given**: `pxPerSec=1e-5`
**When**: Ctrl+wheel deltaY>0 repeatedly
**Then**:
- **never-below-epsilon**: `pxPerSec >= 1e-6` after every event
- **never-zero**: `pxPerSec !== 0`

#### Test: plain-wheel-scrolls-not-zooms (covers R8)
**Given**: Ctrl not held
**When**: wheel event fires
**Then**:
- **pxpersec-unchanged**: `pxPerSec` same
- **default-not-prevented**: `preventDefault` was not called

#### Test: playback-state-consumers-stable-on-time-tick (covers R3, R18)
**Given**: a consumer reading only `isPlaying` from `PlaybackStateContext`
**When**: `setCurrentTime(x)` fires 50 times
**Then**:
- **zero-rerenders**: the consumer re-rendered 0 times
- **time-context-rerendered**: a parallel consumer reading `currentTime` re-rendered 50 times

#### Test: fallback-timer-drives-playback (covers R7)
**Given**: no `data.audioFile`, Timeline mounted, `effectiveDuration=30`
**When**: user presses play, wall-clock advances 500ms
**Then**:
- **current-time-advanced**: `currentTime ≈ 0.5` (± 50ms tolerance)
- **still-playing**: `isPlaying === true`

#### Test: drag-select-armed-after-hold-then-move (covers R9)
**Given**: mouse-down on track area
**When**: 150ms elapse, then mouse moves 6px
**Then**:
- **rect-visible**: `dragSelectRect` is non-null
- **selection-updated**: `selectedKeyframeIds` includes any kf within the swept time range

#### Test: drag-select-canceled-short-hold (covers R9)
**Given**: mouse-down, mouse-up after 50ms with no move
**When**: mouse-up fires
**Then**:
- **no-rect**: `dragSelectRect === null`
- **dragref-cleared**: `dragSelectRef.current === null`
- **selection-unchanged**: prior selection intact

#### Test: cmd-drag-selects-kfs-and-transitions (covers R9)
**Given**: Cmd-held, drag from time=2s to time=8s across tracks
**When**: drag active
**Then**:
- **kfs-in-range-selected**: every kf with `timeSeconds ∈ [2,8]` is in `selectedKeyframeIds`
- **trs-in-range-selected**: every transition with both endpoints in `[2,8]` is in `selectedTransitionIds`

#### Test: cmd-shift-drag-restricts-to-track (covers R9)
**Given**: Cmd+Shift, drag started on `track_2`
**When**: drag sweeps a range
**Then**:
- **only-track2-kfs**: only kfs on `track_2` are selected
- **only-track2-trs**: only transitions on `track_2` are selected

#### Test: jump-to-playhead-centers-viewport (covers R13)
**Given**: `currentTime=30`, `pxPerSec=20`, `scrollRef.current.clientWidth=800`
**When**: user clicks "◎"
**Then**:
- **scroll-left**: `scrollRef.current.scrollLeft === 30 * 20 - 800/2 === 200`

#### Test: no-auto-follow-during-play (covers R13)
**Given**: `isPlaying=true`, `scrollLeft=0`, `currentTime` advancing from 0 to 10 (playhead crosses viewport edge)
**When**: 10 seconds of wall-clock elapse
**Then**:
- **scroll-left-unchanged**: `scrollRef.current.scrollLeft === 0`
- **no-scroll-events-from-timeline**: Timeline did NOT programmatically assign `scrollLeft`

#### Test: markers-outside-viewport-virtualized (covers R15)
**Given**: markers at t=0, t=100, t=200; `pxPerSec=20`, `scrollLeft=0`, `viewportWidth=400`
**When**: rendered
**Then**:
- **in-viewport-rendered**: markers at t=0 and t=15 rendered
- **far-marker-not-rendered**: marker at t=200 (x=4000) is NOT in the DOM

#### Test: section-bands-follow-active-track (covers R14)
**Given**: two tracks; track_1 active
**When**: user selects track_2
**Then**:
- **single-section-bands**: exactly one `<SectionBands>` in the tree
- **parented-under-track2**: it is rendered inside track_2's body, not track_1's

#### Test: no-automatic-follow-during-play (covers R13) *(negative assertion — duplicates R13 coverage for emphasis)*
**Given**: playback active, playhead leaves the visible viewport
**Then**:
- **no-scroll-into-view-call**: `scrollIntoView` / `scrollLeft` assignment is never issued by Timeline during playback

---

## Non-Goals

- Automatic viewport follow-on-play (explicit design choice per R13)
- Recovering from a sub-track render exception (no Timeline-level error boundary; EditorPanelLayout handles panel-level boundaries)
- Multi-Timeline coordination within a single `PlaybackStateContext` (undefined — see OQ-8)
- Bounds-checking seeks that arrive via `seekRef.current` from non-Timeline callers (AudioTrack, seek ref holders outside Timeline) — Timeline only clamps its own `handleTrackClick` path
- Preventing `pxPerSec = 0` via external setters; only the wheel handler enforces the epsilon floor
- Replacing the split-context design with a single context (forbidden per R18)

---

## Open Questions

- **OQ-1** *(maps to Behavior Table row 27)*: What happens if Timeline remounts while `isPlaying === true`? The `<audio>` element is inside AudioTrack, which also remounts — does playback actually stop and restart, or does `audioElRef` re-bind to a new element mid-stream? Audit-2 §3 leak #3 flags this as "Panel remount can stall playback" but the exact failure mode (silence vs. restart-from-zero vs. resume) is not specified.
- **OQ-2** *(row 28)*: If `seekRef.current(-1)` is called directly (not through Timeline's click handler), does AudioTrack clamp, or does it propagate into `HTMLMediaElement.currentTime = -1` which the browser then clamps to 0? Is there a round-trip `timeupdate` that pushes `currentTime` back to 0?
- **OQ-3** *(row 29)*: Same question for `seekRef.current(time > duration)`. Does the browser silently clamp to `duration`? Does Timeline observe an `ended` event?
- **OQ-4** *(row 30)*: If `pxPerSec` is forced to 0 externally (React devtools), `currentTime * 0 = 0` so playhead pins to left, and `time = clickX / 0 = Infinity` so every click seeks to `Infinity`. Spec does not define Timeline's guarantees here.
- **OQ-5** *(row 31)*: If `VideoTrack`, `TransitionTrack`, `AudioTrack`, `RulesTrack`, or `Playhead` throws during render, does the rest of Timeline survive? There is no internal `ErrorBoundary`; EditorPanelLayout wraps Timeline as a whole.
- **OQ-6** *(row 32)*: If the scroll container is scrolled (keyboard, trackpad) during a pending/active drag-select, is the rectangle still correct? Coordinates are captured at `mouse-down` and `mouse-move` as `clientX + scrollLeft` — intermediate scroll between events is not compensated.
- **OQ-7** *(row 33)*: If `isPlaying` is set to `true` from an external source (e.g., another Timeline instance sharing context, or chat tool toggling context) while this Timeline has `seekFnRef.current === null`, the fallback rAF is NOT started (that only runs from `handlePlayPause`). Is `currentTime` expected to advance?
- **OQ-8** *(row 34)*: Are two Timelines mounted under the same `PlaybackStateContext` supported? Both would overwrite `seekRef.current` on mount — "last mounter wins" is the observed behavior but isn't stated as a contract.

---

## Related Artifacts

- `agent/reports/audit-2-architectural-deep-dive.md` (§1D units 3, 11 + §3 leak #3) — source for Timeline↔AudioTrack coupling characterization
- Companion specs to be written (audit-2 §5):
  - #12 video-and-transition-tracks (sub-track internals)
  - #13 audio-lane-and-clip-editing (AudioLane + AudioTrack internals)
  - #16 webaudio-mixer-and-mix-graph
  - #10 editor-state-selection-mutex (EditorStateContext)
- `src/lib/playback-sync-ref.ts` — tangentially related; `videoBlocked` flag coexists with `CurrentTimeContext` to keep audio + playhead running during video-only seek stalls. Not consumed by Timeline directly; referenced only because the design decision "playhead keeps ticking during seek" is what justifies the split-context design in R18.

---

**Namespace**: local
**Spec**: timeline-composition-and-playback-loop
**Version**: 1.0.0
**Status**: Retroactive — proofing needed before treating as authoritative
