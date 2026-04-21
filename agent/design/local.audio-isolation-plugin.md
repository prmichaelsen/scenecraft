# Audio Isolation Plugin (First-Party MVP)

**Concept**: First scenecraft plugin — an audio-isolation operation that strips background noise from an audio clip and leaves clean voices. Built *like* a plugin (own top-level dir, `plugin.yaml` manifest, narrow seam) but wired directly into the app so we can ship it without the full extension runtime.
**Created**: 2026-04-19
**Status**: Design Specification

---

## Overview

This design defines scenecraft's **first plugin** and, as a side effect, the minimum plugin scaffolding (contribution categories, host API, static registry) needed to support it. The plugin — `isolate-vocals` — is a one-button operation that takes an audio clip, runs the DeepFilterNet3 speech-enhancement model over it, and appends the cleaned audio as a new candidate on the original clip.

Crucially, the plugin is *built as a plugin from day one*: its files live in their own top-level directory (`src/plugins/isolate-vocals/` in each repo), imports route through a narrow `plugin-api` host surface, and the plugin's `plugin.yaml` manifest documents the same declarative shape a future marketplace installer will consume. For MVP the manifest is static documentation and the registry is a hardcoded list — no dynamic loading, no sandboxing, no file-system scanning — but the seams are already in the right place so extracting the plugin into a separate repo later requires zero rewrite of plugin code.

This design also extends the contribution-points model (`local.contribution-points.md`) with two new categories required by this plugin: `operations` and `contextMenus`.

---

## Problem Statement

- **User-level problem.** Users upload audio tracks with ambient noise (wind, HVAC, chatter, white noise) alongside the voice they actually want. Scenecraft has no way to remove it today — the workflow is "go to a different tool, fix it, re-import", which breaks the loop and discards timeline positioning.
- **Plugin-architecture problem.** Scenecraft's plugin system is a design doc with a single placeholder path (M3 Contribution Points Phase 1) but no working plugin. Without one reference implementation, the contribution-point design is unvalidated and the seam between "app code" and "plugin code" has never been drawn in practice.
- **Scope-vs-ship tension.** Building the full extension runtime (dynamic loading, sandboxing, activation events, marketplace install) is weeks of work that blocks any real plugin from shipping. We need a way to deliver the first plugin's value *now* while leaving the right grooves for the runtime to fill in later.

---

## Solution

### Approach

1. **Pick a tight, self-contained first plugin** — audio isolation via DeepFilterNet3 — that exercises the interesting surfaces (operation invocation, context menu, job progress, candidate output) without requiring new infrastructure.
2. **Build the plugin in its own directory with real boundaries** — `src/plugins/isolate-vocals/` in both repos, imports flow through a `plugin-api` module, the plugin never imports app internals directly.
3. **Mock the extension runtime with a static registry** — a 30-line `PluginHost` class on each side, pre-populated with `[isolate_vocals]` at startup. Same shape as a real loader, just no filesystem or sandboxing.
4. **Ship the manifest as documentation, not runtime config** — the `plugin.yaml` describes what the plugin contributes, but the static registry is what the app actually wires up. The manifest becomes load-bearing once the real loader exists.
5. **Mirror the candidate pattern already used for keyframes and transitions** — the operation appends a new candidate to the source entity and auto-selects it. No new-track creation, no timeline reconciliation.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  FRONTEND (scenecraft/src/)                                      │
│  ┌─────────────────┐                                             │
│  │ plugin-host.ts  │ ← static registry: [isolate_vocals]         │
│  └────────┬────────┘                                             │
│           │ reads                                                │
│  ┌────────▼──────────────────┐   ┌─────────────────────────────┐ │
│  │ plugins/isolate-vocals/   │   │  lib/plugin-api.ts          │ │
│  │   plugin.yaml             │   │  (ctxMenu register, REST    │ │
│  │   index.ts  (descriptor)  │◄──┤   client helpers, dialog    │ │
│  │   IsolateVocalsDialog.tsx │   │   host, toast, etc.)        │ │
│  │   isolate-vocals-client.ts│   └─────────────────────────────┘ │
│  └───────────────────────────┘                                   │
│           │ right-click menu wiring                              │
│  ┌────────▼─────────────────────────────────────────────────┐    │
│  │  AudioClipPanel.tsx + timeline audio-clip rendering      │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────┬───────────────────────────────────────────────────────┘
           │ REST + WS
