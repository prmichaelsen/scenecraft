# Task 72: Media Classifier + Streaming Hasher

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 4 hours
**Dependencies**: Task 70 (schema foundation)
**Status**: Not Started

---

## Objective

Ship two shared helpers that every ingest path reuses: (1) a media-kind classifier that maps a file to `'video' | 'image' | 'audio' | None`, and (2) a streaming SHA-256 hasher that can run alongside upload chunk processing (zero wall-clock overhead) or directly on a file handle.

---

## Context

- **Classifier** is used by the upload pipeline (Task 74), watchdog ingest (Task 75), and `/api/browse` response (Task 73). One canonical implementation prevents drift.
- **Streaming hasher** is the key to the "hash is free on upload" decision — during upload, each chunk feeds both the disk-write buffer and the hasher in parallel, so the hash is complete the instant the last byte lands. For watched-folder scans, the same function runs over a file handle.

---

## Steps

1. **Classifier module** in `scenecraft-engine/src/scenecraft/media.py` (new file):

   ```python
   import mimetypes
   import subprocess
   from pathlib import Path

   _NON_MEDIA_EXTS = {".txt", ".pdf", ".zip", ".md", ".py", ".json", ".yaml",
                       ".yml", ".log", ".gz", ".tar", ".html", ".css", ".js"}

   def classify_media(path: Path) -> str | None:
       """Return 'video' | 'image' | 'audio' | None for a file."""
       ext = path.suffix.lower()
       if ext in _NON_MEDIA_EXTS:
           return None
       mime, _ = mimetypes.guess_type(str(path))
       if mime:
           if mime.startswith("video/"): return "video"
           if mime.startswith("image/"): return "image"
           if mime.startswith("audio/"): return "audio"
       # Fallback: ffprobe for unknown extensions or octet-stream
       return _ffprobe_classify(path)

   def _ffprobe_classify(path: Path) -> str | None:
       try:
           result = subprocess.run(
               ["ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_streams", str(path)],
               capture_output=True, text=True, timeout=5,
           )
           data = json.loads(result.stdout or "{}")
           streams = data.get("streams", [])
           types = {s.get("codec_type") for s in streams}
           if "video" in types:
               return "video"
           if "audio" in types:
               return "audio"
       except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
           pass
       return None
   ```

2. **Streaming hasher** in `scenecraft-engine/src/scenecraft/hashing.py` (new file):

   ```python
   import hashlib
   from pathlib import Path
   from typing import Iterable, BinaryIO

   CHUNK_SIZE = 1 << 20  # 1 MB

   def hash_stream(chunks: Iterable[bytes]) -> str:
       """SHA-256 hex of a chunk iterator. Use in upload-pipeline tees."""
       h = hashlib.sha256()
       for chunk in chunks:
           h.update(chunk)
       return h.hexdigest()

   def hash_file(path: Path) -> str:
       """SHA-256 hex of a file on disk. Use for watched-folder ingests."""
       h = hashlib.sha256()
       with path.open("rb") as f:
           for chunk in iter(lambda: f.read(CHUNK_SIZE), b""):
               h.update(chunk)
       return h.hexdigest()

   class HashingTee:
       """Context manager: accepts chunks, writes to a file AND computes SHA-256."""
       def __init__(self, dest_path: Path):
           self.dest_path = dest_path
           self._file: BinaryIO | None = None
           self._h = hashlib.sha256()

       def __enter__(self):
           self._file = self.dest_path.open("wb")
           return self

       def __exit__(self, *exc):
           if self._file:
               self._file.close()

       def write(self, chunk: bytes) -> None:
           self._file.write(chunk)
           self._h.update(chunk)

       @property
       def hexdigest(self) -> str:
           return self._h.hexdigest()
   ```

3. **Rate-limiter for ffprobe fallback** — when watched-folder initial scans hit many unknown-extension files, cap ffprobe calls. Simple semaphore or token bucket at N=10/second is enough for MVP. Implement in `media.py`:

   ```python
   from threading import Semaphore
   _FFPROBE_SEM = Semaphore(10)

   def _ffprobe_classify(path):
       with _FFPROBE_SEM:
           # ... existing body
   ```

4. **Tests** (`scenecraft-engine/tests/test_media.py`):
   - Video `.mp4` → `'video'`.
   - Image `.png` → `'image'`.
   - Audio `.wav` → `'audio'`.
   - Unknown ext with video ffprobe streams → `'video'` (requires a real small test asset — reuse one from existing test fixtures if present).
   - Known non-media ext (`.txt`) → `None` (skipped before ffprobe).
   - ffprobe failure → `None`, no crash.

5. **Tests** (`scenecraft-engine/tests/test_hashing.py`):
   - `hash_file` on a known-bytes fixture returns expected hex.
   - `hash_stream` on the same chunks returns same hex.
   - `HashingTee` writes bytes to disk AND `hexdigest` matches direct `hash_file` on the resulting file.
   - Tee handles multi-chunk writes correctly.

---

## Verification

- [ ] `media.classify_media` exists and returns `'video' | 'image' | 'audio' | None`.
- [ ] Fast path (extension match) doesn't spawn ffprobe.
- [ ] Non-media extensions skipped before ffprobe.
- [ ] `hashing.hash_file` / `hash_stream` / `HashingTee` all return identical hashes for the same content.
- [ ] `HashingTee` writes to disk + hashes in a single pass.
- [ ] ffprobe concurrency capped via semaphore.
- [ ] All tests pass.

---

**Next Task**: [Task 73: /api/browse endpoint](task-73-browse-endpoint.md)
