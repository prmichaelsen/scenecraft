# Milestone 11: Audio Isolation Plugin (First-Party MVP)

**Goal**: Ship scenecraft's first plugin — a one-click operation that denoises an audio clip using DeepFilterNet3 — built like a real plugin (own `src/plugins/` dir, `plugin.yaml`, narrow seam) but wired statically so we don't need the extension runtime to ship it
**Duration**: 2 weeks
**Dependencies**: None (M9 audio_clips/audio_tracks already in tree; plugin scaffolding is greenfield)
**Status**: Not Started

---

## Overview

This milestone delivers scenecraft's first real plugin and, as a side effect, the minimum plugin scaffolding (contribution categories, host API, static registry) needed to host it. The plugin — `isolate-vocals` — removes background noise (chatter, wind, HVAC, hiss) from an audio clip and appends the cleaned audio as a new candidate on the source, auto-selecting it. Users A/B by toggling selection; zero timeline reconciliation.

It also validates the plugin architecture: the `plugin.yaml` manifest, the `plugin-api` seam, the static `PluginHost` registry, and two new contribution categories (`operations`, `contextMenus`) all get exercised by this single plugin. When the real loader lands in a future milestone, plugin code written here loads unchanged.

**Design**: [local.audio-isolation-plugin.md](../design/local.audio-isolation-plugin.md)

---

## Deliverables

### 1. Schema Additions
- `audio_candidates(audio_clip_id, pool_segment_id, added_at, source)` junction table
- `audio_clips.selected` column (`pool_segment_id` of currently-selected candidate, NULL = source)
- `pool_segments.kind = 'audio'` (reuses existing column)
- `add_audio_candidate` / `get_audio_candidates` / `assign_audio_candidate` DB helpers

### 2. Plugin Scaffolding
- `scenecraft-engine/src/scenecraft/plugin_api.py` — narrow host API re-exports
- `scenecraft-engine/src/scenecraft/plugin_host.py` — static PluginHost registry
- `scenecraft/src/lib/plugin-api.ts` — frontend host API
- `scenecraft/src/lib/plugin-host.ts` — frontend registry
- Host calls `PluginHost.register(isolate_vocals)` at server startup / editor entry

### 3. Backend Plugin
- `scenecraft-engine/src/scenecraft/plugins/isolate_vocals/` with:
  - `plugin.yaml` (documentation-only for MVP)
  - `__init__.py` exporting `activate(api)` + `run`
  - `isolate_vocals.py` kickoff helper (threaded job, JobManager progress)
  - `model.py` DeepFilterNet3 loader + inference (lazy)
  - `README.md` + tests
- `/api/projects/:name/plugins/isolate-vocals/run` REST endpoint registered via `plugin_api.register_rest_endpoint`

### 4. Frontend Plugin
- `scenecraft/src/plugins/isolate-vocals/` with:
  - `plugin.yaml` manifest mirror
  - `index.ts` — context-menu descriptor + `activate(host)`
  - `IsolateVocalsDialog.tsx` — confirm dialog (model, ETA, Run/Cancel)
  - `isolate-vocals-client.ts` — REST/WS client
- Context-menu item "Isolate vocals…" on `audio_clip` entities

### 5. Audio Clip Panel
- New `AudioClipPanel.tsx` analogous to `KeyframePanel` / `TransitionPanel`
- Shows candidate list + selected indicator + per-candidate metadata (source, created, size)
- `assign_audio_candidate` wiring so the user can switch between candidates

### 6. Chat Tool Wrapper
- `isolate_vocals(entity_type, entity_id)` tool in `chat.py`
- `"isolate_"` added to `_DESTRUCTIVE_TOOL_PATTERNS` → elicitation auto-gates
- `_format_destructive_summary` case: shows entity, model, ETA

---

## Success Criteria

- [ ] Right-click an audio_clip in the timeline → context menu shows "Isolate vocals…"
- [ ] Clicking "Isolate vocals…" opens a confirm dialog; on Run, a job kicks off
- [ ] Job progress streams over WS; a toast + a spinner on the clip show status
- [ ] On completion, a new `audio_candidate` row is inserted and `audio_clips.selected` points to it
- [ ] The AudioClipPanel shows the new candidate and marks it as selected
- [ ] `pool_segments.kind = 'audio'` is accepted by existing import/export/bin paths
- [ ] Running the operation twice produces two candidates; the latest is auto-selected; earlier ones remain for A/B
- [ ] Chat tool `isolate_vocals` fires the elicitation; decline leaves state unchanged; accept runs the job and the assistant message includes the new pool_segment_id
- [ ] All mutations appear in `undo_groups` and can be undone
- [ ] No yaml files in the runtime path (schema, manifest-as-docs only, no yaml parsing at runtime)
- [ ] End-to-end smoke: fixture audio clip → "Isolate vocals…" → candidate appears in panel in ≤ clip duration × 2 (CPU)

---

## Key Files to Create

