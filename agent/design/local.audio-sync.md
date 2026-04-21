# Audio Sync — Lipsync via Candidate Variants

**Concept**: sync.so + ElevenLabs lipsync attached to transitions as variant candidates via a parent link on `pool_segments`
**Created**: 2026-04-21
**Status**: Design Specification

---

## Overview

The **Audio Sync** tab on `TransitionPanel` produces lipsync variants of transition candidates. A user picks a source candidate (v1, v2, v3…), an ElevenLabs voice, and **either a written script (text-to-speech) or a source audio clip (speech-to-speech)**; sync.so renders a new video with the subject's mouth matching the synthesized speech. The output is another candidate — same `pool_segments` row, same `tr_candidates` junction — distinguished by a parent link (`derived_from`) back to the source candidate and a `variant_kind='lipsync'` tag.

The **Candidates tab** filters to `variant_kind IS NULL` — lipsync variants live exclusively in the Audio Sync tab so the raw-take view stays clean.

This design narrows the lipsync mechanism from `local.characters-and-lipsync.md` (which defines the broader character-entity + multi-speaker S2S pipeline). The character model and multi-speaker work from that doc remain valid — this one specifies the concrete data shape and UX for attaching a single lipsync variant to a single source candidate.

---

## Problem Statement

Two independent problems:

**1. The M8 lipsync pipeline is overbuilt for the single-speaker case.** It specifies WhisperX diarization → per-segment ElevenLabs Speech-to-Speech → concatenation → sync.so. For single-speaker dialogue, sync.so's API natively accepts an ElevenLabs provider block and calls ElevenLabs internally in one round trip. A working prototype at `scenecraft-engine/scripts/sync_lipsync_test.py` proved this end-to-end on 2026-04-19.

**2. There is no defined shape for how lipsyncs attach to candidates.** Candidates today are siblings under a transition; lipsyncs are semantically *derived from* a specific candidate, and a single source may have several lipsyncs (different scripts, voices, takes). A clean data model must preserve the parent-child relationship without duplicating the candidate mechanism or introducing a second selection axis.

---

## Solution

### Data model

Extend `pool_segments` with two nullable columns:

- `derived_from TEXT REFERENCES pool_segments(id)` — the source candidate this variant was produced from
- `variant_kind TEXT` — `'lipsync'` for MVP, open-ended for future transforms

Lipsyncs are ordinary `pool_segments` rows with a `tr_candidates` junction row on the same transition. They appear in the Audio Sync tab grid. Selection still mutates `transitions.selected[slot] = pool_segment_id` — whichever pool_segment is selected (raw or variant) is what the timeline renders. No new selection axis.

### UX

New **Audio Sync** tab on `TransitionPanel`, layout mirrors the Candidates tab:

- **Inline generate form at top**: source candidate picker, audio-mode toggle (**Script → TTS** / **Audio → S2S**), ElevenLabs voice, a script textarea **or** an audio input (depending on mode), options
- **Grid below** — each lipsync-take card shows:
  - Lipsynced video thumbnail
  - `from v{d}` chip — rank of the source candidate within the transition, live-computed from `added_at ASC`
  - Actions: **Resync** (one-click identical re-run), **Bench**, overflow menu
- **Hover drives the render preview**:
  - Hover the `from v{d}` chip → raw source candidate plays
  - Hover the card body → lipsynced output plays
  - Release → preview snaps back to the playhead frame
- **Click** → standard select (sets `transitions.selected[slot]`). New takes **do not** auto-select.

### Backend flow

1. `POST /api/projects/:name/transitions/:tr_id/lipsync` with body shape depending on mode:
   - **TTS**: `{ source_pool_segment_id, voice_id, script, mode: 'tts', options }`
   - **S2S**: `{ source_pool_segment_id, voice_id, source_audio_ref, mode: 's2s', options }` — `source_audio_ref` is either a multipart upload or a pool_segment_id of a pre-existing audio asset
2. Read source video from `pool/segments/cand_<source>.mp4`
3. Assemble the sync.so request based on mode:
   - **TTS**: multipart `POST https://api.sync.so/v2/generate` with `model=lipsync-2`, video file, `input=[{"type":"text","provider":{"name":"elevenlabs","voiceId":..., "script":...}}]`, `options={"sync_mode":"cut_off"}`
   - **S2S**: server runs ElevenLabs Speech-to-Speech on the source audio with the target `voice_id`, then POSTs to sync.so with `input=[{"type":"audio","url":<s2s_output_url>}]` (or inline audio upload). If/when sync.so's ElevenLabs provider supports native S2S via an audio field, this collapses to a single multipart request — worth checking at implementation time.
