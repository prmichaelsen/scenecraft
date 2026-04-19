# Characters and Lip-Sync

**Concept**: Characters as first-class entities owning ref images + voice; lip-sync via ElevenLabs S2S + Sync.so
**Created**: 2026-04-19
**Status**: Proposal

---

## Overview

Introduces `Character` as a first-class entity with a name, reference images, and an ElevenLabs `voice_id`. Transitions reference characters by name in their action prompt, which drives both (a) which reference images Veo receives as ingredients and (b) which voice is used for lip-sync. Lip-sync happens as a separate post-processing step using Sync.so and ElevenLabs speech-to-speech to enforce a consistent voice across clips.

---

## Problem Statement

Today, transitions have a flat `ingredients` field (list of reference image paths) with no semantic grouping. There is no concept of "who is in this scene." Voice generation via ElevenLabs dubbing cannot guarantee a consistent voice across clips because its auto-clone behavior picks up whatever speech it detects and the voice_id override has a known bug.

As a result:
- Each clip's voice drifts — even for the same character
- Users manually manage ingredient paths per transition with no reuse
- No way to say "Jane is in this scene" and have the right visual + vocal identity applied

---

## Solution

**Characters** become the unit of identity. A character owns:
- A display name (e.g. "Jane", "Narrator")
- A list of reference images (migrated from `transitions.ingredients`)
- An ElevenLabs `voice_id`

Transitions no longer store ingredient paths directly. Instead, the transition's `action` prompt names characters ("Jane opens the door and says hello to Marcus"). At generation time the backend scans the action for character names, resolves to the matching `Character` rows, and passes their reference images to Veo as ingredients.

**Lip-sync** is a separate per-transition operation. Supports multi-speaker scenes from day one via speaker diarization. Given the selected Veo clip (which already contains speech audio — `generate_audio=True` is on by default) and the transition's named characters, the backend:

1. Extracts original audio from the Veo MP4
2. **Diarizes** the audio — identifies speaker turns as timestamped segments (`{speaker_id, start, end}` tuples)
3. **Maps speakers → characters** (user-confirmed via UI; system proposes a default mapping based on action-text order)
4. **Per-segment S2S**: for each diarized segment, runs ElevenLabs Speech-to-Speech using the mapped character's `voice_id`, producing audio segments with consistent character voices
5. Concatenates the S2S segments back into a single audio track, preserving the original timing
6. Pipes the combined audio + original video into Sync.so `/v2/generate`
7. Saves the lip-synced output as a new file, preserving the original

Because the combined audio matches the original speech timing exactly, Sync.so's per-face lip-sync still works correctly — each character's mouth movements align with their own voice.

Single-speaker scenes are a degenerate case of the above: diarization returns one speaker, user maps it to one character, no segment stitching needed.

Outputs are stored as candidates — the user can toggle between the raw Veo clip and any of the lip-sync variants.

### Alternatives Considered
- **ElevenLabs Dubbing API**: Rejected — no working `voice_id` override, voices drift per clip
- **TTS + Sync**: Rejected for now — requires users to write scripts; Veo already generates speech we can convert
- **Per-transition voice_id**: Rejected — duplicates data, loses the grouping benefit
- **Single-speaker v1 only**: Rejected — diarization cost is minimal, and retrofitting multi-speaker later would require reworking the data model and UI

---

## Implementation

### Data Model

**New `characters` table** (scenecraft-engine SQLite, per-session working copy):
```sql
CREATE TABLE characters (
  id TEXT PRIMARY KEY,              -- char_{hex8} — server-generated
  name TEXT NOT NULL,               -- case-insensitive unique within project
  voice_id TEXT NOT NULL,           -- ElevenLabs voice_id
  ref_image_hashes TEXT NOT NULL DEFAULT '[]',  -- JSON array of SHA-256 hashes pointing to assets/character_ref_images/{hash}.png
  created_at TEXT NOT NULL,
  last_modified_by TEXT,            -- username (per VCS attribution)
  deleted_at TEXT                   -- soft-delete
);
CREATE UNIQUE INDEX idx_characters_name ON characters(LOWER(name)) WHERE deleted_at IS NULL;
```

**VCS integration**: Added to `DIFFABLE_TABLES` set. Row-level diff handles add/modify/delete during branch/merge. Case-insensitive unique constraint surfaces as a conflict when two branches create characters with the same name under different IDs.

