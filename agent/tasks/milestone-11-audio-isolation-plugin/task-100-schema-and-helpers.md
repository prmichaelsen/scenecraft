# Task 100: Schema & audio_candidates Helpers

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md)
**Estimated Time**: 3 hours
**Dependencies**: None (net-new schema; audio_clips already exists)
**Status**: Not Started

---

## Objective

Add the backend DB layer that audio-clip candidates will ride on: new `audio_candidates` junction, `audio_clips.selected` column, and helpers that mirror the existing `tr_candidates` pattern.

Implements in `scenecraft-engine/src/scenecraft/db.py`.

---

## Steps

### 1. Schema in `_ensure_schema`

Add to the main `CREATE TABLE IF NOT EXISTS` block in `db.py`:

```sql
CREATE TABLE IF NOT EXISTS audio_candidates (
    audio_clip_id     TEXT NOT NULL REFERENCES audio_clips(id),
    pool_segment_id   TEXT NOT NULL REFERENCES pool_segments(id),
    added_at          TEXT NOT NULL,
    source            TEXT NOT NULL,  -- 'generated' | 'imported' | 'chat_generation' | 'plugin'
    PRIMARY KEY (audio_clip_id, pool_segment_id)
);
CREATE INDEX IF NOT EXISTS idx_audio_cand_clip ON audio_candidates(audio_clip_id);
CREATE INDEX IF NOT EXISTS idx_audio_cand_seg ON audio_candidates(pool_segment_id);
```

Add `audio_clips.selected` via an idempotent migration block (matching the existing pattern for adding columns to older DBs):

```python
cols = {row[1] for row in conn.execute("PRAGMA table_info(audio_clips)").fetchall()}
if "selected" not in cols:
    conn.execute("ALTER TABLE audio_clips ADD COLUMN selected TEXT")
```

### 2. Helpers

Add to `db.py`, grouped near the existing `tr_candidates` helpers:

```python
def add_audio_candidate(
    project_dir: Path,
    *,
    audio_clip_id: str,
    pool_segment_id: str,
    source: str,
    added_at: str | None = None,
) -> None:
    """Insert a junction row. Idempotent by PK."""
    assert source in ("generated", "imported", "chat_generation", "plugin"), f"bad source: {source}"
    conn = get_db(project_dir)
    conn.execute(
        "INSERT OR IGNORE INTO audio_candidates (audio_clip_id, pool_segment_id, added_at, source) VALUES (?, ?, ?, ?)",
        (audio_clip_id, pool_segment_id, added_at or _now_iso(), source),
    )
    conn.commit()


def get_audio_candidates(project_dir: Path, audio_clip_id: str) -> list[dict]:
    """Return ordered candidate rows joined with pool_segments (newest first).
    Pattern mirrors get_tr_candidates — returns pool_segment dicts with addedAt + junctionSource."""
    conn = get_db(project_dir)
    rows = conn.execute(
        """SELECT ac.added_at, ac.source, ps.*
           FROM audio_candidates ac
           JOIN pool_segments ps ON ps.id = ac.pool_segment_id
           WHERE ac.audio_clip_id = ?
           ORDER BY ac.added_at DESC""",
        (audio_clip_id,),
    ).fetchall()
    result = []
    for row in rows:
        seg = _row_to_pool_segment(row)
        seg["addedAt"] = row["added_at"]
        seg["junctionSource"] = row["source"]
        result.append(seg)
    return result


def assign_audio_candidate(project_dir: Path, audio_clip_id: str, pool_segment_id: str | None) -> None:
    """Set audio_clips.selected. Pass None to revert to 'source file'."""
    conn = get_db(project_dir)
    conn.execute("UPDATE audio_clips SET selected = ? WHERE id = ?", (pool_segment_id, audio_clip_id))
    conn.commit()


def remove_audio_candidate(project_dir: Path, audio_clip_id: str, pool_segment_id: str) -> None:
    conn = get_db(project_dir)
    conn.execute(
        "DELETE FROM audio_candidates WHERE audio_clip_id = ? AND pool_segment_id = ?",
        (audio_clip_id, pool_segment_id),
    )
    # If the removed one was selected, revert to NULL
    conn.execute(
        "UPDATE audio_clips SET selected = NULL WHERE id = ? AND selected = ?",
        (audio_clip_id, pool_segment_id),
    )
    conn.commit()
```

### 3. Read-path integration

Audit any existing audio-playback or export code for `audio_clips` that currently uses the clip's `source_path` directly. Where relevant, update to prefer the selected candidate's `pool_segments.pool_path` when `audio_clips.selected` is not NULL; fall back to `source_path` otherwise.

- Grep for `audio_clip` / `source_path` read sites in `api_server.py` and the render pipeline
- Introduce a helper:

```python
def get_audio_clip_effective_path(project_dir: Path, audio_clip: dict) -> str:
    """Returns the pool_segment's pool_path if a candidate is selected, else the clip's source_path."""
    selected = audio_clip.get("selected")
    if selected:
        seg = get_pool_segment(project_dir, selected)
        if seg and seg.get("poolPath"):
            return seg["poolPath"]
    return audio_clip.get("source_path", "")
```

Don't change every call site in this task — just introduce the helper and update the hottest read paths. The plugin's own work (task 102) will use it.

### 4. Tests

New file: `scenecraft-engine/tests/test_audio_candidates.py` with a minimal fixture DB:

- Create an audio_clip + 2 pool_segments of kind='audio'
- `add_audio_candidate` for both; verify `get_audio_candidates` returns them in the expected order
- `assign_audio_candidate` sets `audio_clips.selected`; verify via raw SQL
- `remove_audio_candidate` deletes the junction row AND clears `selected` if it pointed at the removed segment
- Attempt to add with an invalid `source` value → assertion error
- Idempotency: `add_audio_candidate` on the same (clip, segment) twice is a no-op (INSERT OR IGNORE)

---

## Verification

- [ ] `_ensure_schema` creates the `audio_candidates` table + indexes on a fresh DB
- [ ] Running the migration block on an existing DB (without `audio_clips.selected`) adds the column
- [ ] `add_audio_candidate` / `get_audio_candidates` / `assign_audio_candidate` / `remove_audio_candidate` work per the tests above
- [ ] `get_audio_clip_effective_path` helper returns pool_path when selected, source_path otherwise
- [ ] All existing audio tests still pass
