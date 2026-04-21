# Task 90: Volume Curve Editor (Clips + Tracks)

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 4-6 hours  
**Dependencies**: Task 82 (schema), Task 88 (clip selection)  
**Status**: Not Started  

---

## Objective

Expose a curve editor in the properties panel for editing volume curves on audio clips (normalised x, dB y) and audio tracks (absolute seconds x, dB y). Reuse the existing color-grading curve editor component pattern.

---

## Context

Volume curves are stored as JSON `[[x, db], ...]` on `audio_clips.volume_curve` (x normalised 0..1) and `audio_tracks.volume_curve` (x in absolute timeline seconds). Rendering layer (Task 91) evaluates them; this task is the authoring UI.

---

## Steps

### 1. `VolumeCurveEditor.tsx`

Thin wrapper around the existing `CurveEditor` (or whichever component powers color-grading curves). Props:

```typescript
type Props = {
  curve: CurvePoint[]                // [[x, db], ...]
  onChange: (curve: CurvePoint[]) => void
  xAxis: 'normalised' | 'seconds'
  xAxisMax?: number                  // project duration if xAxis === 'seconds'
  yRange?: [number, number]          // default [-60, +12] dB
  yLabel?: string                    // default "dB"
}
```

Visual differences from color curves:
- Y-axis labelled in dB with 0 dB prominent (unity gain), gridlines at -6, -12, -24, -48 dB
- Negative infinity / mute shown as a bar at the bottom; curve doesn't smoothly approach it
- X-axis labels: "0 … 1.0" for normalised, "0s … {project_duration}s" for seconds

### 2. Wire into the properties panel

When an audio clip is selected, show:
- Clip name / source path (read-only)
- Duration, volume curve editor (normalised), mute toggle, link-to-transition info

When an audio track is selected (via track header click?):
- Track name, volume curve editor (seconds), mute toggle, enabled toggle

Commits on blur / curve-drag-end → POST `/api/projects/:name/audio-clips/update` or `/audio-tracks/update` respectively.

### 3. Performance

- Debounce save on drag (150-250 ms)
- Local curve state on the editor for immediate feedback; commit to server after settle

### 4. Tests

- Adding points preserves ordering by x
- Y clamped to `[-60, +12]` in UI (not storage)
- Saving round-trips to server and reloads correctly
- Track curve editor uses seconds axis with project duration as max

---

## Verification

- [ ] Curve editor renders for selected clip and shows its current curve
- [ ] Track curve editor renders for selected track with seconds axis
- [ ] Edits save to server on settle
- [ ] Curves reload correctly across page refresh
- [ ] Mute toggle is visually separate from the curve

---

**Next Task**: [Task 91: Multi-track mixdown + crossfade](task-91-mixdown-renderer.md)