┌──────────▼───────────────────────────────────────────────────────┐
│  BACKEND (scenecraft-engine/src/scenecraft/)                     │
│  ┌─────────────────┐                                             │
│  │ plugin_host.py  │ ← static registry                           │
│  └────────┬────────┘                                             │
│           │ reads                                                │
│  ┌────────▼──────────────────┐   ┌─────────────────────────────┐ │
│  │ plugins/isolate_vocals/   │   │  plugin_api.py              │ │
│  │   plugin.yaml             │   │  (DB helpers, JobManager,   │ │
│  │   __init__.py             │◄──┤   REST register, audio      │ │
│  │   isolate_vocals.py       │   │   extract helper, etc.)     │ │
│  │   model.py (DeepFilterNet)│   └─────────────────────────────┘ │
│  └───────────────────────────┘                                   │
│           │ writes                                               │
│  ┌────────▼─────────────────────────────────────────────────┐    │
│  │  project.db:                                             │    │
│  │    pool_segments (kind='generated', created_by='isolate-vocals')│
│  │    audio_candidates (NEW junction)                       │    │
│  │    audio_clips.selected (NEW column)                     │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### New Contribution Categories

Extends `local.contribution-points.md` with two categories:

**`operations`** — takes an entity (or set of entity types), runs a job, appends candidates.

```yaml
contributes:
  operations:
    - id: isolate-vocals.run
      label: "Isolate vocals"
      entityTypes: [audio_clip, transition]     # one operation can apply to many
      handler: "backend:isolate_vocals.run"      # backend handler reference
      ui: "frontend:isolate_vocals.Dialog"       # optional confirm dialog component
      output: audio_candidate                    # what this operation produces
```

An operation's handler always returns through the candidate pattern (see below). Operations are loosely-coupled to their discovery surfaces — the same operation is addressable by id from context menus, the future command palette, and chat tools.

**`contextMenus`** — appends items to right-click menus on timeline entities, referencing operations by id:

```yaml
contributes:
  contextMenus:
    - entityType: audio_clip
      items:
        - operation: isolate-vocals.run
          label: "Isolate vocals…"
          icon: wave
```

### Candidate Pattern for Audio Clips

Parallels how keyframes (`candidates` JSON array) and transitions (`tr_candidates` junction + `pool_segments`) already work. Audio uses the **transitions-style junction** because:
- Future generated audio (TTS, music gen) needs per-candidate provenance / seed / params — inline JSON can't carry that cleanly
- `pool_segments` is already the "named asset" abstraction in scenecraft; audio segments reuse the same table (provenance carried by `kind` + `created_by`, media type disambiguated by file extension / context)
- The transitions pattern is the newer, fuller model; the keyframe inline pattern predates `pool_segments` and is effectively legacy

### MVP Pipeline

```
┌──────────────┐   ffmpeg   ┌────────────┐   DFN3   ┌────────────┐   ffmpeg   ┌──────────────┐
│ source clip  │─── wav ───▶│  wav_in    │─── → ──▶│  wav_out   │─── mp3 ──▶│ pool_segment │
│ (any codec)  │            │  (PCM 48k) │          │ (denoised) │            │  pool_segment│
└──────────────┘            └────────────┘          └────────────┘            └───────┬──────┘
                                                                                       │
                                                                              ┌────────▼────────┐
                                                                              │ audio_candidates│
                                                                              │   junction row  │
                                                                              └────────┬────────┘
                                                                                       │
                                                                              ┌────────▼────────┐
                                                                              │ audio_clips     │
                                                                              │   .selected ←   │
                                                                              └─────────────────┘
```

