# Task 14: Polish End Frame Modes for Video Generation

**Milestone**: Unassigned  
**Design Reference**: None  
**Estimated Time**: 2-3 hours  
**Dependencies**: None (feature already implemented)  
**Status**: Not Started  

---

## Objective

Polish the end frame mode selector (Keyframe / Next Tr / None) for transition video generation. The core feature is implemented — this task covers edge cases, UX refinements, and visual feedback.

---

## Steps

### 1. Visual feedback for end frame mode

- Show a thumbnail preview of the resolved end frame next to the mode selector
- For "Next Tr" mode: show which transition's first frame will be used (e.g. "Using tr_123 start")
- For "None" mode: show a visual indicator (e.g. dashed border or "?" placeholder) in the end frame preview area
- Gray out "Next Tr" option if the next transition has no selected video

### 2. Backend: clean up extracted frames

- The `_next_tr_start_{tr_id}.png` files extracted by ffmpeg accumulate in `selected_keyframes/`
- Add cleanup: delete these temp files after generation completes
- Or use a temp directory instead of `selected_keyframes/`

### 3. Batch generation support

- When generating videos for multiple transitions at once (Timeline batch generate button), respect the end frame mode
- Pass the mode through from Timeline.tsx batch generate handler to the server function

### 4. Persist end frame mode preference

- Store the last-used end frame mode in localStorage so it persists across panel switches
- Key: `beatlab-end-frame-mode`

---

## Verification

- [ ] End frame thumbnail preview shows correct image for each mode
- [ ] "Next Tr" grayed out when no next transition video exists
- [ ] Temp extracted frames cleaned up after generation
- [ ] Batch generate respects end frame mode
- [ ] Mode persists across panel switches via localStorage

---

## Notes

- This is a polish task — the core feature (3-way end frame mode, backend support for noEndFrame and useNextTransitionFrame) is already shipped
- Low priority — the feature works as-is, these are UX refinements

---

**Related**: End frame mode was added in commit `f9da896`  
