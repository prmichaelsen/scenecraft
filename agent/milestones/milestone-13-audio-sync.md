# Milestone 13: Audio Sync Tab (Lipsync via Candidate Variants)

**Goal**: Ship an **Audio Sync** tab on `TransitionPanel` that produces lipsync variants of transition candidates via sync.so + ElevenLabs (both TTS and S2S input modes). Variants attach to their source candidate via a new `derived_from` parent link on `pool_segments`; selection model stays unchanged.
**Duration**: 2–3 weeks
**Dependencies**: `pool_segments` / `tr_candidates` (shipped); existing job manager + `/ws/jobs` channel (shipped)
**Status**: Not Started

---

## Overview

This milestone is the first full implementation of "candidate variants" — a per-candidate transform whose output is itself a candidate on the same transition, distinguished by a parent link and a variant kind. The lipsync MVP uses sync.so's native ElevenLabs provider for TTS (one round trip) and a server-side ElevenLabs S2S hop for Audio input, then passes to sync.so.

A working prototype (`scenecraft-engine/scripts/sync_lipsync_test.py`) proved the sync.so + ElevenLabs pipeline end-to-end on 2026-04-19. This milestone productionizes that prototype and wires the UX.

**Design**: [local.audio-sync.md](../design/local.audio-sync.md)

Supersedes the lipsync pipeline portion of [local.characters-and-lipsync.md](../design/local.characters-and-lipsync.md) (character-entity + multi-speaker diarization work in that doc remain valid as follow-on scope).

---

## Deliverables

### 1. Schema Additions

- `pool_segments.derived_from TEXT REFERENCES pool_segments(id)` (nullable)
- `pool_segments.variant_kind TEXT` (nullable; `'lipsync'` for MVP)
- `CREATE INDEX idx_pool_segments_derived_from ON pool_segments(derived_from) WHERE derived_from IS NOT NULL`
- Backend helpers updated to read/write the new columns
- `candidateDetails[]` API response gains `derivedFrom` and `variantKind`

### 2. Backend Lipsync Endpoint

- `POST /api/projects/:name/transitions/:tr_id/lipsync`
  - TTS mode: `{ source_pool_segment_id, mode: 'tts', voice_id, script, options? }`
  - S2S mode: `{ source_pool_segment_id, mode: 's2s', voice_id, source_audio_ref, options? }`
  - Returns `{ jobId }`
- Job manager integration; WS progress events on `/ws/jobs` (`uploading` / `s2s` / `processing` / `downloading`)
- Productionized sync.so client (from `scripts/sync_lipsync_test.py`) with multipart upload + polling
- ElevenLabs S2S client for Audio mode (preferred path: native sync.so S2S if available)
- On completion: write `pool/segments/cand_<new_uuid>.mp4`, insert `pool_segments` with `variant_kind='lipsync'` + `derived_from=<source>`, insert `tr_candidates` junction

### 3. Audio Sync Tab (Frontend)

- New `src/components/editor/AudioSyncTab.tsx`
- Tab slot on `TransitionPanel`: `details · candidates · audio-sync · browse · bench`
- Inline generate form at top: source candidate picker, audio-mode toggle (Script/Audio), voice dropdown, script textarea **or** audio input, options
- Grid below (reuses `LazyVideoCard` with `derivedFromLabel` prop)
- Each card shows `from v{d}` chip (live-computed rank from `added_at ASC`) + Resync + Bench + overflow
- Click card → standard select (sets `transitions.selected[slot]`); no auto-select on generation completion

### 4. Hover-Driven Preview Override

- `previewSourceOverride` state on the render preview panel
- Hover `from v{d}` chip → override to raw source candidate
- Hover card body → override to lipsynced output
- Release → pop override, snap back to playhead frame

### 5. Candidates Tab Filter

- Existing Candidates tab filters `candidateDetails` to `variantKind == null`
- Variants live exclusively in the Audio Sync tab so the raw-take view stays clean

### 6. Resync

- One-click identical re-run (same source/voice + same script-or-audio → new take)
- New take appends to the grid; does NOT auto-select

### 7. ElevenLabs Voice List

- MVP: client-side fetch `GET https://api.elevenlabs.io/v1/voices` with an API key from project settings
- In-memory cache for the session
- Server-side proxy with caching deferred (aligns with M8 Task-60)

---

## Success Criteria

- [ ] Schema migration is idempotent on both fresh and existing DBs
- [ ] `candidateDetails[]` returns `derivedFrom` + `variantKind` for each candidate
- [ ] `POST /lipsync` (TTS) produces a new candidate on the same transition with `variant_kind='lipsync'`, `derived_from=<source>`, and a file at `pool/segments/cand_<uuid>.mp4`
- [ ] `POST /lipsync` (S2S) consumes a source audio ref, runs ElevenLabs S2S, passes to sync.so, produces the same shape of output
- [ ] Audio Sync tab renders, loads existing variants, and generates new ones via the form
- [ ] `from v{d}` chip reflects the live rank of the source candidate within the transition
- [ ] Hovering the chip plays the raw source in the render preview; hovering the card plays the synced output; release snaps back to the playhead frame
- [ ] Clicking a card selects it (the timeline renders the variant); Generate/Resync completion does NOT auto-select
- [ ] The Candidates tab no longer shows lipsync variants
- [ ] Resync produces a new take with identical params
- [ ] ElevenLabs voice list populates the voice dropdown
- [ ] End-to-end smoke (mocked sync.so): form submit → job events → card appears → hover drives preview → click selects → timeline renders lipsync

