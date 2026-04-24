# Task 134: Drag-to-Timeline + Purple Styling

**Milestone**: [M16](../../milestones/milestone-16-music-generation-plugin.md)
**Spec**: `agent/specs/local.music-generation-plugin.md` — R37-R40
**Estimated Time**: 2 hours
**Dependencies**: task-132 (panel with track rows)
**Status**: Not Started

---

## Objective

Emit the `application/x-scenecraft-stem` drag payload from panel track rows so `AudioLane.tsx` (task-104b drop handler) can create audio_clips. Add purple color styling driven by `pool_segment.variant_kind='music'`. No auto-create of "Music" track — user drops wherever they want.

---

## Steps

### 1. Drag payload emission (in task-132's track row)

```typescript
function onTrackRowDragStart(e: React.DragEvent, track: GenerationTrack, sourceLabel: string) {
  const payload = {
    pool_segment_id: track.pool_segment_id,
    stem_type: 'music',
    duration_seconds: track.duration_seconds,
    pool_path: track.pool_path,                  // from generation.tracks
    source_label: track.song_title ?? sourceLabel,
  }
  e.dataTransfer.setData('application/x-scenecraft-stem', JSON.stringify(payload))
  e.dataTransfer.effectAllowed = 'copy'
}
```

Source label fallback when Musicful didn't return a title: `{style} · v{n}` — but honestly, just use the generation's style field truncated.

### 2. AudioLane.tsx drop handler

Already exists from M11 task-104b. Two small changes:

- Confirm the drop handler doesn't care about `stem_type` — it just reads `pool_segment_id`, `duration_seconds`, `pool_path`. Per spec R38, it shouldn't care. Verify with a quick read of `AudioLane.tsx`.
- Ensure no "Music" track auto-create logic fires on `stem_type='music'` — drop goes to whichever audio track the drop target represents, exactly as isolation-stem drops do today.

No changes expected unless AudioLane has an `if stem_type === 'isolation' ... else ...` branch that excludes `'music'`. Remove the branch if so — the handler should be stem-type-agnostic beyond what's needed for clip naming.

### 3. Clip name template (R39)

New clip's `name` on drop: `track.song_title` (user-renameable via existing rename affordance; no special UI needed).

If `song_title` is null/empty (edge case), fall back to `{generation.style} · v{n}` where `n` = this clip's index within the generation. Keep it in `AudioLane.tsx`'s drop handler since that's where the clip row is created.

### 4. Purple clip styling (R40)

Create `scenecraft/src/lib/audio-clip-styling.ts`:

```typescript
export const VARIANT_KIND_COLORS: Record<string, string> = {
  music:   'bg-purple-500/70 border-purple-400',
  lipsync: 'bg-teal-500/70 border-teal-400',      // M13 reserved
}

export const DEFAULT_CLIP_COLOR = 'bg-blue-500/70 border-blue-400'

export function getClipColorClass(variantKind: string | null | undefined): string {
  if (variantKind && VARIANT_KIND_COLORS[variantKind]) {
    return VARIANT_KIND_COLORS[variantKind]
  }
  return DEFAULT_CLIP_COLOR
}
```

Exact tailwind classes are a best guess; match scenecraft's existing palette. Pick consistent opacity/border treatment across the three kinds.

### 5. AudioLane render integration

In `AudioLane.tsx`'s clip rendering code:

```typescript
import { getClipColorClass } from '@/lib/audio-clip-styling'

// For each clip, look up its source pool_segment's variant_kind:
const variantKind = poolSegments[clip.source_path]?.variant_kind
const colorClass = getClipColorClass(variantKind)

// Apply to the clip div:
<div className={cn('audio-clip', colorClass, ...)}>
```

The `pool_segments` data needs to be available to `AudioLane`. Check if it's already threaded through `EditorDataContext`; if not, extend the server-side loader to include `variant_kind` per pool_segment reference.

### 6. Tests

In `scenecraft/src/plugins/generate-music/__tests__/drag.test.tsx`:

- `drag-start-sets-payload` — simulate dragstart on a track row, inspect `dataTransfer.getData('application/x-scenecraft-stem')`, assert shape matches spec

In `scenecraft/src/components/editor/__tests__/AudioLane.drop.test.tsx` (extend existing if present):

- `drop-creates-audio-clip-with-song-title-name` — drop music payload → new clip's name = song_title
- `drop-on-existing-track-no-auto-create` — drop on at-1 → no new track created; clip lands on at-1
- `drop-music-renders-purple` — rendered clip has purple color class
- `drop-lipsync-renders-teal` — for the M13 variant kind, teal renders (cross-plugin sanity)
- `drop-no-variant-kind-renders-default` — regular audio_clip renders blue

---

## Verification

- [ ] Drag payload shape matches spec R37
- [ ] Drop on any audio track creates a clip on THAT track (no auto-create "Music" track)
- [ ] Clip color reflects `variant_kind`
- [ ] Variant-kind color map is extensible (adding a new variant kind is one-line)
- [ ] Existing isolation-stem drops still work (no regression)

---

## Notes

- The M11 isolation drop handler is the precedent. Read it before starting. If it already has a stem_type branch that omits `'music'`, the fix is just adding `'music'` to the allowed set (or removing the branch entirely — drop is stem-type-agnostic per spec).
- Tailwind class exact values are implementer's call. Be consistent with scenecraft's existing editor palette (check `AudioLane.tsx` for the current non-music clip color).
- If the project uses CSS variables, a `--clip-color-music` token is fine too. Pick whichever scenecraft frontend has been using.
- The `pool_segments.variant_kind` column lands via task-127 (piggybacking on M13's schema addition).
