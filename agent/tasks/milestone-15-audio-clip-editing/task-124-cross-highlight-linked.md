# Task 124: Cross-Highlight Linked Transition ↔ Audio on Selection

**Milestone**: [M15](../../milestones/milestone-15-audio-clip-editing.md)
**Estimated Time**: 1.5-2 hours
**Dependencies**: None (polish deferred from M9 Task 89)
**Status**: Not Started

---

## Objective

When the user selects a transition, visually highlight the audio clip(s) it's linked to. When they select a linked audio clip, highlight the transition. No new selection state — this is a pure rendering concern over the existing `audio_clip_links`.

---

## Steps

### 1. Surface link data in the timeline

`audio_clip_links` is returned by the backend as part of audio-clips responses (check — if not, extend). Expose a `link?: { transition_id: string }` on each `AudioClip` in the client type.

### 2. Compute the highlighted set

In `Timeline.tsx`:

- When `selectedTransition` is set, find audio clips where `link.transition_id === selectedTransition.id` → set `highlightedAudioClipIds`.
- When `selectedAudioClipId` is set, look up its clip; if linked, set `highlightedTransitionId = link.transition_id`.

Pass through the tree.

### 3. Visual treatment

- `AudioClipBlock`: when `highlighted`, add `ring-2 ring-yellow-300/60 shadow-[0_0_12px_rgba(252,211,77,0.4)]` (or similar — subtle glow).
- Transition on `TransitionTrack`: when `highlighted`, matching glow.
- Keep the existing "selected" ring distinct from the "linked-to-selected" glow.

### 4. Tests

- Snapshot: select a linked transition → the matching audio clip renders with the highlight class.
- Vice versa.

---

## Verification

- [ ] Clicking a transition highlights its linked audio clip(s)
- [ ] Clicking a linked audio clip highlights its transition
- [ ] Highlight is visually distinct from the "selected" state

---

**Next Task**: [Task 125 — Extraction ghost](task-125-extraction-ghost.md)