---

## Key Files to Create / Modify

```
scenecraft/                                                   (frontend repo)
├── src/
│   ├── components/editor/
│   │   ├── AudioSyncTab.tsx                                  (NEW)
│   │   ├── TransitionPanel.tsx                               (MOD: add tab + filter Candidates)
│   │   └── LazyVideoCard.tsx                                 (MOD: derivedFromLabel + hover handlers)
│   └── lib/
│       ├── scenecraft-client.ts                              (MOD: postLipsync, postLipsyncResync)
│       └── elevenlabs-client.ts                              (NEW: voice list fetch + cache)
└── agent/
    └── design/local.audio-sync.md                            (already shipped)

scenecraft-engine/                                            (backend repo)
├── src/scenecraft/
│   ├── db.py                                                 (MOD: derived_from + variant_kind + helpers)
│   ├── api_server.py                                         (MOD: /lipsync endpoint)
│   ├── lipsync/                                              (NEW)
│   │   ├── __init__.py
│   │   ├── sync_client.py                                    (productionized from scripts/sync_lipsync_test.py)
│   │   └── elevenlabs_s2s.py                                 (S2S pre-step for Audio mode)
│   └── tests/test_lipsync.py                                 (NEW)
└── scripts/sync_lipsync_test.py                              (already moved in)
```

---

## Tasks

1. [Task 106: Schema migration (derived_from + variant_kind)](../tasks/milestone-13-audio-sync/task-106-schema-migration.md) — 2h
2. [Task 107: Backend /lipsync endpoint — TTS mode](../tasks/milestone-13-audio-sync/task-107-backend-tts.md) — 5h
3. [Task 108: Backend /lipsync endpoint — S2S mode](../tasks/milestone-13-audio-sync/task-108-backend-s2s.md) — 4h
4. [Task 109: Candidates tab filter + CandidateDetail types](../tasks/milestone-13-audio-sync/task-109-candidates-filter-types.md) — 2h
5. [Task 110: AudioSyncTab scaffold + form](../tasks/milestone-13-audio-sync/task-110-audio-sync-tab-scaffold.md) — 6h
6. [Task 111: Hover-driven preview override](../tasks/milestone-13-audio-sync/task-111-hover-preview-override.md) — 3h
7. [Task 112: Wire Generate + Resync to live endpoint](../tasks/milestone-13-audio-sync/task-112-wire-live-generation.md) — 3h
8. [Task 113: ElevenLabs voice list (client-side fetch + cache)](../tasks/milestone-13-audio-sync/task-113-elevenlabs-voice-list.md) — 2h
9. [Task 114: E2E tests + mocked sync.so harness](../tasks/milestone-13-audio-sync/task-114-e2e-tests.md) — 3h

**Total**: ~30h

---

## Dependencies / Prerequisites

- `pool_segments` / `tr_candidates` foundation (shipped via `local.candidate-pool-migration.md`)
- `SYNC_API_KEY` (server env)
- `ELEVENLABS_API_KEY` (client MVP; server later with M8 Task-60)
- JobManager + `/ws/jobs` (shipped; already used by Veo/Imagen)

---

## Testing Requirements

- [ ] Unit: migration round-trip; FK enforcement on `derived_from`; helper read/write of new columns
- [ ] Unit: sync_client multipart build + polling loop (mocked HTTP)
- [ ] Unit: live-computed `from v{d}` rank is correct under insert/order-change scenarios
- [ ] Integration (mocked sync.so): full TTS lipsync generation → pool_segments + tr_candidates rows created, file on disk, WS events fire
- [ ] Integration (mocked sync.so + mocked ElevenLabs): S2S lipsync generation with the server-side S2S pre-step
- [ ] E2E: Audio Sync tab flow — form submit → grid update → hover drives preview → click selects → timeline renders lipsync

---

## Documentation Requirements

- [ ] Update `local.characters-and-lipsync.md` note pointing readers to `local.audio-sync.md` for the MVP lipsync mechanism
- [ ] Inline doc comment on `AudioSyncTab.tsx` noting the hover-override contract
- [ ] README section on `lipsync/` backend module

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| sync.so API changes between prototype (Apr 2026) and implementation | Medium | Low | Prototype is the source of truth; re-validate request shape at Task 107 start |
| sync.so native S2S not available (two-hop required for Audio mode) | Low | Medium | Design doc already specifies the fallback path |
| ElevenLabs API key management on client MVP | Medium | Medium | Mark as TEMP; server-side proxy follow-on (M8 Task-60) |
| `derived_from` FK conflicts during VCS merge | Low | Low | `pool_segments` is append-only and source candidates are never deleted — conflicts are not possible in practice |
| 20MB sync.so upload cap hits real videos | Medium | Medium | Surface clear error in the UI; document the cap; future: pre-upload to a hosted URL |
| Preview hover-override feels laggy | Low | Medium | Reuse existing LazyVideoCard scrub/preview machinery; only swap the source ref |

---

**Next Milestone**: Multi-speaker lipsync (M8 scope) — diarization + per-speaker voice mapping built on top of this milestone's variant model
**Blockers**: None
**Notes**: The `variant_kind` column is deliberately open-ended — M11's `isolate-vocals` plugin can set `variant_kind='denoise'` without further schema work, and future transforms (retime, upscale) get the same treatment.