4. Poll `/v2/generate/{job_id}` every 5s via the existing job manager (WS progress events streamed on `/ws/jobs`); on `COMPLETED`, download `outputUrl`
5. Write to `pool/segments/cand_<new_uuid>.mp4`
6. Insert `pool_segments` row with `kind='generated'`, `variant_kind='lipsync'`, `derived_from=<source>`, `generation_params={ provider:'sync.so', model:'lipsync-2', mode, voiceId, script? | sourceAudioRef? }`
7. Insert `tr_candidates` row on the same transition/slot with `source='generated'`
8. Broadcast `job_completed` WS event → frontend invalidates the transitions query → new card appears in the grid

### Alternatives considered

- **Option A — flat (lipsync is just another candidate, no parent link).** Rejected: loses the source-variant relationship visually and in data. Re-rolling raws would leave lipsyncs orphaned with no hint.
- **Option B — separate `lipsyncs` table + `active_variant_id` on `tr_candidates`.** Rejected: diverges from the candidate pattern, doubles selection state (candidate + variant-of-candidate), cascades into timeline/render/VCS. Too much surface for a single feature.
- **Option C (chosen) — parent link on `pool_segments`.** Two nullable columns, one new endpoint, one selection model, extensible to future per-candidate transforms via additional `variant_kind` values.

---

## Implementation

### Schema migration

```sql
ALTER TABLE pool_segments ADD COLUMN derived_from TEXT REFERENCES pool_segments(id);
ALTER TABLE pool_segments ADD COLUMN variant_kind TEXT;
CREATE INDEX idx_pool_segments_derived_from
  ON pool_segments(derived_from)
  WHERE derived_from IS NOT NULL;
```

### API contract

```
POST /api/projects/:name/transitions/:tr_id/lipsync
  body (TTS mode):
    {
      source_pool_segment_id: string
      mode: 'tts'
      voice_id: string
      script: string
      options?: { sync_mode?: 'cut_off' | 'loop' | 'bounce', slot?: number }
    }
  body (S2S mode):
    {
      source_pool_segment_id: string
      mode: 's2s'
      voice_id: string
      source_audio_ref: string    // pool_segment_id OR multipart upload handle
      options?: { sync_mode?: 'cut_off' | 'loop' | 'bounce', slot?: number }
    }
  returns: { jobId: string }

WS /ws/jobs:
  job_progress:  { jobId, phase: 'uploading'|'s2s'|'processing'|'downloading', pct: number }
  job_completed: { jobId, result: { transitionId, poolSegmentId, derivedFrom, slot } }

GET /api/projects/:name/transitions/:tr_id
  response.candidateDetails[].derivedFrom: string | null
  response.candidateDetails[].variantKind: string | null
```

### Frontend changes

- `CandidateDetail` gains `derivedFrom: string | null` and `variantKind: string | null`
- **Candidates tab filters to `variantKind == null`** — raw takes only; variants are scoped to the Audio Sync tab
- New `AudioSyncTab.tsx` — inline form + grid, reuses `LazyVideoCard` with added `derivedFromLabel` prop and `onChipHover` / `onCardHover` handlers that push a `previewSourceOverride` ref. Form has a mode toggle (Script/Audio) that swaps the script textarea for an audio input (file picker / pool-audio picker)
- `TransitionPanel.tsx` gets a new tab slot between `candidates` and `browse`: `details · candidates · audio-sync · browse · bench`
- Render preview panel reads `previewSourceOverride` when set and falls back to the playhead source otherwise; hover handlers push/pop the override

### ElevenLabs voice list

MVP fetches `GET https://api.elevenlabs.io/v1/voices` client-side using a key from project settings; results cached in memory for the session. A server-side proxy with persistent caching is the path forward and aligns with M8 Task-60.

---

## Benefits

- **Honors the candidate pattern**: the lipsync operation outputs a candidate on the existing transition, not a sibling track — consistent with the project-wide convention.
- **Minimal schema surface**: two nullable columns, no new tables, no new selection state.
- **Extensible**: the same mechanism serves future per-candidate transforms (M11 audio isolation `variant_kind='denoise'`, future time-remap, upscale, etc.).
- **Proven integration**: sync.so + ElevenLabs native flow works end-to-end (`scripts/sync_lipsync_test.py`).
- **Simpler than the M8 pipeline**: no WhisperX, no per-segment S2S stitching. Single round trip, single output.

---

## Trade-offs

- **Single-speaker only (MVP)**: One voice applies to the whole video. Multi-speaker scenes still need the M8 diarization + per-segment S2S approach — a follow-on, not in scope here.
- **Filtered Candidates tab**: the Candidates tab filter (`variant_kind IS NULL`) means any future tool that wants a cross-variant view of candidates must query `pool_segments` directly or opt out of the filter.
- **VCS implications**: the `pool_segments` row-level diff path sees two new columns. Backfill fills them with `NULL`. Because `pool_segments` is append-only and source candidates are never deleted, `derived_from` conflicts are not possible in practice.