---

## Implementation

### Directory Layout

**Backend** (`scenecraft-engine/src/scenecraft/`):
```
plugin_api.py                       # NEW — host API surface for plugins
plugin_host.py                      # NEW — registry (static list for MVP)

plugins/isolate_vocals/
  plugin.yaml                       # manifest (docs only for MVP)
  __init__.py                       # exports activate(api), run_isolate_vocals_job
  isolate_vocals.py                 # kickoff helper (threaded job, JobManager progress)
  model.py                          # DeepFilterNet3 loader + inference (lazy)
  README.md
  tests/test_isolate_vocals.py
```

**Frontend** (`scenecraft/src/`):
```
lib/plugin-api.ts                   # NEW — host API surface for plugins
lib/plugin-host.ts                  # NEW — registry

plugins/isolate-vocals/
  plugin.yaml                       # manifest mirror
  index.ts                          # exports context-menu descriptor + activate()
  IsolateVocalsDialog.tsx           # confirm dialog
  isolate-vocals-client.ts          # REST/WS client helper
```

Directory naming follows each ecosystem's convention: hyphenated for the npm frontend, underscored for Python.

### Schema Additions

```sql
-- pool_segments.kind already exists; accept 'audio' as a new value alongside 'generated'/'imported'

CREATE TABLE IF NOT EXISTS audio_candidates (
    audio_clip_id     TEXT NOT NULL REFERENCES audio_clips(id),
    pool_segment_id   TEXT NOT NULL REFERENCES pool_segments(id),
    added_at          TEXT NOT NULL,
    source            TEXT NOT NULL,          -- 'generated' | 'imported' | 'chat_generation' | 'plugin'
    PRIMARY KEY (audio_clip_id, pool_segment_id)
);
CREATE INDEX IF NOT EXISTS idx_audio_cand_clip ON audio_candidates(audio_clip_id);
CREATE INDEX IF NOT EXISTS idx_audio_cand_seg ON audio_candidates(pool_segment_id);

-- audio_clips gains a selected column (pool_segment_id of current candidate, or NULL for the
-- original source file which is treated as an implicit candidate).
ALTER TABLE audio_clips ADD COLUMN selected TEXT;
```

New db.py helpers (mirroring `tr_candidates` helpers):
- `add_audio_candidate(project_dir, *, audio_clip_id, pool_segment_id, source, added_at=None)`
- `get_audio_candidates(project_dir, audio_clip_id) -> list[pool_segment_dict]`
- `assign_audio_candidate(project_dir, audio_clip_id, pool_segment_id)` — updates `audio_clips.selected`

### Host API Surface

**`plugin_api.py`** (backend):
```python
# Re-exports of stable APIs the plugin may call.
# Intentionally narrow — new additions are intentional contract expansions.

from scenecraft.db import (
    get_audio_clip,
    add_pool_segment,
    add_audio_candidate,
    assign_audio_candidate,
    undo_begin,
)
from scenecraft.ws_server import job_manager  # JobManager singleton
from scenecraft.plugin_host import PluginHost

def extract_audio_as_wav(source_path: Path, out_path: Path, sample_rate: int = 48000) -> Path:
    """ffmpeg helper; deferred support for transition inputs in MVP."""
    ...

def register_rest_endpoint(path_pattern, handler):
    """Route a POST handler on the shared REST server."""
    ...
```

**`lib/plugin-api.ts`** (frontend):
```typescript
// Host APIs available to plugins: WS client, REST helpers, dialog host, toast,
// context-menu registration, etc. Re-exports from existing lib modules.
export { useJobProgress } from './ws-client'
export { postJSON } from './rest-client'
export { showDialog } from './dialog-host'
export { toast } from './toast'
export type { ContextMenuItem, Operation, OperationDescriptor } from './plugin-host'
```

### PluginHost Registry