```
scenecraft/                                                   (frontend repo)
├── src/
│   ├── lib/
│   │   ├── plugin-api.ts                                     (NEW)
│   │   └── plugin-host.ts                                    (NEW)
│   ├── plugins/
│   │   └── isolate-vocals/                                   (NEW)
│   │       ├── plugin.yaml
│   │       ├── index.ts
│   │       ├── IsolateVocalsDialog.tsx
│   │       └── isolate-vocals-client.ts
│   └── components/editor/
│       └── AudioClipPanel.tsx                                (NEW)

scenecraft-engine/                                            (backend repo)
└── src/scenecraft/
    ├── plugin_api.py                                         (NEW)
    ├── plugin_host.py                                        (NEW)
    ├── plugins/
    │   └── isolate_vocals/                                   (NEW)
    │       ├── plugin.yaml
    │       ├── __init__.py
    │       ├── isolate_vocals.py
    │       ├── model.py
    │       ├── README.md
    │       └── tests/test_isolate_vocals.py
    └── db.py                                                 (MODIFIED: schema, helpers)
    └── api_server.py                                         (MODIFIED: PluginHost.register startup)
    └── chat.py                                               (MODIFIED: tool + elicitation pattern)
```

---

## Tasks

1. [Task 100: Schema & audio_candidates helpers](../tasks/milestone-11-audio-isolation-plugin/task-100-schema-and-helpers.md) — Backend DB layer (3h)
2. [Task 101: Plugin host scaffolding](../tasks/milestone-11-audio-isolation-plugin/task-101-plugin-host-scaffolding.md) — plugin-api + PluginHost, both repos (4h)
3. [Task 102: Backend isolate-vocals plugin](../tasks/milestone-11-audio-isolation-plugin/task-102-backend-plugin.md) — DFN3 integration + REST endpoint (6h)
4. [Task 103: Frontend isolate-vocals plugin](../tasks/milestone-11-audio-isolation-plugin/task-103-frontend-plugin.md) — Manifest + descriptor + dialog + client (5h)
5. [Task 104: AudioClipPanel](../tasks/milestone-11-audio-isolation-plugin/task-104-audio-clip-panel.md) — New candidates UI (5h)
6. [Task 105: Chat tool `isolate_vocals`](../tasks/milestone-11-audio-isolation-plugin/task-105-chat-tool.md) — Tool wrapper + elicitation gate (2h)

**Total**: ~25h

---

## Dependencies / Prerequisites

- **M9 audio tracks & clips** — underlying `audio_clips` / `audio_tracks` tables must exist (already in tree)
- **DeepFilterNet3** — pip installable; lazy-downloaded on first use; no scenecraft-hosted weights
- **ffmpeg** — already used elsewhere in scenecraft-engine; required for source→wav transcode
- **JobManager** — existing infra; reused for progress reporting

---

## Testing Requirements

- [ ] Unit: DB helpers (`add_audio_candidate`, `get_audio_candidates`, `assign_audio_candidate`) round-trip
- [ ] Unit: `PluginHost.register` / `get_operation` collects and exposes correctly
- [ ] Unit: `plugin_api` re-exports are stable (snapshot test of the module's public surface)
- [ ] Unit: `isolate_vocals.run` kickoff returns `{job_id, audio_clip_id}`; mocked DFN3 client produces deterministic fixture output
- [ ] Integration: POST `/api/projects/:name/plugins/isolate-vocals/run` → job → DB rows created → `audio_clips.selected` updated
- [ ] Integration: Chat tool path: `isolate_vocals` fires elicitation; decline leaves state unchanged; accept runs the job
- [ ] E2E: Right-click audio_clip → "Isolate vocals…" → dialog → progress → candidate visible in AudioClipPanel

---

## Documentation Requirements

- [ ] Plugin `README.md` in `plugins/isolate_vocals/` explaining model, lazy download, limitations
- [ ] Update `local.contribution-points.md` to reference the new `operations` + `contextMenus` categories (or note that `local.audio-isolation-plugin.md` supersedes the relevant sections)
- [ ] Inline doc comments on `plugin-api.py` / `lib/plugin-api.ts` marking the public surface

---

## Risks and Mitigation

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| DeepFilterNet3 on a user's CPU is slower than "realtime" claim | Medium | Low | Dialog shows honest range (1–2× for CPU); progress UI sized for the worst case |
| DFN3 weight download fails (no network, HF unreachable) | Medium | Low | Error surfaces in the dialog + toast; plugin logs the exact URL for manual fetch |
| `audio_clips.selected` NULL-handling leaks to read paths | High | Medium | Add `get_audio_clip_selected_path()` helper; audit existing audio-playback code during task-100 |
| Manifest-vs-registry drift (docs-only plugin.yaml) | Low | Medium | Simple consistency test: read `plugin.yaml` from tests, assert operation id matches the registered `PluginHost` entry |
| Keyframe candidates use a different (inline-JSON) model | Low | — | Explicitly out of scope; audio diverges intentionally; keyframe migration is a separate future initiative |

---

**Next Milestone**: TBD (post-MVP plugin improvements, or real plugin loader)
**Blockers**: None
**Notes**: This is the first plugin scenecraft has ever built. Treat it as a reference — future plugins should be able to copy this structure and swap in new contents. If the seams feel awkward during implementation, update `local.audio-isolation-plugin.md` before the next plugin.
