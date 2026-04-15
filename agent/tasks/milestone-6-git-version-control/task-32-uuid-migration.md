# Task 32: UUID Migration

**Objective**: Replace sequential ID generation with UUID-based prefixed IDs across all entity types
**Milestone**: M6 — Git-Style Version Control
**Priority**: P1
**Repo**: scenecraft-engine
**Estimated Hours**: 6
**Status**: Not Started

---

## Context

Sequential IDs like `kf_001` are unsuitable for multi-user collaboration because two users working in parallel will generate conflicting IDs. Switching to UUID-based IDs (`kf_{hex8}`) eliminates merge conflicts and enables concurrent editing across branches. Since beatlab (the predecessor) is a separate project, no data migration is needed — this is a clean-slate change for scenecraft-engine.

## Design Reference

- [Git-Style Version Control](../../design/local.git-version-control.md)

## Steps

1. Replace `next_keyframe_id()` (sequential `kf_001` format) with UUID-based generation:
   - Use `uuid4().hex[:8]` to generate an 8-character hex string
   - New format: `kf_{hex8}` (e.g., `kf_a3f7c21b`)

2. Replace `next_transition_id()` with UUID-based generation:
   - New format: `tr_{hex8}`

3. Replace track ID generation:
   - New format: `track_{hex8}`

4. Replace effect ID generation:
   - New format: `fx_{hex8}`

5. Replace audio clip ID generation:
   - New format: `clip_{hex8}`

6. Update all asset path references that embed IDs:
   - `selected_keyframes/{id}.png`
   - `keyframe_candidates/candidates/section_{id}/`
   - `selected_transitions/{id}_slot_0.mp4`
   - Search for any other path patterns that interpolate entity IDs

7. Update frontend display code that parses or strips ID prefixes:
   - `VideoTrack.tsx:217` — strips `kf_` prefix for display; verify it handles variable-length hex suffixes

8. Update all `db.py` functions that parse sequential IDs:
   - Remove any logic that extracts numeric sequences from IDs
   - Remove any logic that increments ID counters
   - Replace with UUID generation utility function

9. Create a shared `generate_id(prefix: str) -> str` utility function that all entity types use.

10. Write tests verifying:
    - Generated IDs match the expected format (`{prefix}_{hex8}`)
    - No collisions in a batch of 10,000 generated IDs
    - Asset paths are constructed correctly with new ID format
    - Frontend display code handles new IDs

## Verification

- [ ] All `next_*_id()` functions replaced with UUID-based generation
- [ ] New IDs follow the `{prefix}_{hex8}` format
- [ ] Asset paths use the new ID format throughout
- [ ] `db.py` has no remaining sequential ID parsing logic
- [ ] Frontend display code correctly handles variable-length hex IDs
- [ ] Shared `generate_id()` utility exists and is used by all entity types
- [ ] No hardcoded sequential ID patterns remain in the codebase
- [ ] Tests pass

---

**Dependencies**: None (can be done in parallel with auth tasks)