**Backend** (`plugin_host.py`):
```python
class PluginHost:
    _operations: dict[str, OperationDef] = {}

    @classmethod
    def register(cls, plugin_module):
        plugin_module.activate(plugin_api)  # plugin registers via activate()

    @classmethod
    def get_operation(cls, op_id: str) -> OperationDef | None: ...

# server startup wiring (in api_server.run_server):
from scenecraft.plugins import isolate_vocals
PluginHost.register(isolate_vocals)
```

**Frontend** (`lib/plugin-host.ts`): same pattern — static list of plugin modules imported from `src/plugins/*`, `PluginHost.register()` collects their context-menu descriptors and dialog components at editor-entry time.

### Plugin Handler (Backend)

```python
# plugins/isolate_vocals/isolate_vocals.py

def run(entity_type: str, entity_id: str, context: dict) -> dict:
    """Kick off a DFN3 denoise job. Returns {job_id, audio_clip_id}."""
    if entity_type != "audio_clip":
        # MVP: only audio_clip supported; transition support deferred
        return {"error": "unsupported entity_type for MVP"}

    clip = plugin_api.get_audio_clip(context["project_dir"], entity_id)
    ...
    job_id = plugin_api.job_manager.create_job("isolate_vocals", total=100, ...)

    def _work():
        # 1. ffmpeg: source → wav
        # 2. DFN3 inference (lazy-load model, CPU or GPU)
        # 3. ffmpeg: wav → mp3 (or keep wav)
        # 4. add_pool_segment(kind="generated", created_by="isolate-vocals", ...)
        # 5. add_audio_candidate(audio_clip_id, pool_segment_id, source="plugin")
        # 6. assign_audio_candidate(audio_clip_id, pool_segment_id)  # auto-select
        # 7. complete_job(job_id, result={...})
        ...

    threading.Thread(target=_work, daemon=True).start()
    return {"job_id": job_id, "audio_clip_id": entity_id}
```

### Plugin UI (Frontend)

- `index.ts` exports:
  - A context-menu descriptor: `{ entityType: 'audio_clip', items: [{ operation: 'isolate-vocals.run', label: 'Isolate vocals…' }] }`
  - A confirm-dialog component (`IsolateVocalsDialog`) shown before the job kicks off
  - An `activate(host)` function that calls `host.registerOperation(...)` + `host.registerContextMenu(...)`
- `IsolateVocalsDialog.tsx` shows: model name, estimated time (clip length × 1–2 CPU, ~0.5 GPU), "Run" / "Cancel".
- `isolate-vocals-client.ts` POSTs to the REST endpoint the backend registered, subscribes to `job_*` WS events, pipes progress into a toast + a small spinner on the selected clip.

### Chat Tool Wrapper

```python
ISOLATE_VOCALS_TOOL = {
    "name": "isolate_vocals",
    "description": (
        "Strip background noise from an audio_clip, leaving clean voices. "
        "Appends a new audio candidate and auto-selects it. Slow (~realtime on CPU). "
        "Requires user confirmation."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "entity_type": {"type": "string", "enum": ["audio_clip"]},  # transition deferred
            "entity_id":   {"type": "string"},
        },
        "required": ["entity_type", "entity_id"],
    },
}
```

Add `"isolate_"` to `_DESTRUCTIVE_TOOL_PATTERNS` in `chat.py` so the elicitation gate fires (consistency with `generate_*`, `restore_checkpoint`, `delete_*`).

---

## Benefits

- **Validates the plugin seams.** First real plugin exercises `plugin.yaml`, `plugin-api`, `PluginHost`, `operations` category, `contextMenus` category, and the candidate pattern all at once.
- **User value now, architecture value later.** Users get one-click noise removal; the runtime we didn't build yet has a working reference implementation to slot into when ready.
- **Extractable.** When the real loader ships, the plugin's filesystem dir, its `plugin.yaml`, its `activate()` export, and its API calls are already in the right shape — no refactor of plugin code.
- **Low-cost model.** DeepFilterNet3 is ~2.3 MB, MIT-licensed, CPU-realtime, and lazy-downloaded. No billing, no hosting, no GPU requirement.
- **Candidate pattern consistency.** Audio follows the same "add candidate + auto-select" pattern as generated keyframes/transitions. Users build a single mental model; future generated-audio features (TTS, music) slot into the same surface.

