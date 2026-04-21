# Changelog

## [0.14.0] - 2026-04-21

### Added
- M9 Task 90 — Volume curve editor. Click an audio clip or audio track on the Timeline to select it; the Properties panel shows a canvas-based `VolumeCurveEditor` with dB axis (range [-60, +12], gridlines at -48/-24/-12/-6/0/+6/+12, unity dashed at 0 dB).
  - **Clips**: normalized x (0..1) curve, mute toggle, source/duration/offset readout.
  - **Tracks**: seconds x (0..project_duration) curve, mute + enabled toggles, name/order readout.
  - Interaction: click empty area to add, drag to move, right-click to remove (min 2 points), endpoints locked at boundaries. Saves debounced 200 ms via `POST /audio-clips/update` / `/audio-tracks/update`.
- `EditorStateContext` gained `selectedAudioClipId` / `selectedAudioTrackId` with mutex against existing selections; `AudioLane` + `AudioClipBlock` handle clicks.
- Properties panel auto-activates on audio selection (via `AutoActivatePropertiesEffect`).

## [0.13.0] - 2026-04-21

### Added
- M9 Task 89 — Drop-to-auto-link audio. Dropping a pool video onto an existing transition, or duplicating another transition's video, now extracts + links its audio automatically. Backend: `_handle_assign_pool_video` and `duplicate-transition-video` both call `link_audio_for_transition(replace=True)` after success (non-fatal on failure); response now includes `audioLink`.
- `getTimelineData` server-fn now also fetches `audioTracks` so `refreshTimeline()` picks up new audio clips after any drop/assign/duplicate.
- `Timeline.tsx` uses `localAudioTracks` state (mirrors `localKeyframes`/`localTransitions`) so the audio lane updates without a full route invalidate.

## [0.12.0] - 2026-04-19

### Added
- M9 Task 88 — Waveform rendering on audio clip blocks. Server computes float16 peak arrays (mono, 400 peaks/sec default) on demand via ffmpeg-decoded PCM; cached on disk under `audio_staging/.peaks/` keyed by source path + mtime + offset + duration + resolution.
- `GET /api/projects/:name/audio-clips/:id/peaks?resolution=N` returns raw `application/octet-stream` float16 little-endian bytes with `X-Peak-Resolution` and `X-Peak-Duration` headers.
- Frontend `waveform-cache.ts` fetches + caches peak arrays module-wide, decodes float16 → float32 inline, de-dupes concurrent requests for the same clip.
- `AudioWaveform.tsx` canvas renderer: draws vertical mirrored peaks across the clip block width, max-pools when peaks > pixels, HiDPI-aware, skips below 16 px width.
- `AudioLane` clip blocks now overlay the real waveform instead of the placeholder stripe.

## [0.11.0] - 2026-04-19

### Added
- M9 Task 87 — Audio lanes on the Timeline. Multi-track audio tracks render inside the existing Audio section, sorted ascending by `display_order` (mirrored below video per the M9 design). Clips appear as positioned cyan blocks at their `start_time`/`end_time` scaled by `pxPerSec`; muted tracks/clips render dimmed. Track header (sticky left) shows `A{N} + name + muted` marker.
- `src/lib/audio-client.ts` — REST client for audio tracks/clips (`fetchAudioTracks`, `fetchAudioClips`) with types (`AudioTrack`, `AudioClip`, `AudioClipLink`, `CurvePoint`). `AudioTrack.clips` is populated inline by the `/audio-tracks` endpoint so one SSR fetch covers both.
- `src/components/editor/AudioLane.tsx` — per-track row component rendering clips as timeline-positioned blocks.
- `EditorData.audioTracks` added to the server-fn preload — audio lanes render from SSR data with no client-side fetch and no loading flash (follows the `tanstack-cloudflare.ssr-preload` pattern).

## [0.10.0] - 2026-04-19

### Added
- `m` keyboard shortcut places a marker at the current playhead time

### Changed
- Marker track now requires a double-click to add a marker (was single-click) — reduces accidental markers when grabbing the playhead

