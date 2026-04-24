# Task 149: Orange Clip Styling

**Milestone**: [M18](../../milestones/milestone-18-foley-generation-plugin.md)
**Design Reference**: [`local.foley-generation-plugin.md`](../../design/local.foley-generation-plugin.md) — "Visual Identity"
**Clarification**: [`clarification-12-foley-generation-plugin.md`](../../clarifications/clarification-12-foley-generation-plugin.md) — Item 9
**Estimated Time**: 1 hour
**Dependencies**: task-147 (panel uses the color map for run cards)
**Status**: Not Started

---

## Objective

Add `variant_kind='foley'` → **orange** to the frontend's clip color map. Applies everywhere clips render — Timeline audio lanes, pool view, run cards, drag ghost images.

---

## Context

Existing `variant_kind` → color map (pre-M18):

| variant_kind | color  | established by |
|---|---|---|
| `music` | purple | M16 |
| `lipsync` | teal | reserved by M8/M13 |
| (default visual) | blue | core |

Foley joins as `foley` → **orange**. User's rationale: *"orange, contrasts with music coded palette"* — warm organic tone distinguishes foley from the cool audio-family tones already in use.

---

## Steps

### 1. Find the color map

Locate the centralized color map in frontend:

```bash
grep -rE "variant_kind|variantKind" scenecraft/src/ | grep -i "color\|palette\|map"
```

Likely in something like `scenecraft/src/lib/clip-colors.ts` or similar (confirm exact path — M16 added it).

### 2. Add the foley entry

```typescript
// scenecraft/src/lib/clip-colors.ts (or equivalent)

export const VARIANT_KIND_COLORS: Record<string, ClipColor> = {
  music: '#A855F7',    // purple
  lipsync: '#14B8A6',  // teal
  foley: '#F97316',    // orange (NEW)
};

export const DEFAULT_CLIP_COLOR = '#3B82F6'; // blue
```

Exact hex for orange: `#F97316` (Tailwind orange-500) is a reasonable starting point. Adjust if design-system palette specifies otherwise.

### 3. Verify all render sites consume the map

Search for anywhere clip colors are resolved:

```bash
grep -rE "VARIANT_KIND_COLORS|variantKindColor" scenecraft/src/
```

Confirm the following sites read from the centralized map:
- Timeline clip component (audio lane rendering)
- Pool/bin view clip thumbnails
- Drag ghost images
- Run card result thumbnails (task-147's panel)

If any render site hardcodes colors, refactor it to consume the map. Don't leave fragmented color logic.

### 4. Dark-mode / theme variants

If scenecraft has theme variants (light + dark), define orange variants for both:

```typescript
export const VARIANT_KIND_COLORS_DARK: Record<string, ClipColor> = {
  music: '#C084FC',    // purple-400 for dark mode
  lipsync: '#2DD4BF',  // teal-400
  foley: '#FB923C',    // orange-400 (NEW)
};
```

Match the existing theming pattern — if only a single palette exists, skip.

### 5. Tests

- Color map has `foley` → expected hex
- Timeline renders a pool_segment with `variant_kind='foley'` in orange
- Pool view renders the same segment in orange
- Drag ghost image shows the orange color

### 6. Visual QA

Manual verification:
- Load a project with a foley pool_segment (can manually insert for testing)
- Confirm orange in Timeline, pool view, and run card
- Confirm it visually contrasts against purple (music) and teal (lipsync)
- Confirm it doesn't clash with the default blue for non-variant clips

---

## Verification

- [ ] `VARIANT_KIND_COLORS` has `foley` entry with selected orange hex
- [ ] Dark-mode variant (if applicable) also defined
- [ ] All clip-render sites consume the centralized map (no hardcoded colors added)
- [ ] Test: foley pool_segment renders orange in Timeline
- [ ] Test: foley pool_segment renders orange in pool view
- [ ] Test: drag ghost shows orange
- [ ] Visual QA confirms contrast against purple/teal/blue
- [ ] No regression in existing music/lipsync/default coloring

---

## Expected Output

```
scenecraft/src/lib/clip-colors.ts               (modified)

scenecraft/tests/lib/
└── test_clip_colors.spec.ts                    (new)
```

---

## Notes

- Small task, low risk. Keep the diff minimal; resist scope creep into a general "clip theming" refactor.
- If a design system (Tailwind config, theme tokens) exists, pull the orange from there instead of hardcoding — but don't extract a new design token just for this task.

---

**Final task of M18.** After this lands, milestone's verification checklist can be exercised end-to-end.