---

## Trade-offs

- **Manifest is documentation, not runtime config (MVP).** `plugin.yaml` isn't parsed; if it gets out of sync with `activate()` and `PluginHost` wiring, nothing breaks but the docs become misleading. Mitigation: when the real loader ships, it'll catch drift automatically; until then, add a simple yaml-vs-registry consistency test.
- **Seam is informal.** Plugin *could* still import app internals directly (`from scenecraft.db import add_pool_segment`). Mitigation: `plugin-api` re-exports the allowed surface; lint rule (`no-app-internals-from-plugins`) can come later when the surface is stable.
- **Schema change is load-bearing.** Adding `audio_candidates` + `audio_clips.selected` means existing audio clips will initially have `selected=NULL`; all read paths must treat NULL as "use the clip's native source file". Mitigation: handle NULL explicitly in `get_audio_clip_selected_path()` helper; document the convention.
- **Legacy inline-candidate pattern on keyframes isn't converged.** Keyframes still use `candidates TEXT` JSON column rather than a junction. Audio diverges from keyframes on purpose (pool_segments are a better fit). Mitigation: migrating keyframes to a junction is a separate, bigger initiative; out of scope here.
- **Transition audio deferred.** Extracting a transition's audio via ffmpeg is straightforward but introduces file-management wrinkles (temp wav, cleanup, cache). Deferring simplifies the MVP; the manifest's `entityTypes: [audio_clip, transition]` stays in place as a forward compatibility signal.
- **Failure mode is toast-only.** A failed job produces no DB trace. If users want to know why later, they need to replay from logs. Mitigation: acceptable for v1; if complaints appear, add an activity-log panel later.

---

## Dependencies

- **Runtime:** Python 3.10+, DeepFilterNet3 (pip: `deepfilternet`, lazy-loaded), ffmpeg (system binary, already used elsewhere in scenecraft-engine)
- **Frontend:** No new deps; reuses existing dialog/toast/WS client code
- **Backend internal:** existing `JobManager`, `undo_begin`, `pool_segments` helpers; new `audio_candidates` junction + helpers
- **Design:** extends `local.contribution-points.md` (treat that doc as also updated by this design; the two new categories here supersede anything inconsistent there)
- **Related:** M9 (audio tracks & clips) for the underlying `audio_clips` / `audio_tracks` tables; M3 task-10 for the frontend placeholder plugin API

---

## Testing Strategy

- **Unit (backend):**
  - `plugin_host.py` register/get_operation round-trip
  - `plugin_api.py` re-exports are stable
  - `add_audio_candidate` / `get_audio_candidates` / `assign_audio_candidate` DB helpers
  - `isolate_vocals.run` kickoff returns `{job_id, audio_clip_id}` and spawns a worker thread
  - Mock DFN3 client for deterministic fast tests (same pattern we used for `chat_generation.py` tests)
- **Unit (frontend):**
  - `PluginHost.register` collects descriptors
  - Context-menu descriptor renders "Isolate vocals…" for `entityType=audio_clip`
  - Dialog invokes the REST client and wires job progress to a toast
- **Integration:**
  - End-to-end fixture: insert an audio_clip with a known source file, invoke `isolate_vocals.run`, assert a new `pool_segment` (kind=audio) + `audio_candidate` row, and `audio_clips.selected` is updated
  - Chat tool path: `isolate_vocals` tool fires the elicitation; decline leaves state unchanged; accept runs the job and the assistant message includes the new `pool_segment_id`
- **E2E:**
  - Right-click audio_clip → "Isolate vocals…" → confirm dialog → progress toast → new candidate visible in the audio clip panel, selected indicator flipped to the new candidate

---

## Migration Path