**New `transition_lipsyncs` table**:
```sql
CREATE TABLE transition_lipsyncs (
  id TEXT PRIMARY KEY,              -- lipsync_{hex8} — server-generated
  transition_id TEXT NOT NULL,
  source_video_hash TEXT NOT NULL,  -- sha256 of source video — used to detect stale lipsyncs
  output_filename TEXT NOT NULL,    -- filename under assets/lipsync_outputs/{transition_id}/, named {id}.mp4
  speaker_map TEXT NOT NULL,        -- JSON: {"speaker_0": "char_id_jane", "speaker_1": "char_id_marcus"}
  segments TEXT NOT NULL,           -- JSON array of {speaker, start, end, text} from WhisperX
  created_at TEXT NOT NULL,
  last_modified_by TEXT,            -- username (per VCS attribution)
  deleted_at TEXT,
  FOREIGN KEY (transition_id) REFERENCES transitions(id)
);
CREATE INDEX idx_lipsyncs_tr ON transition_lipsyncs(transition_id) WHERE deleted_at IS NULL;
```

**Extend `transitions` table**: add column `active_lipsync_id TEXT` — nullable pointer to a `transition_lipsyncs.id`. Null means "use the raw Veo clip, no lipsync applied." Participates in the existing transitions row-level diff.

**VCS integration**: `transition_lipsyncs` added to `DIFFABLE_TABLES`. Each lipsync row is append-only (never modified once created); deletion is soft via `deleted_at`. Merge behavior:
- Two branches generating different lipsyncs for the same transition → both rows survive the merge (different IDs)
- `active_lipsync_id` differs on both sides → standard row conflict on the transition, user picks which variant is active

**Staleness detection**: When listing lipsyncs, compute the current source video's hash. If `source_video_hash != current_hash`, the lipsync is marked stale in the API response (`isStale: true`). Stale lipsyncs are still kept on disk and in DB — UI shows a warning badge — but they're not the default "active" pick. User can regenerate or keep using the stale variant if it still looks fine.

**Migration: transitions.ingredients → characters.ref_images**:
- Schema migration detects existing `ingredients` with paths
- Groups paths by filename heuristics (or prompts user to cluster)
- Creates characters with generated names (or leaves as ungrouped "legacy" characters)
- Clears `transitions.ingredients` after migration
- Adds `transitions.active_lipsync_id TEXT` — nullable pointer to chosen lipsync variant (null = use raw Veo clip)

### Character Name Uniqueness

Names are case-insensitive unique within a project. Duplicate creation returns `409 Conflict` (`CHARACTER_NAME_EXISTS`). Enforced by a partial unique index on `LOWER(name) WHERE deleted_at IS NULL`.

### Character Name Resolution

At Veo generation time, `_handle_generate_transition_candidates` parses `tr.action` for character names:
```python
def resolve_characters(project_dir: Path, action: str) -> list[Character]:
    all_chars = list_characters(project_dir)  # non-deleted
    # Case-insensitive whole-word match on character names
    # Longer names take precedence (avoids "Jan" matching before "Janet")
    matched = []
    for ch in sorted(all_chars, key=lambda c: -len(c.name)):
        if re.search(rf"\b{re.escape(ch.name)}\b", action, re.IGNORECASE):
            matched.append(ch)
    return matched
```

Their `ref_images` are merged (deduped by path) and passed as `ingredients` to `generate_video_from_image` / `generate_video_transition`.

### Lip-Sync Flow

Split into two stages so the user can review/correct the speaker mapping before paying for S2S + Sync.so.

**Stage 1: Diarize** (cheap, fast — runs automatically when user opens Lip-Sync tab)

```python
def diarize_transition(project_dir: Path, tr_id: str) -> dict:
    """Extract audio and detect speaker turns. Returns:
    {
      "segments": [{"speaker": "speaker_0", "start": 0.0, "end": 2.3}, ...],
      "speakers": ["speaker_0", "speaker_1"],
      "proposed_map": {"speaker_0": "char_jane_id", "speaker_1": "char_marcus_id"}
    }
    """
    src_video = project_dir / "selected_transitions" / f"{tr_id}_slot_0.mp4"
    # Extract audio as wav for diarization
    audio_wav = work_tmp / f"{tr_id}_audio.wav"
    subprocess.run(["ffmpeg", "-y", "-i", str(src_video), "-vn", "-ar", "16000", "-ac", "1", str(audio_wav)], check=True)

    # Diarize — pyannote.audio local, or Replicate hosted (pyannote/speaker-diarization-3.1)
    segments = run_diarization(audio_wav)  # [{speaker, start, end}, ...]
    speakers = sorted({s["speaker"] for s in segments})

    # Propose mapping: first-encountered speaker → first-named character in action
    tr = get_transition(project_dir, tr_id)
    named_chars = resolve_characters(project_dir, tr["action"])
    speaker_order = []  # speaker_ids in order of first appearance
    for s in segments:
        if s["speaker"] not in speaker_order:
            speaker_order.append(s["speaker"])
    proposed_map = {}
    for i, sp in enumerate(speaker_order):
        if i < len(named_chars):
            proposed_map[sp] = named_chars[i].id
    return {"segments": segments, "speakers": speakers, "proposed_map": proposed_map}
```

