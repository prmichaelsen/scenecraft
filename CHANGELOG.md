# Changelog

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