1. **Schema** — add `audio_candidates` table + `audio_clips.selected` column via `_ensure_schema` migration. Existing rows get `selected=NULL` (read as "use original source").
2. **Host scaffolding** — add `plugin_api.py`, `plugin_host.py` (backend), `lib/plugin-api.ts`, `lib/plugin-host.ts` (frontend). Empty `PluginHost` at this step; no plugin registered yet.
3. **Backend plugin** — create `plugins/isolate_vocals/` with DFN3 handler; register in `PluginHost` at server startup. Add `/api/projects/:name/plugins/isolate-vocals/run` REST endpoint (via `plugin_api.register_rest_endpoint`).
4. **Frontend plugin** — create `plugins/isolate-vocals/`; register in `PluginHost` at editor entry. Wire the context-menu descriptor into `AudioClipPanel` / timeline audio-clip rendering.
5. **Chat tool** — add `isolate_vocals` tool to `chat.py`, including the `"isolate_"` destructive pattern entry.
6. **Tests** — unit, integration, E2E per above.

No data migration: existing projects gain the new schema with empty candidate lists; no behavior change until a user invokes the operation.

---

## Key Design Decisions

### Scope & Framing

| Decision | Choice | Rationale |
|---|---|---|
| Framing of audio isolation | Operation, not effect | Produces a new audio asset; runs once, as a job. Effects are per-frame, continuous, composable. |
| Multi-speaker split | Explicitly out of scope for MVP | Requires new tracks → timeline reconciliation. User chose single-track voices first. |
| First plugin vs extension runtime | Ship plugin now, mock runtime | Building dynamic-loader/sandbox/marketplace blocks every plugin. Static registry + narrow seams delivers user value and validates the design at once. |
| Plugin manifest role (MVP) | Documentation only | Not parsed at runtime; `activate()` + `PluginHost` is what actually wires up. Manifest becomes load-bearing when the loader exists. |

### Plugin Architecture

| Decision | Choice | Rationale |
|---|---|---|
| New contribution categories | `operations` + `contextMenus` | Operations subsume the "run a job, produce an output" pattern. `contextMenus` loose-couples discovery from execution. |
| Operation entityTypes | Array, not single | One operation can apply to multiple entity kinds (audio_clip + transition). Forward-compatibility signal even when MVP only implements one. |
| Context-menu → operation coupling | Reference by id | Same operation is addressable from menu, chat tool, command palette — no duplication. |
| Manifest filename | `plugin.yaml` | Not `package.yaml` — avoids conflict with npm's `package.json` and Python's `pyproject.toml`. Visually distinguishes plugin config from language package config. |
| Plugin-↔-host seam | `plugin-api` re-export module + informal rule | Plugin calls into `plugin-api.py` / `lib/plugin-api.ts`; app code imports *from* the plugin (context menu descriptors). App-internals imports discouraged but allowed for MVP; lint rule later. |
| Host scaffolding now or later | Now | `plugin-api.py/ts` + `plugin-host.py/ts` exist from day one even with one consumer. Having the target shape established makes the next plugin trivial. |
| Plugin directory naming | Hyphen (frontend), underscore (backend) | Matches each ecosystem's convention; e.g. npm packages are `isolate-vocals`, Python modules are `isolate_vocals`. |

### Candidate Model

| Decision | Choice | Rationale |
|---|---|---|
| Output shape | New candidate on the same entity, auto-selected | Matches keyframe/transition patterns. No new track, no timeline reconciliation, no track-layout rules. |
| Audio candidate storage | Junction table (`audio_candidates`) + `pool_segments` | Transitions pattern, not the keyframe inline-JSON pattern. Future generated audio needs per-candidate provenance/seed/params. |
| Audio segments share `pool_segments` | Reuse existing table; provenance via `kind`+`created_by`, media type by extension | `kind` is provenance ('generated'/'imported'), NOT media type — don't confuse the two. Existing check constraint limits `kind` to those two values. |
| `audio_clips.selected` semantics | NULL = use original source; else pool_segment_id | Existing audio_clips migrate cleanly; candidates are purely additive. |
| Re-run behavior | Append new candidate, auto-select latest | Previous candidates stay for A/B. Same as generate_* tools. |