**Stage 2: Generate** (expensive — explicit user action, takes speaker_map input)

```python
def lipsync_transition(project_dir: Path, tr_id: str, speaker_map: dict, segments: list, on_status=None) -> str:
    """Run lipsync given a confirmed speaker→character map and diarization segments.

    speaker_map: {"speaker_0": "char_jane_id", "speaker_1": "char_marcus_id"}
    segments: [{"speaker": "speaker_0", "start": 0.0, "end": 2.3}, ...]
    """
    src_video = project_dir / "selected_transitions" / f"{tr_id}_slot_0.mp4"
    audio_m4a = work_tmp / f"{tr_id}_audio.m4a"
    subprocess.run(["ffmpeg", "-y", "-i", str(src_video), "-vn", "-acodec", "copy", str(audio_m4a)], check=True)

    # Per-segment S2S
    chars = {c.id: c for c in list_characters(project_dir)}
    segment_mp3s = []
    for i, seg in enumerate(segments):
        char_id = speaker_map.get(seg["speaker"])
        if not char_id:
            raise RuntimeError(f"Speaker {seg['speaker']} not mapped to a character")
        voice_id = chars[char_id].voice_id

        # Slice the original audio for this segment
        seg_wav = work_tmp / f"{tr_id}_seg{i}.wav"
        subprocess.run(["ffmpeg", "-y", "-i", str(audio_m4a), "-ss", str(seg["start"]),
                        "-to", str(seg["end"]), "-ac", "1", str(seg_wav)], check=True)

        # S2S with this character's voice
        seg_mp3 = work_tmp / f"{tr_id}_seg{i}_s2s.mp3"
        elevenlabs_s2s(seg_wav, voice_id, seg_mp3)
        segment_mp3s.append((seg["start"], seg["end"], seg_mp3))
        on_status(f"S2S segment {i+1}/{len(segments)}")

    # Stitch: reassemble with correct timing, pad gaps with silence
    combined_audio = work_tmp / f"{tr_id}_combined.wav"
    stitch_segments(segment_mp3s, total_duration=get_duration(audio_m4a), output=combined_audio)

    # Sync.so lipsync
    lipsync_dir = project_dir / "lipsync_candidates" / tr_id
    lipsync_dir.mkdir(parents=True, exist_ok=True)
    out_filename = f"{datetime.utcnow().strftime('%Y%m%dT%H%M%S')}.mp4"
    out_path = lipsync_dir / out_filename
    sync_so_generate(src_video, combined_audio, out_path, on_status=on_status)

    # Record in DB
    lipsync_id = str(uuid.uuid4())
    add_transition_lipsync(
        project_dir, lipsync_id, tr_id,
        source_video_path=f"selected_transitions/{tr_id}_slot_0.mp4",
        output_path=f"lipsync_candidates/{tr_id}/{out_filename}",
        speaker_map=speaker_map,
        segments=segments,
    )
    return out_path
```

**Diarization implementation**: WhisperX via Replicate (`victor-upmeet/whisperx`, ~$0.02/min). Returns speaker-labeled segments **plus a word-level transcript** — the transcript is surfaced in the UI so users can read what each speaker says.

**Skip diarization for single-speaker transitions**: If the action text names exactly one character, skip the diarization call and treat the entire audio as one segment owned by that character. Saves latency + cost on the common case.

**Segment stitching**: Align each S2S'd segment to its original start time (pad leading with silence to hit `seg.start`). Between diarized segments (non-speech gaps), **preserve the original ambient/music audio** — mix it at full volume into the combined track. Result: speech replaced with consistent voices, everything else untouched.

### API Endpoints

