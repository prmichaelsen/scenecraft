# Milestone 8: Characters & Lip-Sync

**Goal**: Introduce Character as a first-class entity owning reference images and an ElevenLabs voice; add per-transition lip-sync via WhisperX diarization + ElevenLabs S2S + Sync.so with multi-speaker support
**Duration**: ~3 weeks (~59 estimated hours)
**Dependencies**: [M6 — Git-Style Version Control](milestone-6-git-version-control.md) (soft — VCS diff integration task depends on M6 task-40)
**Status**: Not Started

---

## Overview

Today each Veo-generated transition has auto-cloned, drift-prone audio, and reference images are loose paths on transitions with no semantic grouping. This milestone introduces a `Character` entity — name, voice_id, reference images — and wires it into both Veo generation (ref images from named characters in the action text) and a new post-processing lip-sync flow (WhisperX for speaker diarization + transcript, ElevenLabs S2S for voice conversion per speaker, Sync.so for lip-sync).

Design doc: [local.characters-and-lipsync.md](../design/local.characters-and-lipsync.md)

---

## Deliverables

### 1. Characters
- `characters` SQLite table + server-generated `char_{hex8}` IDs + case-insensitive unique names
- CRUD API endpoints + content-addressed ref image upload (`assets/character_ref_images/{sha256}.png`)
- Characters dockview panel (top-level) with list, detail view, voice picker, ref image grid
- ElevenLabs voice list proxy + cached voice sample preview

### 2. Action-Text Resolution
- Replace `transitions.ingredients` with character-based resolution
- At Veo gen time, scan the action prompt for character names, merge their ref images as Veo ingredients

### 3. Lip-Sync
- `transition_lipsyncs` SQLite table + `transitions.active_lipsync_id` column
- Two-stage flow: `/lipsync/diarize` (WhisperX, cheap + fast) → `/lipsync/generate` (per-segment S2S + Sync.so)
- Ambient audio preserved in non-speech gaps; speech replaced with consistent character voices
- Single-speaker optimization: skip diarization when only one character is named
- Lip-Sync tab in TransitionPanel with speaker mapping UI + transcript display + candidate list
- Stale lipsync detection via source-video hash
- Playback wiring: preview and render pipeline prefer `active_lipsync_id` output when set

### 4. VCS Integration
- Add `characters` and `transition_lipsyncs` to `DIFFABLE_TABLES`
- Merge conflict handling for case-insensitive character name collisions
- `last_modified_by` columns on both tables per existing attribution pattern

---

## Success Criteria

- [ ] User can create, rename, and delete characters with name + voice_id + ref images
- [ ] Writing a character name in a transition's action text auto-includes their ref images as Veo ingredients on next generation
- [ ] Opening the Lip-Sync tab on a transition with selected video runs WhisperX diarization and displays detected speakers + transcript
- [ ] User can map detected speakers to characters and generate a lip-sync variant
- [ ] Multi-speaker scenes produce lip-synced output with each character's consistent voice preserved across segments
- [ ] Original Veo clip is preserved; lip-sync outputs stored as candidates; user can toggle active variant
- [ ] Stale lipsync badge appears when the source Veo clip has changed since generation
- [ ] Preview and render pipeline play the active lipsync variant when set, else fall back to the raw Veo clip
- [ ] Characters and lipsync rows diff correctly through branch/merge; same-name collision surfaces as a merge conflict

---

## Tasks

1. [Task 57: Characters schema + migration](../tasks/milestone-8-characters-and-lipsync/task-57-characters-schema.md)
2. [Task 58: Transition lipsyncs schema + active_lipsync_id column](../tasks/milestone-8-characters-and-lipsync/task-58-lipsyncs-schema.md)
3. [Task 59: Character CRUD API + content-addressed ref image upload](../tasks/milestone-8-characters-and-lipsync/task-59-character-crud-api.md)
4. [Task 60: ElevenLabs voice list proxy + sample preview cache](../tasks/milestone-8-characters-and-lipsync/task-60-elevenlabs-voice-proxy.md)
5. [Task 61: Frontend Characters panel (dockview)](../tasks/milestone-8-characters-and-lipsync/task-61-characters-panel.md)
6. [Task 62: Action-text character resolver + Veo ingredient wiring](../tasks/milestone-8-characters-and-lipsync/task-62-action-text-resolver.md)
7. [Task 63: Lipsync render module (WhisperX + S2S + Sync.so)](../tasks/milestone-8-characters-and-lipsync/task-63-lipsync-render-module.md)
8. [Task 64: Lipsync API endpoints + job manager integration](../tasks/milestone-8-characters-and-lipsync/task-64-lipsync-api.md)
9. [Task 65: Frontend Lip-Sync tab in TransitionPanel](../tasks/milestone-8-characters-and-lipsync/task-65-lipsync-tab.md)
10. [Task 66: Stale lipsync detection + regenerate flow](../tasks/milestone-8-characters-and-lipsync/task-66-stale-detection.md)
11. [Task 67: VCS integration — diffable tables + merge conflicts](../tasks/milestone-8-characters-and-lipsync/task-67-vcs-integration.md)
12. [Task 68: Playback wiring for active lipsync variant](../tasks/milestone-8-characters-and-lipsync/task-68-playback-wiring.md)

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation Strategy |
|------|--------|-------------|---------------------|
| WhisperX diarization quality on short Veo clips | Medium | Medium | Fall back to single-speaker mode if only one speaker detected; always show transcript for user review |
| Sync.so face detection fails on non-human Veo clips | Medium | Medium | UI shows error + suggests clip has no visible face; generation gracefully fails |
| Per-segment S2S stitching artifacts at boundaries | Medium | Low | Crossfade 20ms between segments; preserve ambient as underlay |
| ElevenLabs voice drift between S2S calls on same voice_id | Low | Low | Confirmed consistent in throwaway testing |
| Cost of WhisperX + S2S + Sync.so per clip | Medium | High | ~$0.35-0.50/clip; surface cost estimate in UI before generation |
| VCS merge conflict on character name collision | Low | Medium | Surface constraint violation as a merge conflict with "keep both, rename one" UX |

---

## Prerequisites

- `SYNC_API_KEY` env var configured on scenecraft-engine server
- `ELEVENLABS_API_KEY` env var configured on scenecraft-engine server
- `REPLICATE_API_TOKEN` env var configured for WhisperX hosted endpoint

---

**Next Milestone**: TBD