### UX & Integration

| Decision | Choice | Rationale |
|---|---|---|
| Confirm dialog | Required | Operation takes seconds-to-minutes; consistency with the "any tool that mutates state and takes >10s asks once" pattern. |
| Audio clip panel | New dedicated panel analogous to KeyframePanel/TransitionPanel | Shows candidate list + selected indicator + per-candidate mini-waveform. |
| Visual feedback on candidate swap | Not for MVP | Panel-level selection UI is enough; timeline flash/highlight can be added later if users get confused. |
| Error handling | Toast-only, no DB trace | Matches chat tool error behavior. Simpler; persistent activity log can come later if needed. |
| Chat tool elicitation | Gated via `"isolate_"` in `_DESTRUCTIVE_TOOL_PATTERNS` | Same pattern as `generate_*`, `restore_checkpoint`, `delete_*`. |
| Chat tool input for transitions | Not in MVP | `entity_type` enum restricted to `["audio_clip"]`; manifest still says `[audio_clip, transition]` for forward compat. |

### Model & Pipeline

| Decision | Choice | Rationale |
|---|---|---|
| Model | DeepFilterNet3 | MIT, ~2.3 MB, CPU-realtime, exact target ("keep speech, kill non-speech") — matches the use case described. |
| Weight distribution | Lazy-download via `pip install deepfilternet` | Avoids hosting weights ourselves; matches the Python ecosystem. |
| Pipeline | Single step: `denoise(wav_in) → wav_out` | No stem separation, no diarization, no speaker labels. |
| Input/output encoding | WAV in processing; ffmpeg transcode at the edges; re-encode output to project's common codec | Simplifies DFN3 input; ffmpeg handles everything else. |

---

## Future Considerations

- **Per-speaker split.** Once timeline-layout rules for multi-track operations are sorted, layer pyannote 3.1 diarization + ffmpeg segment extraction onto this same plugin. Output becomes N `audio_candidate` rows, each tagged with a speaker id. Still no new tracks unless explicitly requested.
- **"Remove music" toggle.** Swap in Demucs v4 when the source is music-heavy rather than ambient-noisy. Plugin gains a mode parameter.
- **Real plugin loader / marketplace.** Replace the static `PluginHost` with a dynamic loader that scans `node_modules/@scenecraft-plugins/*` and `~/.scenecraft/plugins/*`, reads `plugin.yaml`, validates capabilities against a declared schema, and calls `activate()` in a permission-scoped context. Plugin code from this MVP loads unchanged.
- **Lint rule: plugins can't import app internals.** Once `plugin-api` is stable, prohibit `from scenecraft.db import *` in `src/plugins/**` — force all cross-boundary calls through `plugin-api`.
- **Keyframe candidate migration.** Move keyframes from inline-JSON candidates to the pool_segments + junction pattern, converging with transitions and audio. Big lift; not needed for this plugin.
- **Batch mode.** Right-click multiple audio_clips → "Isolate vocals on all". Naturally falls out of the job manager; UI work only.
- **Activity log panel.** Persistent record of plugin invocations + results + failures. Useful when plugins proliferate.
- **Plugin-scoped settings.** Today, plugin configuration lives in handler args. A future settings surface (`contributes.settings` category) would give plugins a config UI.

---

**Status**: Design Specification
**Recommendation**: Plan a milestone + tasks to implement this design; suggested milestone scope: schema migration → host scaffolding → backend plugin → frontend plugin → chat tool → tests.
**Related Documents**:
- [Clarification 8: Audio Isolation Plugin](../clarifications/clarification-8-audio-isolation-plugin.md)
- [Contribution Points (existing)](local.contribution-points.md) — this design adds two new categories
- [Audio Tracks and Clips](local.audio-tracks-and-clips.md) — underlying data model for `audio_clips`
- [Milestone 3: Contribution Points](../milestones/) — plugin framework parent milestone (this MVP is a deliberate side-track until M3 completes its runtime pieces)
