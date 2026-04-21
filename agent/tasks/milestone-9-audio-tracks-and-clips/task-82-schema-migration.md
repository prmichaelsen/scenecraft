# Task 82: Schema Migration (Greenfield)

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 3-4 hours  
**Dependencies**: None  
**Status**: Not Started  

---

## Objective

Create the `audio_clip_links` table and change `audio_clips` / `audio_tracks` to use `volume_curve TEXT` (JSON dB curve) instead of the existing `volume REAL` scalar. Greenfield — no migration of existing rows.

---

## Context

Design doc (Data Model section) is canonical. Greenfield is acceptable because `audio_clips` has never had user-facing rows in production. The legacy `volume` column on both tables is dropped entirely; `muted` is retained as a separate flag.

---

## Steps

### 1. Modify `src/scenecraft/db.py`

Replace current `audio_tracks` and `audio_clips` `CREATE TABLE` statements in `_ensure_schema`:

```sql
CREATE TABLE IF NOT EXISTS audio_tracks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'Audio Track 1',
    display_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    hidden INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0,
    volume_curve TEXT NOT NULL DEFAULT '[[0,0],[1,0]]'
);

CREATE TABLE IF NOT EXISTS audio_clips (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    source_path TEXT NOT NULL DEFAULT '',
    start_time REAL NOT NULL DEFAULT 0,
    end_time REAL NOT NULL DEFAULT 0,
    source_offset REAL NOT NULL DEFAULT 0,
    volume_curve TEXT NOT NULL DEFAULT '[[0,0],[1,0]]',
    muted INTEGER NOT NULL DEFAULT 0,
    remap TEXT NOT NULL DEFAULT '{"method":"linear","target_duration":0}',
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS audio_clip_links (
    audio_clip_id TEXT NOT NULL,
    transition_id TEXT NOT NULL,
    offset REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (audio_clip_id, transition_id)
);
CREATE INDEX IF NOT EXISTS idx_acl_transition ON audio_clip_links(transition_id);
CREATE INDEX IF NOT EXISTS idx_acl_audio_clip ON audio_clip_links(audio_clip_id);
```

Existing DBs with old `volume` columns need a one-shot wipe migration (acceptable because greenfield). Add to `_ensure_schema` after the CREATE:

```python
# Greenfield: drop legacy volume column by detecting its presence once
cols = {r[1] for r in conn.execute("PRAGMA table_info(audio_clips)").fetchall()}
if "volume" in cols and "volume_curve" not in cols:
    conn.executescript("""
        DROP TABLE IF EXISTS audio_clips;
        DROP TABLE IF EXISTS audio_tracks;
        -- tables will be recreated on next call since IF NOT EXISTS above
    """)
```

### 2. Update `get_audio_tracks` / `add_audio_track` / etc.

Any function in `db.py` that reads or writes `volume` must be updated to read/write `volume_curve`. Search for `audio_clips` and `audio_tracks` function definitions and update column lists.

### 3. Add link-table helpers in `db.py`

```python
def add_audio_clip_link(project_dir: Path, audio_clip_id: str, transition_id: str, offset: float = 0)
def get_audio_clip_links_for_transition(project_dir: Path, transition_id: str) -> list[dict]
def get_audio_clip_links_for_clip(project_dir: Path, audio_clip_id: str) -> list[dict]
def remove_audio_clip_link(project_dir: Path, audio_clip_id: str, transition_id: str)
def remove_audio_clip_links_for_transition(project_dir: Path, transition_id: str)
```

### 4. Tests

Add to `tests/test_db.py` (create if missing):
- Schema creation idempotent
- Link CRUD
- `volume_curve` default values

---

## Verification

- [ ] `audio_tracks` and `audio_clips` schemas match design doc exactly
- [ ] `audio_clip_links` table + two indices exist
- [ ] No `volume REAL` column remains on either table
- [ ] `volume_curve` defaults to `'[[0,0],[1,0]]'`
- [ ] Tests pass

---

**Next Task**: [Task 83: Audio-stream extract](task-83-audio-extract.md)
