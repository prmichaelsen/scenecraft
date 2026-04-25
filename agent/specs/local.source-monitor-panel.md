# Spec: Source Monitor Panel

**Namespace**: local
**Version**: 1.0.0
**Created**: 2026-04-24
**Last Updated**: 2026-04-24
**Status**: Proposal

---

**Purpose**: Concrete, implementation-ready spec for the general-purpose source monitor panel — a preview surface for any `pool_segment` (audio or video) that sits alongside the program monitor, supports independent transport + in/out markers, and integrates with the Bin, music gen, isolate vocals, and (later) finalizations.

**Source**: `--from-design agent/design/local.source-monitor-panel.md` (v1.0.0)

---

## Scope

### In scope

- New `source-monitor` panel registered in the existing `PanelRegistry`, rendered in the preview panel group by default
- React context `useSourceMonitor()` exposing source state, transport, in/out markers, and recent-sources stack
- Media rendering for audio (via `<audio>` + waveform) and video (via `<video>`)
- Transport controls: play/pause, scrub, timecode (M:SS), volume slider for audio
- In/out markers with invariants; clear-marks action
- Premiere-style session-scoped recent-sources stack (not persisted)
- Drag-to-timeline with kind-aware payloads (audio → `audio_clips`, video → kf+tr pair)
- Plugin contribution point `contributes.sourceMonitorProvider` (optional) with imperative `setSource` fallback
- Integration points: music gen (single-click + keep inline ▶), Bin (single-click + keep hover), isolate vocals (single-click, remove inline ▶), timeline video-clip right-click
- "Reveal properties" action that opens the Properties panel for the source's `poolSegmentId`
- Empty state, "source unavailable" state on missing file

### Out of scope (Non-Goals)

- **Persistence across reloads** — source + recent stack always empty on reload
- **Sync-to-program-monitor playhead toggle** — independent playhead only in v1
- **Variable playback speed / JKL scrub** — 1x only in v1
- **Cover art display** for music gen tracks that have `cover_url` — design explicitly rejected
- **Loop markers** on the in/out range — Future Considerations only
- **Multi-source compare mode** (A/B)
- **Zoom on waveform** — default view only
- **Subclip metadata stamping** (carrying `variant_kind` onto created clips) — Future
- **Keyboard shortcuts** (spacebar, JKL, I/O) — Future; not in v1
- **Finalize-range integration** — this spec delivers the panel; the Finalizations panel consumer lands when finalize-range is built
- **Backend changes** — no new REST, WS, or schema

---

## Requirements

### Panel registration and layout

- **R1**: A new panel `source-monitor` with title "Source Monitor" is registered in the `PanelRegistry` via `buildPanelRegistry()` in `EditorPanelLayout.tsx`.
- **R2**: The default layout includes `source-monitor` as a tab in the **preview panel group** (sibling to the `preview` tab / program monitor).
- **R3**: Calling `setSource(s)` with a non-null source brings the `source-monitor` tab to front within its group (auto-activation).
- **R4**: Calling `setSource(null)` or `clearSource()` does NOT auto-activate or auto-switch tabs.

### Context API

- **R5**: A React context `useSourceMonitor()` is exposed from `src/components/editor/SourceMonitorContext.tsx`. The provider wraps the editor tree at the same nesting level as `PreviewProvider` and `EditorStateProvider`.
- **R6**: The hook return value has the following shape:
  ```ts
  {
    source: SourceMonitorSource | null,
    recentSources: SourceMonitorSource[],   // session-scoped LIFO
    setSource: (s: SourceMonitorSource | null) => void,
    clearSource: () => void,
    playing: boolean,
    currentTime: number,   // seconds
    duration: number,      // seconds; 0 until media loads
    play: () => void,
    pause: () => void,
    seek: (seconds: number) => void,
    inPoint: number | null,
    outPoint: number | null,
    markIn: () => void,
    markOut: () => void,
    clearMarks: () => void,
  }
  ```
- **R7**: `SourceMonitorSource` has the exact shape:
  ```ts
  {
    kind: 'video' | 'audio',
    path: string,                         // project-relative (starts with "pool/")
    label: string,
    poolSegmentId?: string,
    metadata?: Record<string, unknown>,
  }
  ```

### Media rendering

- **R8**: When `source.kind === 'video'`, the panel renders an `HTMLVideoElement` whose `src` is the canonical scenecraft file URL: `${API_URL}/api/projects/${encodeURIComponent(projectName)}/files/${path.split('/').map(encodeURIComponent).join('/')}`.
- **R9**: When `source.kind === 'audio'`, the panel renders (a) a hidden/offscreen `HTMLAudioElement` for playback and (b) a waveform view sourced from the existing `/api/projects/:name/pool/:seg_id/peaks` endpoint (when `poolSegmentId` is set) or a fallback scrubbable progress bar (when `poolSegmentId` is absent).
- **R10**: When `source === null`, the panel renders an empty-state message: "Select a media item to preview."
- **R11**: When the media element fires `error` or `abort` with a file-not-found class failure, the panel renders a "source unavailable" state and does NOT clear `source` or auto-close the tab.

### Transport

- **R12**: Clicking play starts playback; `playing` becomes `true`. Clicking pause (or play again while playing) pauses; `playing` becomes `false`.
- **R13**: `seek(seconds)` updates `currentTime` and the underlying media element. Click/drag on the scrub bar invokes `seek`.
- **R14**: Timecode is displayed in `M:SS / M:SS` format (e.g., `0:47 / 2:48`). Values are floored for current, rounded for total.
- **R15**: The source-monitor playhead is strictly independent of the program monitor playhead. No cross-wiring, no sync toggle.
- **R16**: v1 plays at 1x only. No variable-speed controls are rendered.

