# Task 74: Upload Pipeline (Streaming Hash + Flat Pool + Dedup)

**Milestone**: [M9 — Explorer and Media Import](../../milestones/milestone-9-explorer-and-media-import.md)
**Design Reference**: [local.explorer-and-media-import](../../design/local.explorer-and-media-import.md)
**Estimated Time**: 7 hours
**Dependencies**: Task 70 (schema), Task 71 (ACL), Task 72 (classifier + hasher)
**Status**: Not Started

---

## Objective

Rewrite the pool upload endpoint to: (1) hash content during upload via streaming tee (zero wall-clock overhead), (2) write to a flat `pool/<uuid>.<ext>` layout, (3) dedup by `source_hash` — on match, reuse existing `pool_segments` row and add a new `source_locations` entry instead of duplicating. Accept video, image, and audio uniformly.

---

## Context

Replaces the existing upload handler in `api_server.py`. Key changes from the current implementation:
- Media kinds: all three (video/image/audio), classified by `media.classify_media`.
- Flat pool dir (no per-kind subdirs).
- Content-hash dedup with `source_locations` multi-source tracking.
- Streaming hash during upload (not a second disk pass).

---

## Steps

1. **Endpoint** in `scenecraft-engine/src/scenecraft/api_server.py`:
   ```
   POST /api/projects/:name/pool/upload
   ```
   Multipart body with one or more `file` fields. Auth required.

2. **Per-file ingest** (for each uploaded file):
   - Determine filename extension from the client-provided filename.
   - Generate `pool_segment_id = generate_id('pool')`, `pool_filename = f"{uuid}{ext}"`.
   - Open `HashingTee` pointed at `pool/<pool_filename>`.
   - Stream chunks from the upload into the tee — one pass, hash + disk write simultaneously.
   - On completion: `hexdigest = tee.hexdigest`; `size = bytes_written`.
   - **Dedup check**: `find_pool_by_hash(project_dir, hexdigest)` (Task 70 helper).
     - If hit:
       - Delete the just-written file from `pool/` (revert — we don't need two copies).
       - Use the existing pool row's id.
     - If miss:
       - Classify media kind via `media.classify_media(pool/<pool_filename>)`. If `None`, reject the upload (non-media); delete file; return 400 with message.
       - Insert a new `pool_segments` row with `source_hash`, `source_size`, `media_kind`, `pool_path = pool_filename`.
   - **Record source_location**: `add_source_location(project_dir, pool_segment_id, source_kind='upload', source_ref=<client-provided filename>, watched_folder_id=None)`.

3. **Directory setup**: on project open (or on first upload), ensure `pool/` exists. No per-kind subdirs.

4. **Response** — return one entry per uploaded file:
   ```json
   {
     "results": [
       {"pool_segment_id": "pool_...", "deduped": true,  "media_kind": "video", "size": 102400, "filename": "clip.mp4"},
       {"pool_segment_id": "pool_...", "deduped": false, "media_kind": "audio", "size": 5240000, "filename": "song.mp3"}
     ]
   }
   ```

5. **Error cases**:
   - Non-media file → reject with 400, delete the written file, return error per filename.
   - Disk full → 500, delete the partial file.
   - Hash collision with an existing DIFFERENT pool row (should never happen with SHA-256; assert / log).

6. **WS broadcast**: after each successful ingest (dedup or not), push a `pool_updated` event with the row id so the Import panel can refresh.

7. **Helper** in `db.py` (if not already present): `get_pool_segment(project_dir, pool_id) -> dict | None` — used when reading for the response.

8. **Tests** (`scenecraft-engine/tests/test_upload.py`):
   - Single video upload → new pool row + source_location row; `media_kind='video'`; disk has the file.
   - Two uploads of the same bytes → one pool row + two source_locations rows; only one file on disk.
   - Image upload classifies as `'image'`; audio as `'audio'`.
   - Non-media upload (`.txt`) rejected with 400; no pool row; no file left on disk.
   - Streaming hash matches post-hoc `hash_file` on the written file (sanity check).
   - WS `pool_updated` fires on each upload.

---

## Verification

- [ ] `/api/projects/:name/pool/upload` accepts multipart uploads.
- [ ] Streams each file through `HashingTee` — single pass, hash + write.
- [ ] Flat `pool/<uuid>.<ext>` layout.
- [ ] Dedup: same hash → reuse existing row, add source_location, remove redundant disk copy.
- [ ] `source_locations` row inserted per upload, `source_kind='upload'`, `source_ref` = user-side filename.
- [ ] Non-media rejected with 400, no disk residue.
- [ ] WS `pool_updated` fires on success.
- [ ] All tests pass including dedup convergence.

---

**Next Task**: [Task 75: Watchdog ingest](task-75-watchdog-ingest.md)
