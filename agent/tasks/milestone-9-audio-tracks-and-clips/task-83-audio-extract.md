# Task 83: Audio-Stream Extract via ffmpeg

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 3-4 hours  
**Dependencies**: Task 82 (schema)  
**Status**: Not Started  

---

## Objective

Create `src/scenecraft/audio/extract.py` — a small module that probes a video file for an audio stream and, when present, extracts it to a standalone file in the project's audio staging directory. Used by the insert-with-linked-audio flow (Task 84) and the Veo auto-link (Task 92).

---

## Context

Videos produced by Veo always contain an audio stream; user-dropped `.mp4`/`.mov` files may or may not. Extraction needs to be fast (stream-copy when possible), idempotent (hash-based filename so re-extraction is a no-op), and failure-tolerant (missing audio is not an error).

---

## Steps

### 1. `src/scenecraft/audio/extract.py`

```python
def probe_audio_stream(video_path: Path) -> dict | None:
    """Return stream info via ffprobe, or None if no audio stream."""

def extract_audio(video_path: Path, project_dir: Path) -> Path | None:
    """Extract audio from video to project_dir/audio_staging/<hash>.<ext>.
    Returns path or None if no audio stream. Stream-copy preferred; re-encode
    if container can't stream-copy (rare)."""
```

Staging dir: `project_dir / "audio_staging"`, created lazily.

Filename: `<sha1(video_path + mtime)[:12]>.<audio_ext>` — idempotent across re-runs.

### 2. Container/codec fallback

Audio stream container detection:
- `aac` → `.m4a` with stream-copy
- `mp3` → `.mp3` with stream-copy
- anything else or failure → re-encode to `.wav` with `ffmpeg -vn -acodec pcm_s16le -ar 48000`

### 3. Tests

- Video with AAC audio → stream-copied to `.m4a`, returns path
- Video without audio → returns None
- Corrupt video → raises appropriate error (caller handles)
- Idempotent re-run → same filename, no re-extraction

---

## Verification

- [ ] Module imports cleanly; no circular deps
- [ ] `probe_audio_stream` returns None cleanly when no audio
- [ ] `extract_audio` is idempotent
- [ ] Stream-copy used for AAC/MP3 sources
- [ ] Tests pass with fixtures (test Veo mp4 + silent mp4)

---

**Next Task**: [Task 84: Slot routing + insert endpoint](task-84-insert-routing.md)
