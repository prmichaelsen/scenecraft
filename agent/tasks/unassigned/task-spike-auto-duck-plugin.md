# Task Spike: Auto-Duck Plugin Investigation

**Milestone**: Unassigned (future plugin milestone, post-M17 lifecycle work)
**Design Reference**: Pending — this spike produces the design doc
**Estimated Time**: 1-2 days
**Dependencies**: None for the spike itself; implementation depends on M17 plugin lifecycle
**Status**: Not Started

---

## Objective

Design an **auto-duck plugin** that automatically lowers the volume of music/background tracks when dialogue-like audio is present on other tracks. Surfaces as a scenecraft plugin rather than a built-in feature, validating the plugin architecture on a non-generation use case.

---

## Context

Clarification-10 Q5.3 surfaced the idea of auto-ducking a "Music" track to -12dB so it sits under dialogue tracks by default. User's direction: **no auto-duck baked into the music-gen plugin; auto-duck belongs as its own plugin.** This spike captures what that plugin looks like.

Auto-ducking is a classic NLE feature — sidechain compression triggered by dialogue detection — and makes a good second-class plugin to validate the architecture for plugins that *modify volume curves* rather than *produce new audio segments*.

---

## Steps

### 1. Define the operation

What does the plugin do, exactly?

- **Input**: a set of audio tracks in a project (dialogue tracks as "triggers," music/ambience tracks as "ducked").
- **Analysis**: run voice-activity detection (VAD) or RMS-threshold analysis on trigger tracks to find speech regions.
- **Output**: write volume-curve keyframes on ducked tracks that drop volume during speech regions and restore during gaps. Ramps (not hard cuts) to avoid pumping artifacts.
- **Runs persistently?** Or one-shot? Probably one-shot operation that writes curves — user can re-run after edits. (Alternative: live sidechain compression at playback time — more complex, not MVP.)

### 2. UX: where does it live?

- Panel or dialog? Probably a small **AutoDuckPanel** that lists tracks + trigger/ducked assignment + duck-depth parameter + Run button.
- Entry points: context menu on `audio_track` ("Duck this track under…"), command palette, chat tool.
- Output preview: volume curve overlays on the timeline showing the generated ducks before commit.

### 3. Schema implications

- Does this need a new table? Probably `auto_duck__runs(id, project_id, trigger_tracks_json, ducked_tracks_json, depth_db, attack_ms, release_ms, status, created_at)` for history + Reuse, mirroring `generate_music__generations`.
- Plugin-owned tables follow the `<plugin_id>__<name>` convention (clarification-10 Item 2.1).
- Writes to core tables? Volume-curve keyframes on `audio_tracks` (or wherever curves land per M9 volume-curve design). Plugin writes `created_by='plugin:auto-duck'` on new curve points.

### 4. Algorithm decisions

- VAD vs RMS threshold: VAD is more accurate but heavier; RMS is fast. MVP probably ships RMS with a tunable threshold; VAD (via webrtcvad or similar) is a follow-on.
- Attack/release defaults: common values are attack 10-50ms, release 200-500ms.
- Duck depth default: -12dB matches the "typical" auto-duck feature; user-configurable.

### 5. Industry reference

Look at how similar NLEs expose this:
- Premiere Pro "Auto Duck" (Essential Sound panel).
- Resolve Fairlight "dialogue leveler."
- Audition "auto-ducking."

Pick UX + parameter naming from the most familiar one.

### 6. Write design doc

Produce `agent/design/local.auto-duck-plugin.md` covering:
- Operation, I/O, algorithm
- Panel + entry points
- Schema (runs table, curve output)
- Plugin manifest shape
- Tradeoffs (one-shot vs live sidechain; RMS vs VAD)
- Dependencies on M17 plugin lifecycle (when can this ship?)

### 7. Rough milestone sizing

Sketch task list + estimates for the eventual implementation milestone. Probably ~4-5 tasks, ~1 week, contingent on M17 having landed.

---

## Deliverables

- [ ] `agent/design/local.auto-duck-plugin.md` — complete design doc
- [ ] Rough task breakdown with milestone sizing
- [ ] Optionally: `clarification-*-auto-duck-plugin.md` if new questions surface

---

## Notes

- This spike is *design-only*. No implementation code.
- Implementation is gated on M17 plugin lifecycle work being done (so the plugin can contribute its own schema migration).
- Until then, the design doc sits as a reference for when scenecraft has a third plugin to ship.
- Nice side effect: validates the plugin architecture on a *curve-writing* use case rather than a *segment-generating* one — useful stress test for the plugin API surface.