---

## Dependencies

- `pool_segments` / `tr_candidates` foundation (from `local.candidate-pool-migration.md`) — already shipped
- `SYNC_API_KEY` server env
- `ELEVENLABS_API_KEY` server env (MVP uses it client-side too; move server-side with Task-60)
- Existing job manager + `/ws/jobs` channel (already used by Veo/Imagen)

---

## Testing Strategy

- **Unit**: migration round-trip; `pool_segments` insert with `derived_from`; FK enforcement; live rank computation for `from v{d}`
- **Integration** (mocked sync.so): full lipsync generation from a fixture candidate → pool_segments + tr_candidates row created, file on disk, WS events fire
- **E2E** (mocked sync.so): Audio Sync tab form submission → grid updates → hover drives preview → click selects → timeline renders lipsync
- **Real-API smoke**: `scripts/sync_lipsync_test.py` (already passing on 2026-04-19)

---

## Migration Path

No data migration — `derived_from` and `variant_kind` default to `NULL` for all existing candidates. Feature is additive.

1. Ship schema migration
2. Ship backend `/lipsync` endpoint (behind `SYNC_API_KEY` env check)
3. Ship Audio Sync tab — initially read-only against stubbed endpoint
4. Wire live generation
5. Wire ElevenLabs voice list (direct fetch → server proxy later)

---

## Key Design Decisions

### Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Lipsync data shape | Candidate variant via `pool_segments.derived_from` + `variant_kind` | Honors the candidate pattern; minimal schema delta; extensible to other transforms |
| Selection model | Unchanged — `transitions.selected[slot] = pool_segment_id` | Raw and variants share one selection mechanism |
| TTS + lipsync integration | sync.so native ElevenLabs provider (single round trip) | Prototype proved end-to-end; avoids WhisperX/segment-stitching pipeline for single-speaker MVP |
| S2S support | Backend runs ElevenLabs S2S, passes resulting audio to sync.so (one extra hop) | Users may want to drive lipsync from existing audio (takes, references) rather than a typed script |
| Stale-lipsync handling | Not needed | pool_segments are append-only; source candidates are never deleted — the concern doesn't arise |

### UX

| Decision | Choice | Rationale |
|---|---|---|
| Tab name | "Audio Sync" (not "Lip-Sync") | Leaves room for future audio-driven ops without a rename |
| Candidates tab filter | `variant_kind IS NULL` — raws only | Variants have their own tab; keeps the raw-take view uncluttered |
| Input modes | Script (TTS) and Audio (S2S), toggle in the form | sync.so supports both; users want the choice |
| Generate entry point | Inside the Audio Sync tab (inline form) | Scopes the workflow; consistent with Candidates tab rhythm |
| Layout | Inline form at top + grid below (mirrors Candidates tab) | Makes Resync-with-edits a natural flow |
| Resync button | One-click identical re-run (same source/voice + same script-or-audio → new take) | sync.so isn't deterministic; Generate form already covers edit-and-rerun |
| Auto-select on completion | No — new take appears in grid, user must click to promote | Don't silently mutate what plays in the timeline |
| Hover behavior | Chip → raw plays; card → synced plays; release → playhead frame | Preview has one default (playhead); hover is transient override |
| `from v{d}` label | Live-computed from `added_at ASC` rank of source | Candidates never deleted, so rank is stable — but compute live, don't store |

---

## Future Considerations

- **Multi-speaker** (M8 scope): diarize + per-speaker voice mapping in front of the sync.so call; stays compatible with this design (each speaker's track becomes a variant, or stitched client-side)
- **Voice management**: Task-60's ElevenLabs voice proxy with caching replaces the direct client fetch
- **Other variant kinds**: `'denoise'` (M11 audio isolation), `'retime'` (future time remap), `'upscale'` — reuse the `variant_kind` column
- **Polymorphic Audio Sync tab**: future ops ("music-reactive cut", "beat quantize") could live in the same tab with their own form sections

---

**Status**: Design Specification
**Recommendation**: Proceed to implementation. Retarget M8 Tasks 60, 63, 64, 65, 66, 68 to this mechanism (Task-63's WhisperX/S2S work becomes multi-speaker follow-on; remaining tasks stay as-is).
**Related Documents**: [`local.characters-and-lipsync.md`](local.characters-and-lipsync.md) (character entity + multi-speaker pipeline remain valid; lipsync mechanism superseded by this doc), [`local.candidate-pool-migration.md`](local.candidate-pool-migration.md) (foundation for `pool_segments` + `tr_candidates`)