**Characters** (new routes in `api_server.py`, all session-scoped per VCS):
- `GET /api/projects/:name/characters` → list
- `POST /api/projects/:name/characters` → create `{name, voiceId}` — server generates `char_{hex8}` ID
- `PATCH /api/projects/:name/characters/:id` → update fields (name, voiceId, ref_image_hashes)
- `POST /api/projects/:name/characters/:id/ref-images` → add ref image (multipart upload); server hashes the content, stores at `assets/character_ref_images/{sha256}.png`, appends hash to `ref_image_hashes`
- `DELETE /api/projects/:name/characters/:id/ref-images` → body `{hash}` — removes from `ref_image_hashes`. Asset file is NOT deleted (shared, manual GC per VCS).
- `DELETE /api/projects/:name/characters/:id` → soft-delete

**ElevenLabs voice list** (pass-through for voice picker UI):
- `GET /api/projects/:name/elevenlabs/voices` → proxies to ElevenLabs `/v1/voices` using server's `ELEVENLABS_API_KEY` env var. Response cached server-side for 5 minutes.
- `GET /api/projects/:name/elevenlabs/voices/:voiceId/preview` → returns cached MP3 sample of the voice saying a fixed phrase. Samples cached to disk (LRU, 100 voices) so the picker UI doesn't re-hit ElevenLabs every time.

**Lip-Sync**:
- `POST /api/projects/:name/lipsync/diarize` body `{transitionId}` → runs diarization, returns `{segments, speakers, proposedMap}` (cheap + fast — no DB write)
- `POST /api/projects/:name/lipsync/generate` body `{transitionId, speakerMap, segments}` → returns `{jobId}`, async S2S + Sync.so generation
- `GET /api/projects/:name/transitions/:id/lipsyncs` → list all lipsync variants for a transition
- `POST /api/projects/:name/transitions/:id/active-lipsync` body `{lipsyncId}` or `{lipsyncId: null}` → set which variant is active

### Frontend

**Characters panel** (new dockview panel, `src/components/editor/CharactersPanel.tsx`):
- List view: one row per character with name, voice preview button, ref image count, "used in N transitions" link
- Add character button → modal with name input + voice dropdown (populated from ElevenLabs voices endpoint) + drag-drop zone for ref images
- Click row → detail pane with editable name, voice picker, ref image grid (add/remove)
- Voice preview: fetches sample from ElevenLabs voice library or plays cached sample

**Lip-Sync tab** (new tab in `TransitionPanel.tsx`, added to existing `details | candidates | browse | bench`):

*Header section*:
- Shows detected characters based on the transition's action text (live parsed)
- Warning banner if no characters found in action
- "Analyze Audio" button → calls `/lipsync/diarize`, auto-runs when tab is opened if not already done

*Speaker mapping section* (shown after diarization completes):
- For each detected speaker (e.g. "speaker_0", "speaker_1"):
  - Waveform snippet showing their segments on a mini timeline
  - Play button to preview their original voice from the Veo audio
  - Character dropdown (populated from named characters in action, with all characters as fallback)
- Default mapping prefilled based on speech order × action-text order
- "Generate Lip-Sync" button — disabled until all speakers are mapped

*Candidates section*:
- "Original (no lip-sync)" entry always at top
- Each saved lipsync variant as a row: timestamp, speaker map summary ("Jane, Marcus"), "make active" / "delete" buttons
- Stale variants (source Veo clip changed since generation) show a warning badge + "regenerate" action
- Active variant highlighted
- Preview in the main preview panel plays the currently active variant

**Config**:
- `.env`: `SYNC_API_KEY`, `ELEVENLABS_API_KEY` added to server env
- Frontend doesn't see either — all calls proxied through backend

### Job Progress

Reuse existing `job_manager` pattern from `_handle_generate_transition_candidates`:
- `job_manager.create_job("lipsync", total=N+2, ...)` — N S2S segments + stitch + sync.so upload
- `update_progress(job_id, i, f"S2S segment {i}/{N}...")` per segment
- WebSocket broadcasts progress to the frontend

### File Layout

Aligned with the Git-style VCS design (`local.git-version-control.md`) — assets are shared across branches, immutable once generated.

