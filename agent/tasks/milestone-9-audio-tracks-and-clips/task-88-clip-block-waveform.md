# Task 88: Audio Clip Block + Waveform Rendering

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 6-8 hours  
**Dependencies**: Task 87 (lane), Task 82 (schema)  
**Status**: Not Started  

---

## Objective

Render each audio clip as a block on its audio lane with a waveform overlay. Waveform data is a pre-computed peak array (float16) fetched from the server on first demand and cached in IndexedDB for reuse across sessions.

---

## Context

Waveform rendering is in scope per clar-7 answer. Server-side peak computation is cheaper than client-side decode of the audio file; a flat peak array at ~400 peaks/sec is sufficient for visual fidelity on a 2K monitor.

---

## Steps

### 1. Server: peak array endpoint

`GET /api/projects/:name/audio-clips/:id/peaks?resolution=400` returns a float16 array of absolute peaks per sample window. Cached on disk per `(source_path, source_offset, duration, resolution)`.

Implementation:
- Use `numpy` + `soundfile` or `pydub` to load the source range
- Downsample to the requested resolution (e.g. 400 peaks/sec), taking `max(abs(samples))` per window
- Store as float16 (values 0..1) to halve bandwidth
- Return as raw bytes with content-type `application/octet-stream`

### 2. Client: `AudioWaveform.tsx`

Canvas-based renderer. Props: `clipId`, `durationSeconds`, `pixelsPerSecond`, `height`. Fetches peaks from `waveform-cache.ts` on mount; draws vertical lines top-to-bottom scaled by peak value.

Performance:
- Use `devicePixelRatio` for crisp rendering on HiDPI
- Clip to visible range via scroll/viewport-aware draw
- Skip re-draw when clip width < 16 px (too thin to be meaningful)

### 3. Client: `waveform-cache.ts`

- `fetchPeaks(projectName, clipId, resolution)` — returns `Float32Array`
- IndexedDB key: `${projectName}:${clipId}:${resolution}`
- TTL: clear when clip's `source_path` or `source_offset` changes (include those in the cache key)
- Concurrency: de-duplicate in-flight requests for the same key

### 4. `AudioClipBlock.tsx`

- Bounding block with border, background tint matching track colour
- `<AudioWaveform>` overlay
- Selection handle (click selects, drag moves — full drag implemented in task 89)
- Mute indicator (crossed circle) when `muted`
- Muted visual overlay (reduced opacity)

### 5. Tests

- Waveform renders at various resolutions without artifacts
- Cache hits on repeat render don't re-fetch
- Clip block highlights on click and surfaces the properties panel

---

## Verification

- [ ] Server peaks endpoint returns correctly-shaped float16 buffer
- [ ] Waveform draws on HiDPI cleanly
- [ ] Cache keyed by (source_path, source_offset, duration, resolution) prevents stale data
- [ ] No visible lag with ≥50 clips on screen
- [ ] Muted clips render with reduced opacity + indicator

---

**Next Task**: [Task 89: Drag/drop insert + auto-link](task-89-drag-drop-insert.md)
