# Task 65: Frontend Lip-Sync Tab in TransitionPanel

**Objective**: Add a Lip-Sync tab to TransitionPanel with speaker mapping UI, transcript display, generation trigger, and candidate list
**Milestone**: M8 — Characters & Lip-Sync
**Priority**: P1
**Repo**: scenecraft (frontend)
**Estimated Hours**: 8
**Status**: Not Started

---

## Context

The Lip-Sync tab is where users review WhisperX's speaker detection, confirm or override the proposed character mapping, kick off generation, and manage lipsync candidates. Lives alongside the existing `details | candidates | browse | bench` tabs.

## Design Reference

- [Characters and Lip-Sync](../../design/local.characters-and-lipsync.md) — Frontend section

## Steps

1. Add `'lipsync'` to the tab enum in `TransitionPanel.tsx` (line ~20 where `_lastTrTab` is typed).

2. Header section (shown on tab open):
   - Call `/transitions/:id/resolved-characters` to fetch characters named in the action text
   - Render as pills: "This scene features: Jane, Marcus"
   - Warning banner if empty: "No characters named in the action. Add character names to the action text."

3. Diarization section (auto-runs on tab open if no prior diarization data in state):
   - Call `postLipsyncDiarize`, show spinner
   - On success: render a speaker-mapping table:
     - One row per detected speaker
     - Waveform mini-timeline showing that speaker's segments (derived from `segments[]`)
     - Play button (loads original audio, seeks + plays that segment range)
     - Character dropdown (populated from resolved characters, with all other characters as fallback)
     - Pre-fill from `proposed_map`
   - Below, a collapsible "Transcript" section showing the `text` for each segment: "Jane (0.0–2.3s): Hello Marcus..."

4. Generate section:
   - "Generate Lip-Sync" button — disabled until every speaker has a character assigned
   - Shows estimated cost: "≈ $0.35" (based on clip duration + Sync.so rate)
   - On click, call `postLipsyncGenerate`, switch to job progress view
   - Progress bar + current phase ("S2S segment 2/3...") via the existing job state context

5. Candidates section:
   - List all lipsyncs from `fetchTransitionLipsyncs`
   - "Original (no lip-sync)" pseudo-entry always first; shows as active when `active_lipsync_id` is null
   - Each lipsync row: thumbnail (first frame), timestamp, speaker map summary, stale badge if applicable, "Make Active" + "Delete" buttons
   - Clicking "Make Active" calls `postSetActiveLipsync`, highlights the row, refreshes the preview panel

6. Wire up hover-video preview (reuse the `onHoverVideo` prop pattern) so users see each lipsync in the main preview panel on hover.

7. Tests with mocked endpoints covering: diarization loads, mapping can be edited, generation kicks off a job, candidates list renders correctly.

## Verification

- [ ] Opening Lip-Sync tab triggers diarization automatically
- [ ] Speaker mapping pre-filled based on proposed map; user can override
- [ ] Transcript is readable and scrollable
- [ ] Generate button enabled only after mapping is complete
- [ ] Progress bar updates through S2S + stitch + Sync.so phases
- [ ] Candidates list shows all variants, active one highlighted
- [ ] Clicking "Make Active" updates preview panel
- [ ] Hover on a candidate plays it in the preview panel with audio

---

**Dependencies**: Task 64 (lipsync API), Task 62 (action-text resolver, for the header)