```
.scenecraft/orgs/{org}/projects/{project}/
├── objects/                                    # content-addressed DB snapshots (VCS)
├── refs/                                       # branch pointers (VCS)
├── commits/                                    # commit metadata (VCS)
└── assets/                                     # shared, immutable binaries
    ├── selected_keyframes/                     # (existing)
    ├── keyframe_candidates/                    # (existing)
    ├── selected_transitions/
    │   └── tr_005_slot_0.mp4                   # Original Veo clip, preserved
    ├── character_ref_images/
    │   └── {sha256}.png                        # content-addressed, auto-deduped
    └── lipsync_outputs/
        └── tr_005/
            └── lipsync_a3f8c2e9.mp4            # UUID-named, one per lipsync row

.scenecraft/users/{user}/sessions/
└── {project}--{branch}.db                      # per-session working copy with characters, transition_lipsyncs tables
```

**Notes**:
- Ref images stored by SHA-256 hash: same image uploaded twice → one file, two DB references
- Lipsync outputs stored by `lipsync_{hex8}` UUID since each generation is unique
- All asset writes are append-only — no file ever overwrites another
- Two branches generating different lipsyncs = two different files, both kept forever (manual GC per VCS design)

---

## Benefits

- **Consistent voice across clips**: S2S + fixed `voice_id` sidesteps the ElevenLabs dubbing bug
- **Ergonomic character management**: reference images grouped semantically, reusable across transitions
- **Scene-aware ingredients**: writing "Jane opens the door" in the action automatically pulls Jane's ref images for Veo
- **Non-destructive**: originals preserved; user can A/B between raw Veo and lipsync variants, or regenerate
- **Scales to multi-character scenes**: merged ingredient sets; first-named character drives voice (future: multi-speaker support)

---

## Key Design Decisions

- **Characters own ref images, not transitions**: Greenfield — no migration needed. Characters become the unit of identity, used across many transitions.
- **Character resolution via action-text scan**: No separate "assign character" step. Users just write natural prose; backend parses. Keeps the UX fluid.
- **Multi-speaker via diarization + per-segment S2S**: Detect speaker turns in the Veo audio, map each to a character, run S2S per segment, stitch back. Sync.so then lip-syncs the combined audio. This preserves Veo's original speech timing (which already drives correct mouth movements in multi-character scenes).
- **Two-stage lip-sync flow**: Diarize first (cheap, auto-runs), then generate (expensive, explicit). Lets users review and correct speaker→character mapping before paying for S2S.
- **WhisperX for diarization**: Replicate-hosted, returns both speaker-labeled segments and a word-level transcript. Transcript is surfaced in the UI so users see what each speaker said before committing to generation.
- **Skip diarization for single-speaker transitions**: If exactly one character is named in the action, treat the whole audio as one segment — skips the WhisperX call on the common case.
- **Preserve ambient audio in non-speech gaps**: Mix original music/SFX between diarized speech segments at full volume. Result is speech swapped to consistent voices, everything else untouched.
- **Stale lipsync detection via source-video hash**: When the underlying Veo clip changes, hash mismatch marks existing lipsyncs stale in the UI. Files and DB rows are kept — user decides whether to regenerate or roll with the stale variant.
- **Case-insensitive unique character names**: Duplicate names rejected at creation within a branch. At merge time, if two branches created characters with the same name under different IDs, the unique constraint violation surfaces as a merge conflict (user picks one or renames).
- **VCS-aligned storage**: Ref images and lipsync outputs live under the shared `assets/` dir (per `local.git-version-control.md`). Ref images are content-addressed (SHA-256) for dedup; lipsync outputs use UUIDs since every generation is unique. Both are append-only.
- **Diffable tables**: `characters` and `transition_lipsyncs` are added to the VCS diff engine's `DIFFABLE_TABLES` set. Standard row-level diff handles add/modify/delete. `last_modified_by` column on both tables matches existing attribution pattern.
- **Cached voice picker + previews**: ElevenLabs `/v1/voices` list cached server-side 5min; per-voice preview MP3s cached to disk (LRU 100). Keeps the picker responsive.
- **Lip-sync outputs as candidates, not overwrites**: Preserves original Veo clip. Each generation adds a new candidate. User sets the active variant.
- **S2S over TTS**: Veo always generates audio (`generate_audio=True` default). S2S gives us lip-synced speech from actual video-timed mouth movements instead of needing the user to author every line.
- **Voice per character, not per transition or project**: Matches the mental model — a character *has* a voice.
- **Explicit character naming required (no defaults)**: Forces the user to define characters before using them. No silent fallback means no accidental wrong-voice outputs.

---

## Open Questions

_All resolved — see Key Design Decisions for final calls. Design is ready to scope into tasks._