### In/out markers

- **R17**: `markIn()` sets `inPoint = currentTime`, clamped to `[0, duration]`.
- **R18**: `markOut()` sets `outPoint = currentTime`, clamped to `[0, duration]`.
- **R19**: Invariant: after `markIn`, if an existing `outPoint < inPoint`, `outPoint` is set to `null` (cleared) to avoid crossed markers. Symmetric rule for `markOut`.
- **R20**: `clearMarks()` sets both `inPoint` and `outPoint` to `null`.
- **R21**: Scrub bar displays `[I]` / `[O]` notches at `inPoint` / `outPoint` when set.
- **R22**: `markIn` / `markOut` / `clearMarks` are no-ops when `source === null`.

### Recent sources

- **R23**: When `setSource(s)` is called with non-null `s`, and a previous non-null `source` existed, that previous source is pushed onto the front of `recentSources` (LIFO).
- **R24**: `recentSources` is deduplicated by `path` — pushing a source whose `path` already exists in the stack removes the earlier entry.
- **R25**: `recentSources` is capped at 10 entries; oldest entries are dropped when the cap is exceeded.
- **R26**: `recentSources` is session-scoped. It is NOT persisted to `localStorage`, `sessionStorage`, or the workspace view.
- **R27**: On page reload or mount, `source === null` and `recentSources === []`.
- **R28**: On project switch (projectName change), `source` is set to `null` and `recentSources` is emptied.

### Drag-to-timeline — audio

- **R29**: When `source.kind === 'audio'`, the panel's drag handle emits `dragstart` events with:
  - `dataTransfer.setData('application/x-scenecraft-pool-path', source.path)`
  - `dataTransfer.setData('application/x-scenecraft-in-out', JSON.stringify({ inSeconds, outSeconds }))` where `inSeconds = inPoint ?? 0` and `outSeconds = outPoint ?? duration`
  - `dataTransfer.effectAllowed = 'copy'`
- **R30**: The existing `AudioLane.onDropPoolAudio` handler reads the optional `application/x-scenecraft-in-out` payload when present and creates an `audio_clips` row with `source_offset = inSeconds` and end_time − start_time = `outSeconds − inSeconds`. When the in/out payload is absent, existing full-range behavior is preserved (unchanged from today).

### Drag-to-timeline — video

- **R31**: When `source.kind === 'video'`, the panel's drag handle emits `dragstart` events with:
  - `dataTransfer.setData('application/x-scenecraft-video-subclip', JSON.stringify({ path, inSeconds, outSeconds, label }))` where `inSeconds = inPoint ?? 0` and `outSeconds = outPoint ?? duration`
  - `dataTransfer.effectAllowed = 'copy'`
