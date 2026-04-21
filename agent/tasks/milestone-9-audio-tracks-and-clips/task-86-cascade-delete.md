# Task 86: Cascade Delete on Transition Removal

**Milestone**: [M9 - Audio Tracks and Audio Clips](../../milestones/milestone-9-audio-tracks-and-clips.md)  
**Design Reference**: [Audio Tracks and Audio Clips](../../design/local.audio-tracks-and-clips.md)  
**Estimated Time**: 2-3 hours  
**Dependencies**: Task 84 (routing/insert), Task 82 (link table)  
**Status**: Not Started  

---

## Objective

When a transition is soft-deleted (or hard-deleted), cascade to its linked audio clips: soft-delete the audio clips and remove the link rows. Restore via undo must reverse both.

---

## Context

Matches existing soft-delete convention for transitions (`deleted_at` timestamp). Link rows are hard-deleted because they have no meaningful existence without both endpoints.

---

## Steps

### 1. Extend transition-delete handler

Find the delete path in `api_server.py`. After marking the transition `deleted_at`:

```python
# 1. Collect links
links = get_audio_clip_links_for_transition(project_dir, transition_id)
# 2. Soft-delete the audio clips
for link in links:
    delete_audio_clip(project_dir, link["audio_clip_id"])  # sets deleted_at
# 3. Remove the link rows (hard delete — no meaning without transition)
remove_audio_clip_links_for_transition(project_dir, transition_id)
```

Wrap in the same undo group as the transition delete so a single undo restores both.

### 2. Restore path

Existing `restore_transition` / `restore-transition` endpoint. After restoring the transition, restore the linked audio clips:

```python
# Look up links that were associated with this transition (via undo journal or
# a "soft-unlink" approach: preserve links in a shadow table when deleting)
```

Two strategies:

- **(a)** Preserve link rows during delete (don't actually remove them). On restore, re-attach. Simpler but requires filtering for valid (non-orphan) links throughout the codebase.
- **(b)** Snapshot links in the undo-journal row when deleting. On undo, re-insert. Cleaner data model; leans on existing undo infrastructure.

Recommend (b) — undo journal already captures row snapshots for restore.

### 3. Tests

- Delete transition with 1 linked clip → both marked deleted; link row gone
- Restore transition → linked clip restored; link row recreated
- Delete transition with 0 links → no-op, no error
- Delete transition with 3 clips → all three soft-deleted; three link rows gone

---

## Verification

- [ ] Delete transition cascade-deletes linked audio clips
- [ ] Link rows removed on delete (or preserved if strategy (a))
- [ ] Undo restores both transition and linked audio atomically
- [ ] Transition with no links deletes cleanly

---

**Next Task**: [Task 87: Timeline audio lanes](task-87-timeline-audio-lanes.md)
