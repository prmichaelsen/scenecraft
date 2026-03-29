# Task 1: Audio Intelligence Integration

**Milestone**: M1 - Audio Intelligence Integration
**Design Reference**: [frontend-gaps](../../design/local.frontend-gaps.md)
**Estimated Time**: 8-12 hours
**Dependencies**: None
**Status**: Not Started

---

## Objective

Replace raw `beats.json` with the rule-processed audio intelligence data (`layer3_events`) as the primary beat/effect source for the WebGL preview and FX track. Allow users to select which audio intelligence file to use, swap between files, and mix sections from different analysis files.

---

## Context

The editor currently reads `beats.json` (raw beat detection) for the WebGL beat-reactive preview and beat markers on the timeline. The beatlab pipeline produces much richer `audio_intelligence_*.json` files containing:

- **layer1**: per-instrument onset times (kick, snare, hh, crash, ride)
- **layer2**: 30 sections with descriptions
- **layer3_rules**: 283 rules mapping stems/bands to effects with intensity/duration
- **layer3_events**: 10,497 applied effect events (time, duration, effect type, intensity, sustain, stem source)

The `layer3_events` are the actual rule-processed beats — what the render pipeline uses. The editor should use these instead of raw beat detection.

Multiple audio intelligence files may exist per project (v1-v6 iterations). Users need to:
1. Select which file is active
2. Swap between files to compare
3. Optionally mix sections from different files

---

## Steps

### 1. Add `audio_intelligence_file` to project config

Add a field to `project.yaml` (or `meta` in legacy format) that specifies the active audio intelligence JSON file path. Default: auto-detect the latest `audio_intelligence_*.json` in the project directory.

### 2. Create `/api/projects/:name/audio-intelligence` endpoint

- `GET` — returns `layer3_events` from the configured file, plus available files list
- `POST` — switch the active file (updates config)
- Response shape:
  ```json
  {
    "activeFile": "audio_intelligence_fully_zoned_v6.json",
    "availableFiles": ["audio_intelligence_final.json", "audio_intelligence_fully_zoned_v6.json", ...],
    "events": [{ "time": 0.5, "duration": 0.2, "effect": "pulse", "intensity": 0.8, "sustain": 0, "stem_source": "kick" }],
    "sections": [{ "start_time": 0, "end_time": 25, "description": "Ethereal Opening" }],
    "rules": [{ "stem": "kick", "effect": "zoom", "intensity_scale": 1.2, ... }]
  }
  ```

### 3. Update EditorData to include audio intelligence events

- Add `audioEvents` field (layer3_events) to EditorData
- Add `audioIntelligenceFile` and `availableAudioFiles` fields
- Fetch from the new endpoint in the loader (with graceful fallback to beats.json)

### 4. Update WebGL BeatEffectPreview to use audio events

- Replace `findEffectIntensity` beat lookup with audio intelligence events
- Audio events have richer data: effect type (pulse/zoom/shake/glow/flash), duration, intensity, sustain
- Map each event type to the appropriate shader parameter

### 5. Update beat markers on the timeline

- Replace `BeatMarkers` component data source with audio intelligence events
- Color-code markers by stem source (kick=red, snare=blue, hh=gray, etc.)
- Optionally show only specific stems

### 6. Add audio intelligence file selector to Settings panel

- Dropdown showing available files with modification dates
- Switch triggers reload of audio events
- Show file metadata (event count, rule count, section count)

### 7. Per-section beat source selection (stretch goal)

- Allow selecting a different audio intelligence file per section
- Mix: "use v6 for chorus, v3 for verse"
- Store in project config as section overrides

---

## Verification

- [ ] `audio_intelligence_file` field exists in project config
- [ ] GET /audio-intelligence returns events from the configured file
- [ ] POST /audio-intelligence switches the active file
- [ ] EditorData includes audio events
- [ ] WebGL preview uses audio intelligence events instead of raw beats
- [ ] Beat markers on timeline reflect audio intelligence data
- [ ] Settings panel shows file selector
- [ ] Fallback to beats.json when no audio intelligence file exists
- [ ] Available files list detected correctly from project directory

---

## Key Design Decisions

### Data Source

| Decision | Choice | Rationale |
|---|---|---|
| Primary data | layer3_events | Rule-processed events match what the render pipeline uses |
| Fallback | beats.json | Backward compat for projects without audio intelligence |
| File selection | Stored in project.yaml | Persists across sessions, per-project setting |
| Section mixing | Per-section overrides in config | Allows fine-grained control without full file replacement |

---

## Notes

- Audio intelligence files are 230MB+ — should NOT be loaded into memory in the frontend. Backend should extract and return only the needed data.
- `layer3_events` has ~10k events per file — this is manageable in the browser.
- The `layer2` sections map cleanly to the existing `sections` display on the timeline.
- Event `effect` types (from rules) should map to the existing WebGL shader effects and FX track types.

---

**Next Task**: task-2-settings-panel.md
**Related Design Docs**: [local.frontend-gaps](../../design/local.frontend-gaps.md)
**Estimated Completion Date**: TBD
