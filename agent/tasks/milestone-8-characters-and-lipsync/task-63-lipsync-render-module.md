# Task 63: Lipsync Render Module (WhisperX + S2S + Sync.so)

**Objective**: Backend module that performs end-to-end lip-sync on a selected transition video: diarize → per-segment S2S → stitch → Sync.so → save
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 10
**Status**: Not Started

---

## Context

The core backend work. Given a transition with a selected Veo video and a confirmed speaker→character mapping, produces a lip-synced MP4 with consistent character voices. Preserves ambient audio between diarized speech segments. Saves the output under `assets/lipsync_outputs/{tr_id}/{lipsync_id}.mp4` and records a `transition_lipsyncs` row.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — Lip-Sync Flow section

## Steps

1. Create `src/scenecraft/render/lipsync.py` with two public functions:

   **`diarize_transition(project_dir, tr_id) -> dict`**
   - Extracts audio from the transition's selected Veo clip (`ffmpeg -vn -ar 16000 -ac 1` → WAV)
   - Calls WhisperX via Replicate (`victor-upmeet/whisperx` model) — submit, poll, download response
   - Returns `{segments: [{speaker, start, end, text}], speakers: [...], proposed_map: {speaker_id: char_id}}`
   - Proposed map heuristic: first-encountered speaker → first-named character in action text, in order
   - Short-circuit optimization: if `len(resolve_characters(action)) == 1`, skip WhisperX entirely, return a single-segment response covering `[0, duration]` owned by that character

   **`lipsync_transition(project_dir, tr_id, speaker_map, segments, on_status=None) -> str`**
   - For each segment: slice audio with ffmpeg, run ElevenLabs S2S with `voice_id = chars[speaker_map[seg.speaker]].voice_id`, save MP3
   - Stitch: build a single WAV matching the source duration; at each segment's `[start, end]`, overlay the S2S MP3; in gaps, keep original audio
   - Compute `source_video_hash` = SHA-256 of the selected video file
   - Generate `lipsync_id = lipsync_{hex8}` and `output_filename = f"{lipsync_id}.mp4"`
   - Call Sync.so `/v2/generate` with video + stitched audio (multipart direct upload)
   - Poll job until `COMPLETED`; download output to `assets/lipsync_outputs/{tr_id}/{lipsync_id}.mp4`
   - Insert `transition_lipsyncs` row via `create_transition_lipsync`
   - Return path to the saved file

2. ElevenLabs S2S helper (`elevenlabs_s2s(audio_path, voice_id, output_path)`):
   - `POST https://api.elevenlabs.io/v1/speech-to-speech/{voice_id}?output_format=mp3_44100_128`
   - multipart: `model_id=eleven_multilingual_sts_v2`, `audio=@file`, `voice_settings={"stability":0.5,"similarity_boost":0.75}`
   - Streams to output path; raises on non-200

3. Sync.so helper (`sync_so_lipsync(video_path, audio_path, output_path, on_status)`):
   - Direct multipart upload per Sync.so docs: `model=lipsync-2`, `video=@...`, `audio=@...`, `options={"sync_mode":"cut_off"}`
   - Poll `GET /v2/generate/{id}` every 5s until status is `COMPLETED` / `FAILED` / `REJECTED`
   - On completion, download `outputUrl` to local path
   - 10-minute timeout

4. Segment stitching (`stitch_segments`):
   - Use `ffmpeg` filter_complex with `[0:a]atrim=start=...:end=...[segN]` for each S2S segment
   - `[orig_audio]atrim=start=X:end=Y[gapN]` for each non-speech gap
   - `concat` them in timeline order into a single audio stream
   - Apply 20ms crossfade at segment boundaries (`acrossfade=d=0.02`)
   - Output as WAV for sync.so compatibility

5. Unit + integration tests:
   - Mocked WhisperX response → verify segment parsing
   - Single-speaker optimization path skips WhisperX
   - Real end-to-end test guarded by env flag `SCENECRAFT_LIPSYNC_LIVE_TEST=1` to avoid API costs in CI

## Verification

- [ ] `diarize_transition` returns segments + proposed_map for a 2-speaker test clip
- [ ] `lipsync_transition` produces valid MP4 at `assets/lipsync_outputs/{tr_id}/{lipsync_id}.mp4`
- [ ] Output audio preserves ambient in non-speech gaps
- [ ] Boundary crossfade prevents audible pops between segments
- [ ] Single-character action skips WhisperX (verified via mock)
- [ ] `transition_lipsyncs` row created with correct `source_video_hash` and `speaker_map`
- [ ] Tests pass

---

**Dependencies**: Task 58 (lipsyncs schema), Task 62 (action-text resolver for single-character optimization)