- **R32**: The timeline / keyframe drop handler (new; addition to `Timeline.tsx`) receives `application/x-scenecraft-video-subclip`, creates a new `keyframe` + `transition` pair at the drop position, sets `transition.trim_in = inSeconds` and `transition.trim_out = outSeconds`, and runs existing transition reconciliation (overlapping tr's nudged / trimmed per current logic).

### Plugin contribution point

- **R33**: `plugin.yaml` supports an OPTIONAL `contributes.sourceMonitorProvider` entry of shape:
  ```yaml
  contributes:
    sourceMonitorProvider:
      entityTypes: [pool_segment]
      label: "Preview track"   # optional; defaults to "Preview in source monitor"
  ```
- **R34**: When a plugin declares `contributes.sourceMonitorProvider`, the core app auto-wires a right-click menu entry on matching entity kinds that calls `setSource` with the entity resolved to a `SourceMonitorSource`.
- **R35**: Plugins that do NOT declare the contribution point can still call `useSourceMonitor().setSource(...)` imperatively from their own UI.
- **R36**: The `setSource` contract is open — any caller (plugin or core panel) may invoke it. No ACL, no provider registration required for imperative use.

### Properties integration

- **R37**: The source monitor header renders a "Reveal properties" action.
- **R38**: Clicking "Reveal properties" activates (or focuses) the `properties` panel and loads the entity with id `source.poolSegmentId`.
- **R39**: When `source === null` or `source.poolSegmentId === undefined`, "Reveal properties" is disabled (greyed out, non-interactive).

### Panel integrations

- **R40**: Music gen panel: single-click on a track row calls `setSource({ kind: 'audio', path: track.pool_path, label: track.song_title || 'song', poolSegmentId: track.pool_segment_id })`.
- **R41**: Music gen panel: the existing inline `PoolAudioPlayButton` on each track row remains (quick-listen coexists with source-monitor detail view).
- **R42**: Bin panel: single-click on a pool item calls `setSource` with `kind` matching the segment kind (audio files → `'audio'`, video files → `'video'`), `path = segment.pool_path`, `label = segment.label || basename(pool_path)`, `poolSegmentId = segment.id`.
- **R43**: Bin panel: existing hover-preview behavior in the program-preview panel is unchanged.
- **R44**: Isolate vocals panel: single-click on a stem row calls `setSource` with `kind: 'audio'`.
- **R45**: Isolate vocals panel: the existing inline `PoolAudioPlayButton` is removed (click becomes the primary preview gesture).
- **R46**: Timeline video clip (in the keyframe/transition surface): right-click menu gains an action labelled "Open source in source monitor" that calls `setSource({ kind: 'video', path: clip.source_path, label: clip.label, poolSegmentId: clip.pool_segment_id })`.

### Session behavior

- **R47**: `clearSource()` sets `source = null`. The panel returns to the empty state.
- **R48**: No `source` state is persisted across browser sessions.

---

## Interfaces / Data Shapes

### `SourceMonitorSource`

```ts
type SourceMonitorSource = {
  kind: 'video' | 'audio'
  path: string                         // project-relative; expected to start with "pool/"
  label: string
  poolSegmentId?: string
  metadata?: Record<string, unknown>
}
```

### `useSourceMonitor()` return

```ts
type SourceMonitorContextValue = {
  source: SourceMonitorSource | null
  recentSources: SourceMonitorSource[]
  setSource: (s: SourceMonitorSource | null) => void
  clearSource: () => void
  playing: boolean
  currentTime: number
  duration: number
  play: () => void
  pause: () => void
  seek: (seconds: number) => void
  inPoint: number | null
  outPoint: number | null
  markIn: () => void
  markOut: () => void
  clearMarks: () => void
}
```

### Plugin contribution point

```yaml
# plugin.yaml (optional)
contributes:
  sourceMonitorProvider:
    entityTypes: [pool_segment]          # list of entity kinds; required
    label: "Preview track"                # optional; defaults to "Preview in source monitor"
```

### Drag payloads

**Audio subclip drag:**

```
application/x-scenecraft-pool-path   →  "pool/segments/<uuid>.mp3"
application/x-scenecraft-in-out      →  '{"inSeconds": 12.0, "outSeconds": 45.5}'
effectAllowed                         →  "copy"
```

**Video subclip drag:**

```
application/x-scenecraft-video-subclip  →  '{"path":"pool/bounces/<id>.mp4","inSeconds":12.0,"outSeconds":45.5,"label":"range 32-48s v2"}'
effectAllowed                            →  "copy"
```

### Panel registry entry

```ts
'source-monitor': {
  component: SourceMonitorPanelComponent,
  title: 'Source Monitor',
}
```

### Default layout patch

The preview panel group in the default layout gains `source-monitor` as a sibling tab of `preview`. Exact shape of the group changes from:

```ts
{ type: 'group', id: 'preview-group', tabs: ['preview'], activeTab: 'preview' }
```

to:

```ts
{ type: 'group', id: 'preview-group', tabs: ['preview', 'source-monitor'], activeTab: 'preview' }
```

---

## Behavior (step-by-step)

### Loading a source

1. A caller invokes `setSource(s)` with a non-null `SourceMonitorSource`.
2. The context pushes the previous non-null `source` (if any) onto `recentSources` (applying dedup + cap).
3. The context updates `source = s`.
4. `currentTime = 0`, `duration = 0`, `inPoint = null`, `outPoint = null`, `playing = false`.
5. The `SourceMonitorPanel` component observes `source` change and mounts the appropriate media element (`<video>` or `<audio>` + waveform).
6. The panel layout engine brings the `source-monitor` tab to front in its group.
7. When the media's `loadedmetadata` event fires, the context updates `duration`.
8. When the user clicks play, the media element plays and `playing = true`.

### Marking an in-point

1. User scrubs to desired position; `currentTime` updates as media `timeupdate` fires.
2. User clicks "Mark In" (button or keyboard shortcut *not in v1*).
3. `markIn()` sets `inPoint = clamp(currentTime, 0, duration)`.
4. If the current `outPoint !== null && outPoint < inPoint`, the context clears `outPoint` (sets to `null`).
5. The scrub bar renders the `[I]` notch at `inPoint`.

### Dragging an audio subclip to the timeline

1. User presses mouse on the drag handle inside the source monitor.
2. `dragstart` fires; handler computes `inSeconds = inPoint ?? 0` and `outSeconds = outPoint ?? duration`.
3. DataTransfer is populated with `application/x-scenecraft-pool-path` = `source.path` and `application/x-scenecraft-in-out` = serialized `{inSeconds, outSeconds}`.
4. User drops on an `AudioLane`.
5. `AudioLane.onDropPoolAudio` reads both payloads. When the in-out payload is present, the lane creates an `audio_clips` row with `source_offset = inSeconds` and `end_time - start_time = outSeconds - inSeconds`. When the in-out payload is absent (e.g., drag from Bin), full-range behavior applies (existing logic, unchanged).

### Dragging a video subclip to the timeline

1. User drags the handle from the source monitor with `source.kind === 'video'`.
2. `dragstart` populates `application/x-scenecraft-video-subclip` with serialized `{path, inSeconds, outSeconds, label}`.
3. User drops on the timeline keyframe surface.
4. A new handler in `Timeline.tsx` reads the payload, creates a `keyframe` + `transition` pair at the drop time, sets `transition.trim_in = inSeconds`, `transition.trim_out = outSeconds`.
5. Existing transition reconciliation runs (overlapping tr's resolved per current logic).

### Missing file at load

1. `setSource(s)` succeeds; panel mounts media element with the derived URL.
2. Media element fires `error` with a network / 404 class failure.
3. The panel renders "source unavailable" state.
4. `source` is NOT cleared. `recentSources` is unchanged.
5. The user may still call `setSource` to load a different source.

### Session lifecycle

1. On mount, `source = null`, `recentSources = []`.
2. All `setSource` / mark / transport calls mutate context state only (no persistence).
3. On project switch, a `useEffect` watching `projectName` calls `clearSource()` and resets `recentSources` to `[]`.
4. On page reload, the entire context state is reinitialized fresh (no restore).

---

## Acceptance Criteria

- [ ] `source-monitor` appears as a tab in the default preview panel group on a new project
- [ ] Calling `setSource` from any caller auto-activates the tab
- [ ] Music gen panel: single-click a track row → source monitor loads the track, waveform renders, play works, inline ▶ still works independently
- [ ] Bin panel: single-click a pool audio/video item → source monitor loads it; existing hover-preview unchanged
- [ ] Isolate vocals panel: single-click a stem → source monitor loads it; old inline play button is removed
- [ ] Timeline video clip right-click → "Open source in source monitor" loads the source video
- [ ] Mark in + mark out + drag to audio lane → new `audio_clips` row exists with correct `source_offset` and length
- [ ] Mark in + mark out + drag to timeline (video source) → new keyframe + transition pair at drop position with correct `trim_in` / `trim_out`
- [ ] "Reveal properties" opens the Properties panel with the source's `poolSegmentId` loaded
- [ ] Missing file shows "source unavailable" state; panel does not auto-close
- [ ] Recent-sources dropdown shows last N sources, LIFO, deduped, capped at 10
- [ ] Reload page → source monitor is empty; recent stack is empty
- [ ] Project switch → source monitor clears
- [ ] Plugin manifest declaring `contributes.sourceMonitorProvider` produces a right-click menu entry on matching entities without further wiring
- [ ] Plugin with no manifest declaration can still call `setSource` imperatively
- [ ] No backend REST, WS, or schema changes were required
- [ ] All tests in the Tests section pass

---

## Tests

### Base Cases

The core behavior contract — happy path, common bad paths, primary positive and negative assertions. A reader should be able to understand the normal operation of the source monitor from this subsection alone.

#### Test: loads-audio-source-renders-waveform (covers R5, R6, R7, R9)

**Given**:
- The editor is mounted
- No source is loaded (`source === null`)
- A valid audio `pool_segment` with `pool_path = "pool/segments/abc.mp3"`, `poolSegmentId = "ps_1"` is available

**When**: A caller invokes `setSource({ kind: 'audio', path: 'pool/segments/abc.mp3', label: 'Merged Motifs', poolSegmentId: 'ps_1' })`

**Then** (assertions):
- **source-updated**: `useSourceMonitor().source` equals the passed object
- **tab-activated**: the `source-monitor` tab is the active tab in its group
- **audio-element-mounted**: an `HTMLAudioElement` with the correct `/api/.../files/pool/segments/abc.mp3` URL is present in the panel DOM
- **waveform-requested**: the `/api/projects/:name/pool/ps_1/peaks` endpoint is fetched
- **label-displayed**: the panel header contains "Merged Motifs"

#### Test: loads-video-source-renders-player (covers R8)

**Given**: No source loaded; a video file at `pool/bounces/foo.mp4` exists

**When**: `setSource({ kind: 'video', path: 'pool/bounces/foo.mp4', label: 'range 32-48s v2' })`

**Then** (assertions):
- **video-element-mounted**: an `HTMLVideoElement` with the correct src URL is present
- **no-audio-element**: no `HTMLAudioElement` and no waveform view are rendered
- **label-displayed**: header shows "range 32-48s v2"

#### Test: empty-state-when-no-source (covers R10)

**Given**: The panel is mounted and `source === null`

**When**: The panel is rendered

**Then** (assertions):
- **empty-message**: the panel contains the text "Select a media item to preview"
- **no-media-element**: no `HTMLVideoElement` or `HTMLAudioElement` is rendered
- **transport-hidden-or-disabled**: play/scrub/mark controls are either hidden or rendered disabled

#### Test: missing-file-shows-unavailable-state (covers R11)

**Given**:
- `setSource({ kind: 'audio', path: 'pool/segments/gone.mp3', label: 'deleted', poolSegmentId: 'ps_x' })` was called
- The file does not exist on the server (404)

**When**: The media element's `error` event fires

**Then** (assertions):
- **unavailable-message**: the panel renders "source unavailable" state text
- **source-unchanged**: `useSourceMonitor().source` is still the previously-set source (NOT cleared)
- **tab-not-closed**: the `source-monitor` tab is still present

#### Test: transport-play-pause-toggles-state (covers R12)

**Given**: An audio source is loaded and the waveform is ready

**When**:
- User clicks the play button
- User clicks the play button again

**Then** (assertions):
- **first-click-plays**: after first click, `playing === true` and the audio element is playing
- **second-click-pauses**: after second click, `playing === false` and the audio element is paused

#### Test: scrub-seeks-media (covers R13)

**Given**: An audio source with `duration = 60` is loaded

**When**: User clicks the scrub bar at the 50% position

**Then** (assertions):
- **current-time-updated**: `currentTime ≈ 30`
- **media-seeked**: the underlying `HTMLAudioElement.currentTime ≈ 30`

#### Test: timecode-format-mss (covers R14)

**Given**: An audio source with `duration = 167.9` and `currentTime = 47`

**When**: The panel renders

**Then** (assertions):
- **current-format**: the current-time portion of the timecode is `0:47`
- **total-format**: the total-time portion is `2:48` (ceil or round — pick one; rounding in this spec → `2:48`)

#### Test: mark-in-records-current-time (covers R17, R21)

**Given**: An audio source with `duration = 60` and `currentTime = 10.0`

**When**: `markIn()` is called

**Then** (assertions):
- **in-point-set**: `inPoint === 10.0`
- **out-point-unchanged**: `outPoint === null` (assuming it was null to begin with)
- **marker-rendered**: the scrub bar displays an `[I]` notch at the 10s position

#### Test: mark-out-records-current-time (covers R18, R21)

**Given**: An audio source loaded at `currentTime = 45.0` with `duration = 60`

**When**: `markOut()` is called

**Then** (assertions):
- **out-point-set**: `outPoint === 45.0`
- **marker-rendered**: the scrub bar displays an `[O]` notch at the 45s position

#### Test: clear-marks-resets-both (covers R20)

**Given**: Both `inPoint = 10` and `outPoint = 45` are set

**When**: `clearMarks()` is called

**Then** (assertions):
- **both-null**: `inPoint === null` and `outPoint === null`
- **notches-hidden**: neither `[I]` nor `[O]` notches are rendered

#### Test: audio-drag-emits-pool-path-and-inout (covers R29)

**Given**:
- An audio source is loaded at `path = 'pool/segments/abc.mp3'`
- `inPoint = 12.0`, `outPoint = 45.5`

**When**: A `dragstart` event is dispatched on the drag handle

**Then** (assertions):
- **pool-path-set**: `dataTransfer.getData('application/x-scenecraft-pool-path') === 'pool/segments/abc.mp3'`
- **inout-set**: `JSON.parse(dataTransfer.getData('application/x-scenecraft-in-out'))` equals `{ inSeconds: 12.0, outSeconds: 45.5 }`
- **effect-allowed-copy**: `dataTransfer.effectAllowed === 'copy'`

#### Test: audio-drag-without-marks-uses-full-range (covers R29)

**Given**: An audio source with `duration = 100` loaded; `inPoint = null`, `outPoint = null`

**When**: `dragstart` is dispatched

**Then** (assertions):
- **inout-full-range**: parsed payload equals `{ inSeconds: 0, outSeconds: 100 }`

#### Test: audio-drop-creates-audio-clip-with-offset (covers R30)

**Given**:
- An existing audio track exists in the timeline
- A `dragstart` event was dispatched from the source monitor with `{inSeconds: 12, outSeconds: 45.5}` and path `pool/segments/abc.mp3`
- The drag ends over `AudioLane` at timeline position t = 5.0s

**When**: The drop is handled by `AudioLane.onDropPoolAudio`

**Then** (assertions):
- **new-clip-exists**: a new `audio_clips` row was created on the target track
- **correct-source-offset**: the new clip's `source_offset === 12`
- **correct-duration**: the new clip's `end_time - start_time === 33.5` (= 45.5 - 12)
- **correct-start**: the new clip's `start_time === 5.0`

#### Test: video-drag-emits-subclip-payload (covers R31)

**Given**:
- A video source is loaded: `path = 'pool/bounces/foo.mp4'`, `label = 'range 32-48s v2'`
- `inPoint = 0`, `outPoint = 16`

**When**: `dragstart` is dispatched on the drag handle

**Then** (assertions):
- **subclip-payload-shape**: `JSON.parse(dataTransfer.getData('application/x-scenecraft-video-subclip'))` equals `{ path: 'pool/bounces/foo.mp4', inSeconds: 0, outSeconds: 16, label: 'range 32-48s v2' }`

#### Test: video-drop-creates-kf-tr-pair (covers R32)

**Given**:
- A video subclip dragstart fired with `{inSeconds: 10, outSeconds: 25}` on `pool/bounces/foo.mp4`
- Drop target is the timeline keyframe surface at t = 40.0s

**When**: The drop is handled by the Timeline's new video-subclip drop handler

**Then** (assertions):
- **keyframe-created**: a new `keyframes` row exists at timestamp 40.0
- **transition-created**: a new `transitions` row exists referencing the new keyframe
- **trim-in**: the new transition's `trim_in === 10`
- **trim-out**: the new transition's `trim_out === 25`
- **reconciliation-ran**: any transitions overlapping [40.0, 40.0 + 15.0] were adjusted or the drop was rejected per existing reconciliation rules (test asserts the reconciliation function was invoked)

#### Test: recent-sources-pushed-on-setsource (covers R23)

**Given**: A source A is loaded

**When**: `setSource(sourceB)` is called

**Then** (assertions):
- **active-source-is-b**: `source === sourceB`
- **recent-contains-a**: `recentSources[0] === sourceA`
- **recent-length-one**: `recentSources.length === 1`

#### Test: music-gen-click-loads-source (covers R40)

**Given**: The music gen panel is rendered with a completed generation and a track `tr = { pool_path: 'pool/segments/x.mp3', song_title: 'Neon Midnight', pool_segment_id: 'ps_42' }`

**When**: The user single-clicks the track row

**Then** (assertions):
- **setsource-called**: `useSourceMonitor().source` equals `{ kind: 'audio', path: 'pool/segments/x.mp3', label: 'Neon Midnight', poolSegmentId: 'ps_42' }`
- **tab-activated**: the `source-monitor` tab is active
- **inline-play-unchanged**: the inline `PoolAudioPlayButton` on the same row remains functional and clicking it starts inline playback without affecting the source monitor

#### Test: music-gen-inline-play-still-works (covers R41)

**Given**: The music gen panel is rendered with a generation and a track

**When**: The user clicks the inline ▶ button (NOT the row)

**Then** (assertions):
- **inline-audio-plays**: an inline audio element plays
- **source-monitor-unchanged**: `useSourceMonitor().source` is unchanged

#### Test: bin-click-loads-source (covers R42)

**Given**: The Bin panel is rendered with an audio pool segment

**When**: The user single-clicks the bin item

**Then** (assertions):
- **setsource-called**: `source.kind === 'audio'`, `source.path === segment.pool_path`, `source.poolSegmentId === segment.id`
- **tab-activated**: `source-monitor` tab is active
- **hover-preview-unchanged**: hovering a different bin item still triggers the existing program-preview behavior

#### Test: isolate-vocals-click-loads-source (covers R44)

**Given**: The isolate vocals panel is rendered with a stem row

**When**: The user single-clicks the stem row

**Then** (assertions):
- **setsource-called**: source loaded with the stem's pool path and id
- **no-inline-play-button**: the stem row contains NO `PoolAudioPlayButton` element

#### Test: timeline-video-clip-right-click-opens-source (covers R46)

**Given**: A video clip exists in the timeline (keyframe + transition)

**When**: User right-clicks the clip and selects "Open source in source monitor"

**Then** (assertions):
- **setsource-called**: `source.kind === 'video'`, `source.path` matches the clip's source
- **tab-activated**: `source-monitor` tab is active

#### Test: reveal-properties-opens-props-panel (covers R37, R38)

**Given**: A source is loaded with `poolSegmentId = 'ps_42'`

**When**: User clicks "Reveal properties"

**Then** (assertions):
- **props-panel-active**: the `properties` panel is the active tab in its group
- **props-loaded**: the Properties panel displays data for entity `ps_42`

#### Test: reveal-properties-disabled-when-no-pool-id (covers R39)

**Given**: A source is loaded with `poolSegmentId === undefined`

**When**: The panel is rendered

**Then** (assertions):
- **button-disabled**: "Reveal properties" button is rendered disabled (non-interactive)

#### Test: plugin-with-provider-gets-wired-menu (covers R33, R34)

**Given**:
- A plugin `foo` declares in its `plugin.yaml`:
  ```yaml
  contributes:
    sourceMonitorProvider:
      entityTypes: [pool_segment]
      label: "Preview foo"
  ```
- The plugin is registered via `PluginHost.register_declared`

**When**: The user right-clicks on a `pool_segment` entity

**Then** (assertions):
- **menu-item-present**: a context menu item with text "Preview foo" is rendered
- **click-calls-setsource**: clicking the menu item invokes `setSource` with a `SourceMonitorSource` derived from the entity

#### Test: plugin-without-provider-can-use-imperative (covers R35, R36)

**Given**: A plugin that does NOT declare `contributes.sourceMonitorProvider`

**When**: The plugin's panel imperatively calls `useSourceMonitor().setSource(validSource)`

**Then** (assertions):
- **source-loaded**: the source monitor updates and loads the media
- **no-error**: no runtime errors are thrown; no authorization rejection occurs

### Edge Cases

Boundaries, unusual inputs, concurrency, idempotency, ordering, time-dependent behavior, resource exhaustion.

#### Test: mark-out-before-in-clears-in (covers R19)

**Given**: `inPoint = 30` (previously set), `currentTime = 10`

**When**: `markOut()` is called

**Then** (assertions):
- **out-point-set**: `outPoint === 10`
- **in-point-cleared**: `inPoint === null` (invariant: avoid crossed markers)

#### Test: mark-in-after-out-clears-out (covers R19)

**Given**: `outPoint = 10` (previously set), `currentTime = 30`

**When**: `markIn()` is called

**Then** (assertions):
- **in-point-set**: `inPoint === 30`
- **out-point-cleared**: `outPoint === null`

#### Test: markers-clamped-to-duration (covers R17, R18)

**Given**: `duration = 60`, `currentTime` is somehow `70` (simulated)

**When**: `markIn()` is called

**Then** (assertions):
- **in-point-clamped**: `inPoint === 60` (clamped to duration)

#### Test: mark-with-no-source-noop (covers R22)

**Given**: `source === null`

**When**:
- `markIn()` is called
- `markOut()` is called

**Then** (assertions):
- **in-point-null**: `inPoint === null`
- **out-point-null**: `outPoint === null`
- **no-error**: no exception thrown

#### Test: recent-sources-dedup-by-path (covers R24)

**Given**:
- `setSource(A)` → `setSource(B)` → `setSource(C)` → `recentSources = [B, A]`
- `A = { path: 'pool/segments/a.mp3', ... }`

**When**: `setSource(A2)` is called where `A2.path === A.path` but `A2.label !== A.label`

**Then** (assertions):
- **recent-contains-c-only-once**: `recentSources[0].path === C.path`
- **recent-contains-b**: `recentSources[1].path === B.path`
- **recent-no-a**: no entry in `recentSources` has `path === A.path` (A was deduplicated)
- **recent-length-two**: `recentSources.length === 2`

#### Test: recent-sources-capped-at-max (covers R25)

**Given**: 12 distinct sources loaded in sequence via repeated `setSource` calls (sources 1..12, each with a unique path)

**When**: The final `setSource(12)` call completes

**Then** (assertions):
- **recent-length-ten**: `recentSources.length === 10`
- **oldest-dropped**: `recentSources` does NOT contain source 1 (dropped)
- **second-oldest-dropped**: does NOT contain source 2
- **newest-present**: `recentSources[0]` is the source that was loaded just before source 12 (source 11)

#### Test: recent-sources-cleared-on-reload (covers R26, R27)

**Given**: Multiple sources were loaded in a session

**When**: The page is reloaded (fresh component mount with no persisted data)

**Then** (assertions):
- **source-null**: `source === null`
- **recent-empty**: `recentSources.length === 0`

#### Test: project-switch-resets-source (covers R28)

**Given**:
- Project A is active
- A source is loaded
- `recentSources.length > 0`

**When**: The user switches to project B (projectName changes)

**Then** (assertions):
- **source-null**: `source === null`
- **recent-empty**: `recentSources.length === 0`

#### Test: clearsource-does-not-auto-activate-tab (covers R4)

**Given**: The `source-monitor` tab is not currently active; `source === null`

**When**: `clearSource()` is called (no-op case) or the program monitor tab is active and another caller sets `source = null`

**Then** (assertions):
- **tab-not-activated**: the previously-active tab remains active; the `source-monitor` tab is NOT brought to front
- **no-focus-steal**: the user's current tab context is preserved

#### Test: concurrent-setsource-during-play (edge — async ordering)

**Given**: Source A is loaded and playing

**When**:
- `setSource(B)` is called while A is mid-playback
- The underlying audio/video element for A is swapped out for B

**Then** (assertions):
- **a-paused**: A's audio element no longer emits `timeupdate` events
- **b-loaded**: B's audio element is present in the DOM with the correct src
- **playing-false**: `playing === false` (new sources start paused per R-implicit; user must click play again)
- **current-time-reset**: `currentTime === 0`
- **markers-cleared**: `inPoint === null`, `outPoint === null`

#### Test: no-persistence-across-reload (covers R26, R48) — negative assertion

**Given**: A source + recent sources + markers are set; user reloads

**When**: The new session starts

**Then** (assertions):
- **no-localstorage-read**: the source-monitor context does NOT read from `localStorage` for its initial state (structural check / spy)
- **no-workspace-view-read**: the source is NOT restored from the workspace-view payload
- **state-reset**: `source === null && recentSources.length === 0 && inPoint === null && outPoint === null`

#### Test: no-sync-to-program-monitor (covers R15) — negative assertion

**Given**: Source monitor is playing at `currentTime = 30`; program monitor playhead is at a different position

**When**: The program monitor's playhead moves (e.g., user scrubs the timeline)

**Then** (assertions):
- **source-currenttime-unchanged**: source monitor's `currentTime` is NOT affected by program monitor playhead changes
- **source-playing-unchanged**: source monitor's `playing` state is NOT affected

#### Test: no-variable-speed-controls (covers R16) — negative assertion

**Given**: The panel is rendered with a source loaded

**When**: The panel DOM is inspected

**Then** (assertions):
- **no-speed-buttons**: no elements with text matching `/0\.5x|1\.5x|2x/` or role=speed-selector are rendered

#### Test: video-zero-duration-edge (edge)

**Given**: A video source whose underlying file has zero or invalid duration (malformed mp4)

**When**: `loadedmetadata` fires with `duration = 0` or `NaN`

**Then** (assertions):
- **duration-set-zero**: `duration === 0`
- **scrub-disabled-or-no-op**: clicking the scrub bar is a no-op (cannot seek)
- **markin-no-op**: `markIn()` while `duration === 0` either sets `inPoint = 0` or is a no-op — spec implementers MUST pick one and document; test asserts one of: `inPoint === 0` OR `inPoint === null`

#### Test: peaks-endpoint-failure-falls-back-to-bar (edge, covers R9)

**Given**: An audio source with `poolSegmentId = 'ps_broken'`; the `/api/.../peaks` endpoint returns 500

**When**: The panel attempts to render the waveform

**Then** (assertions):
- **fallback-scrub-bar**: a plain scrubbable progress bar is rendered instead of the waveform
- **no-user-facing-error**: no error modal or toast is shown for the peaks failure — waveform is a nicety, not a blocker
- **transport-functional**: play/pause and scrub still work

#### Test: imperative-setsource-auto-activates (covers R3)

**Given**: The `source-monitor` tab is NOT active; `program` preview is active

**When**: A plugin imperatively calls `setSource(valid)`

**Then** (assertions):
- **tab-activated**: the `source-monitor` tab is now active in its group
- **program-tab-not-destroyed**: the `program` preview tab still exists in the group (activation, not closure)

#### Test: invalid-kind-value-rejected (bad path — type safety)

**Given**: A caller attempts `setSource({ kind: 'image', path: 'pool/images/x.png', label: 'cover' })` — `kind` is not one of the allowed discriminants

**When**: The call is made

**Then** (assertions):
- **runtime-rejected**: TypeScript compiler rejects at build time (compile-time assertion) OR runtime validator throws / rejects — spec implementer picks one; test asserts the call does NOT load `x.png` into the panel
- **source-unchanged**: `source` remains at whatever value it had before the invalid call

#### Test: drop-without-marks-preserves-existing-behavior (covers R30) — regression guard

**Given**:
- No in/out markers set on the source (or drag originated from the Bin, which doesn't emit the in-out payload)
- Drag payload contains `application/x-scenecraft-pool-path` only

**When**: The drop is handled by `AudioLane.onDropPoolAudio`

**Then** (assertions):
- **full-range-clip**: the created `audio_clips` row has `source_offset === 0` and length equal to the source's full duration (existing pre-spec behavior preserved)
- **no-in-out-read**: the handler does not attempt to parse `application/x-scenecraft-in-out` as JSON when it is absent (no runtime error)

---

## Open Questions

- **OQ-1 — Max size of `recentSources` stack.** Spec picks `10`; needs user confirmation. Alternatives: 5, 20, unbounded. Resolution: user selects value during implementation kickoff or accepts default of 10.
- **OQ-2 — Keyboard shortcuts in v1.** Design deferred to Future; spec defaults to no shortcuts. Should `Space` for play/pause be a v1 one-off exception? (Premiere/VLC users expect it.)
- **OQ-3 — "Reveal properties" target when Properties panel is undocked.** Design says "defer to existing workspace-view logic" but that logic is vague. Open: does the action re-dock the panel, open it in a floating popover, or silently no-op with a toast?
- **OQ-4 — `video-zero-duration-edge` behavior for `markIn` when `duration === 0`.** Spec test asserts one of two outcomes; implementer picks. Should spec pin this now?
- **OQ-5 — `variant_kind` stamp on subclip-created entities.** Design calls this out as Future; should the drop handler copy `source.metadata.variant_kind` onto the new `audio_clips` / transition row so color coding propagates? Deferred per design.
- **OQ-6 — Progress bar fallback when `poolSegmentId` is absent on audio source.** Spec says "scrubbable progress bar." Does this need waveform-like visual indication of position, or a plain `<input type="range">`?
- **OQ-7 — Right-click menu wiring on timeline video clip (R46).** The exact mechanism (ContextMenuProvider subscription? extension of existing `onContextMenu` handler?) is unspecified; implementers pick based on current timeline architecture.
- **OQ-8 — `invalid-kind-value-rejected` test outcome.** Spec lets implementer choose compile-time-only or runtime-guard. Should spec pin one? Compile-time-only is lighter but loses runtime safety for JSON-deserialized sources.

---

## Key Design Decisions

### Scope

| Decision | Choice | Rationale |
|---|---|---|
| MVP scope | Broad from day 1 — accept any `pool_segment` | Covers music gen + Bin + stems via the data model; finalize-range (video) layers on top. Simpler contract, fewer rewrites than "one caller first." |
| Media kinds supported | Video + audio (with waveform viz) | Matches the set of pool_segment kinds that can be previewed. |
| Cover art display | No | Kept chrome lean; deferrable if requested. |
| Milestone placement | Own milestone (not folded into finalize-range) | Multiple features depend on this; shipping standalone unblocks them independently. |

### Interaction model

| Decision | Choice | Rationale |
|---|---|---|
| Playhead | Independent of program monitor | NLE standard. A/B "sync to program" toggle rejected for v1 (YAGNI). |
| Hot-swap the program monitor? | No — side-by-side tabs in the preview panel group | Standard NLE pattern; both surfaces stay visible when split. |
| Playback speed | 1x only for v1 | JKL / variable speed deferred. |
| In/out markers | Yes, with crossed-marker invariant | Required for subclip extraction. |
| Subclip drag → timeline | Yes, kind-aware | Video creates kf+tr with reconciliation; audio creates `audio_clips`. |
| Recent sources | Premiere-style session-scoped stack, cap 10 | Flip back to a previous source without re-navigation. |
| Missing file behavior | "Source unavailable" state, no auto-close | Matches NLE offline-media pattern. |
| Persist source across reloads | No (always empty on reload) | Source monitor is ephemeral; avoids "unavailable after GC" on startup. |

### Visual design

| Decision | Choice | Rationale |
|---|---|---|
| Default layout slot | Tab in preview panel group (sibling to program monitor) | Auto-activates on load; users can split the group for side-by-side. |
| Empty state | Message ("Select a media item to preview") | Prefer affordance over hiding the tab. |
| Label display | Yes, in the panel header | Identifies which source is loaded. |
| Timecode | Yes (current / duration, M:SS format) | Standard transport affordance. |
| Metadata pane | No inline pane — "Reveal properties" action opens Properties panel | Reuses existing properties infra; keeps chrome lean. |
| Waveform for audio | Yes, with moving playhead cursor | Essential for scrubbing audio. |

### API

| Decision | Choice | Rationale |
|---|---|---|
| Hook shape | `useSourceMonitor()` → `{ source, setSource, clearSource, play, pause, seek, markIn, markOut, clearMarks, ... }` | Covers all v1 operations; clean surface. |
| `setSource` payload | Discriminated union `{ kind: 'video'\|'audio', path, label, poolSegmentId?, metadata? }` | Caller knows the kind; explicit avoids unreliable extension sniffing. `poolSegmentId?` enables "Reveal properties"; `metadata?` is escape hatch. |
| Plugin integration | Both paths — declarative contribution point with imperative fallback | Progressive enhancement. Plugins that declare `contributes.sourceMonitorProvider` get auto-wired menus; plugins that don't can still `setSource` directly. |
| Caller authorization | Open contract (any plugin can push a source) | Keeps the surface flexible; no curation overhead. |

### Relationship to existing inline previews

| Plugin / panel | v1 decision | Why |
|---|---|---|
| Music gen panel | Both — inline ▶ stays; single-click row also loads into source monitor | Inline = quick-listen; source monitor = scrub / in-out / detail. |
| Bin panel | Both — hover preview stays; single-click loads into source monitor | Hover = ambient awareness; click = evaluation. |
| Isolate vocals panel | Replace — drop inline `PoolAudioPlayButton`; single-click row → source monitor | Unifies the stem workflow under one surface. |
| Timeline clip (video) | Right-click → "Open source in source monitor" | Surfaces the pre-trimmed media without leaving the timeline. |

---

## Related Artifacts

- **Design**: `agent/design/local.source-monitor-panel.md` (v1.0.0) — the what/why; this spec is its implementation-ready companion
- **Clarification**: `agent/clarifications/clarification-13-source-monitor-panel.md` (Completed, 30 answers) — source of all design decisions
- **Related design**: `agent/design/local.finalize-range.md` — originator of the source-monitor concept; blocked on this spec's delivery
- **Related design**: `agent/design/local.interactive-preview-handles.md` — adjacent preview-surface work
- **Panel infrastructure**: `src/components/editor/EditorPanelLayout.tsx`, `src/components/panel-layout/*`
- **Reuse patterns**: `src/plugins/isolate_vocals/AudioIsolationsPanel.tsx` (`PoolAudioPlayButton`), `src/components/editor/AudioWaveform.tsx`, `src/plugins/generate-music/MusicGenerationsPanel.tsx` (recent play-button wiring)
- **Backend endpoints relied upon**: `GET /api/projects/:name/files/:path`, `GET /api/projects/:name/pool/:seg_id/peaks` (both existing)

---

**Namespace**: local
**Spec**: source-monitor-panel
**Version**: 1.0.0
**Status**: Proposal