### Fixed
- Dragging a clip edge no longer reseeks the playhead to the release position — synthetic click events after edge drags are now swallowed on both video and transition tracks
- Playhead scrub jitter: audio seek+play bursts during playhead drag are throttled to ~120 ms with a trailing-edge commit, so visual scrubbing stays smooth at 60 fps instead of stuttering under audio subsystem churn

## [0.9.0] - 2026-04-19

### Added
- MCP integrations panel — dockview sibling panel listing OAuth-backed services (Remember today) with Connect / Disconnect, live token expiry, refresh-token status, and inline errors
- `MCP` tab in the default chat panel group so the connection UI is reachable without opening the add-panel menu
- `validateLayout` helper in `@/components/panel-layout` — sanitises a candidate `LayoutNode` tree against the current panel registry; drops unknown tab IDs and rejects malformed splits/groups

### Fixed
- Editor no longer crashes on mount when `_autosave_v3` contains a malformed node. `EditorPanelLayout` now validates saved layouts; invalid saves are discarded and overwritten with the default layout. Prevents "Cannot read properties of undefined (reading '0')" in `PanelLayout` tree traversal.

### Changed
- Remember connect/disconnect moved out of the chat input footer into the MCP panel
- `ChatDockPanel` and `PlaceholderPanel` defensively handle missing `params` from legacy dockview saves
- `EditorLayout` (dockview variant, currently unused) wraps `DockviewReact` in a `LayoutErrorBoundary` that clears a corrupt `_autosave` and soft-reloads

## [0.8.3] - 2026-04-18

### Added
- Wire real ChatPanel into EditorPanelLayout (replaces "Chat (coming soon)" placeholder in v2 layout)

### Fixed
- Chat: user messages no longer double-render — server echo of optimistic user message replaces the local placeholder instead of appending

## [0.8.2] - 2026-04-12

### Fixed
- Playback performance: remove currentTime from useEffect/useCallback deps across Timeline, use refs instead
- Memoize expensive inline computations (currentKeyframe, activeTransition, crossfadeData, trackLayers, adjacency maps)
- Wrap 11 child components in React.memo to skip re-renders when props unchanged during playback
- Split preload effect: timestamps always fresh for correct eviction, decode enqueues throttled to 1s
- Throttle preload scan to prevent 60x/sec keyframe+transition iteration

## [0.8.1] - 2026-04-11

### Added
- Up/Down arrow hotkeys to jump playhead to previous/next keyframe (edit point navigation)
- Left/Right arrow hotkeys to step playhead one frame forward/backward at project fps

### Changed
- Keyframe navigation moved from Left/Right arrows to Up/Down arrows to match NLE conventions

## [0.4.0] - 2026-03-29

### Added
- WebGL crossfade shader for smooth 8-frame overlap transitions at all boundaries (kf->tr, tr->kf, slot->slot, tr->tr)
- Two-tier frame cache with IndexedDB persistence — decoded frames survive page reloads
- Concurrency-limited preload queue (max 2 concurrent video decodes) to prevent memory explosion
- Playhead-proximity eviction — farthest entries evicted first, nearest stay hot
- Status bar with operations queue panel showing decode progress and WebSocket job status
- Render progress bars on transition track segments (red = decoding, green = complete)
- Persistent storage request (`navigator.storage.persist()`) to prevent browser cache eviction
- Keyframe image caching in IndexedDB alongside transition frames
- Per-effect-type suppression zones (suppress specific effect types instead of all beats)
- Preview quality loaded in route loader to eliminate resolution flip-flop on page load
- Memory usage display in status bar with configurable 32GB limit

### Changed
- Frame cache resolution embedded in IndexedDB keys so different resolutions coexist
- IndexedDB restore runs immediately (bypasses decode queue) for fast cold->hot promotion
- Persist to IndexedDB before cacheSet to prevent LRU eviction from corrupting in-flight writes
- `isLoaded()` now returns true for both hot (in-memory) and cold (IndexedDB-only) entries
- Crossfade at transition boundaries uses adjacent transition frames when available (not just keyframe stills)

### Fixed
- Stale keyframe image rendering when playhead moves to keyframe without selected image
- IndexedDB cache being wiped on every page load due to preview quality state initialization race
- Silent IndexedDB read failures now logged for debugging
