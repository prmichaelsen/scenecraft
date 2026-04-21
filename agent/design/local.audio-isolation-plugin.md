# Audio Isolation Plugin (First-Party MVP)

**Concept**: First scenecraft plugin — an audio-isolation operation that emits multiple stems (vocal + background) from a selected audio source, browsable and draggable from a dedicated panel. Built *like* a plugin (own top-level dir, `plugin.yaml` manifest, narrow seam) but wired directly into the app so we can ship it without the full extension runtime.
**Created**: 2026-04-19
**Revised**: 2026-04-21 (v2: multi-stem outputs, range input, Audio Isolations panel)
**Status**: Design Specification

---

## Overview

This design defines scenecraft's first real plugin — `isolate-vocals` — and the minimum plugin scaffolding (contribution categories, host API, static registry) needed to host it. The plugin takes an audio source (an `audio_clip` or a video `transition`'s extracted audio), runs DeepFilterNet3 speech enhancement over the requested range (full source or a subset window), and emits two stems — `vocal` (DFN3 output) and `background` (source minus vocal) — as independent `pool_segments`. A new **Audio Isolations** panel shows all runs for the selected entity and lets the user drag any stem onto the timeline to create an audio_clip.

The plugin is built *as a plugin from day one*: its files live in their own top-level directory (`src/plugins/isolate-vocals/` in each repo), imports route through a narrow `plugin-api` host surface, and the `plugin.yaml` manifest documents exactly the declarative shape a future marketplace installer will consume. For MVP the manifest is static documentation and the registry is a hardcoded list — no dynamic loading, no sandboxing — but the seams are already in the right place, so extracting the plugin later requires zero rewrite of plugin code.

This design supersedes the v1 design (single-output, candidate-auto-select). Per clarification-9, stems are independent pool_segments browsable in a panel rather than candidates that auto-attach to the source clip. The candidate pattern from clarification-8 / task-100 stays in the DB for future generated-audio features (TTS, music generation) but is NOT used by the isolate-vocals operation.

---

## Problem Statement

- **User-level problem.** Users record audio (stand-up comedy, interviews, live events) where the target voice shares the acoustic environment with ambient noise: crowd chatter, HVAC, wind, applause. Cleaning it up is a full external-tool workflow today — export, take to a DAW or online service, re-import. Timeline position is lost; iteration is slow.
- **Secondary need: creative flexibility.** A single denoise pass isn't always the right answer. Sometimes the user wants the *background* track (to layer under a voiceover, or mute it during dialogue and unmute it for ambience). Producing both stems from one run makes the background usable instead of discarded.
- **Plugin-architecture problem.** scenecraft's plugin system is a design doc with a single placeholder path (M3 Contribution Points Phase 1) but no working plugin. Without a reference implementation, the contribution-point design is unvalidated and the seam between "app code" and "plugin code" has never been drawn in practice.
- **Scope-vs-ship tension.** Building the full extension runtime (dynamic loading, sandboxing, activation events, marketplace install) is weeks of work that blocks any plugin from shipping. We need to deliver the first plugin's value *now* while leaving the right grooves for the runtime to fill in later.

---

## Solution

### Approach

1. **Pick a tight, high-value first plugin** — audio isolation via DeepFilterNet3 — that exercises the interesting surfaces (operation invocation, panel-as-entry-point, job progress, multi-stem output, drag-to-timeline) without requiring new ML infrastructure beyond DFN3.
2. **Build the plugin in its own directory with real boundaries** — `src/plugins/isolate-vocals/` in both repos, imports flow through a `plugin-api` module, the plugin never imports app internals directly.
3. **Mock the extension runtime with a static registry** — a ~30-line `PluginHost` class on each side, pre-populated with `[isolate_vocals]` at startup. Same shape as a real loader, just no filesystem scanning or sandboxing.
4. **Ship the manifest as documentation, not runtime config** — `plugin.yaml` describes what the plugin contributes, but the static registry is what the app actually wires up. Manifest becomes load-bearing once the loader exists.
5. **Emit multiple stems per run, grouped by an `audio_isolations` record** — stems are independent pool_segments. The Audio Isolations panel is the primary UX — it lists past runs for the selected entity, shows each stem with a waveform, and acts as the kickoff point for new runs.
6. **Deliver both stems with a single model** — DFN3 outputs one clean-speech stream (`vocal`). `background = source − vocal` is a simple time-domain subtraction, giving users a real residual channel without requiring a separate source-separation model.

### Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  FRONTEND (scenecraft/src/)                                          │
│  ┌─────────────────┐                                                 │
│  │ plugin-host.ts  │ ← static registry: [isolate_vocals]             │
│  └────────┬────────┘                                                 │
│           │ reads                                                    │
│  ┌────────▼──────────────────┐   ┌─────────────────────────────────┐ │
│  │ plugins/isolate-vocals/   │   │  lib/plugin-api.ts              │ │
│  │   plugin.yaml             │   │  (registration helpers, WS job  │ │
│  │   index.ts  (descriptor)  │◄──┤   client, dialog host, toast,   │ │
│  │   IsolateVocalsRunForm    │   │   drag-payload helper, etc.)    │ │
│  │   AudioIsolationsPanel    │   └─────────────────────────────────┘ │
│  └───────────────────────────┘                                       │
│           │ registers                                                │
│  ┌────────▼─────────────────────────────────────────────────────┐    │
│  │  AudioIsolationsPanel (dockview panel)                       │    │
│  │   ├── context reads selected audio_clip / transition         │    │
│  │   ├── inline Run form: range toggle + model + Run button     │    │
│  │   └── run list → per-run stem rows → drag onto timeline      │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────┬───────────────────────────────────────────────────────────┘
           │ REST + WS
┌──────────▼───────────────────────────────────────────────────────────┐
│  BACKEND (scenecraft-engine/src/scenecraft/)                         │
│  ┌─────────────────┐                                                 │
│  │ plugin_host.py  │ ← static registry                               │
│  └────────┬────────┘                                                 │
│           │ reads                                                    │
│  ┌────────▼──────────────────┐   ┌─────────────────────────────────┐ │
│  │ plugins/isolate_vocals/   │   │  plugin_api.py                  │ │
│  │   plugin.yaml             │   │  (DB helpers, JobManager,       │ │
│  │   __init__.py             │◄──┤   REST register, audio extract  │ │
│  │   isolate_vocals.py       │   │   helper, etc.)                 │ │
│  │   model.py (DFN3)         │   └─────────────────────────────────┘ │
│  └───────────────────────────┘                                       │
│           │ writes                                                   │
│  ┌────────▼──────────────────────────────────────────────────┐       │
│  │  project.db:                                              │       │
│  │    audio_isolations      (run metadata — one row per run) │       │
│  │    isolation_stems       (junction: run × pool_segment)   │       │
│  │    pool_segments         (each stem is an audio segment)  │       │
│  └───────────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────────┘
```

### Contribution Categories (reminder from clarification-8)

Extends `local.contribution-points.md` with two categories:

**`operations`** — takes an entity (or set of entity types), runs a job, produces output.
**`contextMenus`** — appends items to right-click menus, referencing operations by id.

Both stay as specified; the isolate-vocals plugin's manifest uses them as-is.

### Run & Stem Model

Every invocation of the operation creates one `audio_isolations` row. That row fans out to N stems via the `isolation_stems` junction:

```sql
CREATE TABLE audio_isolations (
    id TEXT PRIMARY KEY,              -- UUID
    entity_type TEXT NOT NULL,        -- 'audio_clip' | 'transition'
    entity_id TEXT NOT NULL,
    model TEXT NOT NULL,              -- 'deepfilternet3' for MVP
    range_mode TEXT NOT NULL,         -- 'full' | 'subset'
    trim_in REAL,                     -- seconds into source; NULL for full
    trim_out REAL,
    status TEXT NOT NULL,             -- 'running' | 'completed' | 'failed'
    error TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE isolation_stems (
    isolation_id TEXT NOT NULL REFERENCES audio_isolations(id),
    pool_segment_id TEXT NOT NULL REFERENCES pool_segments(id),
    stem_type TEXT NOT NULL,          -- 'vocal' | 'background' | ...
    PRIMARY KEY (isolation_id, pool_segment_id)
);

CREATE INDEX idx_isolations_entity ON audio_isolations(entity_type, entity_id);
CREATE INDEX idx_isolation_stems_run ON isolation_stems(isolation_id);
CREATE INDEX idx_isolation_stems_segment ON isolation_stems(pool_segment_id);
```

Notes:
- `stem_type` lives on the junction (not on `pool_segments`). A single pool_segment could appear in multiple runs in the future (cache reuse) — the junction allows it.
- `pool_segments.kind='generated'`, `created_by='isolate-vocals'` for every stem. No new `kind` value. Media type derives from extension via `_classify_media_type` (already landed).
- Stems do NOT write to `audio_candidates` / `audio_clips.selected` — those stay for future generated-audio features. The source entity is unchanged by a run.

### Stem Ontology

Canonical labels, aligned with `~/bytv.md`'s pipeline:

**MVP:**
- `vocal` — isolated speech
- `background` — everything else on the source (= `source − vocal` residual)

**Forward-compat (stored but not produced by the MVP operation; valid for future operations):**
- From MDX23C-DrumSep: `kick`, `snare`, `toms`, `hh`, `ride`, `crash`
- From Demucs htdemucs_6s: `bass`, `guitar`, `piano`, `other`

Free-form strings are accepted with soft validation (warn on unknown, don't reject).

### Model Pipeline

```
┌──────────────┐   ffmpeg    ┌──────────────┐
│  source      │────wav────▶│  wav_in      │
│  (mp4/wav)   │             │  (PCM 48k)   │
└──────────────┘             └───────┬──────┘
                                     │
                           DFN3 denoise
                                     │
                        ┌────────────┴────────────┐
                        ▼                         ▼
                ┌──────────────┐           ┌──────────────┐
                │  wav_vocal   │           │ wav_in  −    │
                │  (DFN3 out)  │           │ wav_vocal    │
                └──────┬───────┘           └──────┬───────┘
                       │                          │
                       ▼                          ▼
              pool_segment            pool_segment
              + isolation_stem        + isolation_stem
              (stem_type='vocal')     (stem_type='background')
```

For `subset` range: pre-slice the source via ffmpeg's `-ss / -t` before decoding. Stems have duration = (trim_out − trim_in). For `full` range: process the entire source; stems have duration = source_duration.

Sample rate preserved from the source; no resampling beyond what DFN3 applies internally (DFN3 works at 48kHz).

### UX: AudioIsolationsPanel

A new dockview panel. Always context-sensitive to the selected `audio_clip` / `transition`. Replaces the role v1 had for `AudioClipPanel` (v1 plan deferred until generated-audio ships).

**Layout:**

```
┌─ Audio Isolations ─────────────────────────────────────────────┐
│ ▾ Source: Vocals Show 1 (audio_clip_07463755) · 2h 36m         │
│                                                                 │
│  Range:  ( ) Full     (●) Subset (0:00 – 2h 36m)               │
│  Model:  DeepFilterNet3                                         │
│  ETA:    ~5m on CPU                                             │
│  [ Run ]                                                        │
│                                                                 │
│ ─── Runs ──────────────────────────────────────────────────────│
│                                                                 │
│  ┌ 2026-04-21 14:32 · DFN3 · subset ─────────── ✓ completed ─┐ │
│  │  ▶ vocal       ▂▃▅▆▃▂ …  0:00–2:36     [drag]            │ │
│  │  ▶ background  ▁▂▂▁▁▂ …  0:00–2:36     [drag]            │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌ 2026-04-21 13:05 · DFN3 · full ──────────── ✗ failed ────┐ │
│  │  error: ffmpeg decode failed: …           [retry]        │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

**Empty states:**
- Nothing selected: "Select an audio clip or transition in the timeline to isolate audio."
- Selected but no runs yet: shows the inline Run form + "No isolations yet — click Run to start."

**Stem row interactions:**
- Waveform — mini canvas fed by `GET /api/projects/:name/pool/:seg_id/peaks?resolution=N` (new route, see below).
- Label — "vocal" / "background" colored by stem_type.
- Duration + range annotation — e.g. "0:00–2:36 of source".
- ▶ play — native `<audio>` element with range-request streaming from `/files/{pool_path}`.
- drag — native HTML5 drag; sets the drag payload `application/x-scenecraft-stem` with `pool_segment_id` + `stem_type`.
- No explicit delete/hide in MVP — rely on existing pool GC flow.

**Run invocation:**
- No confirm modal in the UI — the panel's inline Run button kicks the job off immediately.
- Chat tool (`isolate_vocals`) KEEPS the elicitation pattern (chat actions lack the visual context a panel Run click has).

### Drag Stem → Timeline

Dropping a stem onto the timeline creates a new `audio_clip`. The rules, per clarification-9:

- **Empty audio lane** → creates a new `audio_track` + `audio_clip` starting at cursor X.
- **Existing audio track, no overlap** → inserts `audio_clip` at cursor X.
- **Existing audio track, overlap** → **overwrite-with-split** (DaVinci Resolve "overwrite" mode):
  - Dropped fully covers existing → soft-delete existing.
  - Dropped covers existing's LEFT edge → trim existing's `start_time` forward to dropped's `end_time`.
  - Dropped covers existing's RIGHT edge → trim existing's `end_time` back to dropped's `start_time`.
  - Dropped fits INSIDE existing → split existing into left + right halves, delete the middle slice, insert the dropped clip.
- **Drop on a transition's audio region** → deferred (P2). Stems become audio_clips only for MVP.

New `audio_clip` fields on a fresh drop:
```
source_path  = stem.pool_path                 (direct pool_segment file)
start_time   = cursor_x_in_seconds
end_time     = start_time + stem.duration_seconds
source_offset= 0
volume_curve = project default (unmuted)
name         = f"{source.label} · {stem_type}"   # e.g. "Vocals Show 1 · vocal"
```

Model name is intentionally NOT in the auto-generated clip name — model metadata stays visible in the run-card, which keeps clip names short.

### HTTP Routes

**New (this design):**
- `GET /api/projects/:name/pool/:seg_id/peaks?resolution=N` — returns the same float16 peaks format as `/audio-clips/:id/peaks`. Thin shim over the existing `compute_peaks(Path, offset=0, duration=pool_segment.duration_seconds, resolution)` helper. Used by AudioIsolationsPanel for stem waveforms and by any future "show peaks for a raw pool_segment" consumer.
- `POST /api/projects/:name/plugins/isolate-vocals/run` — kick off an isolation. Body: `{ entity_type, entity_id, range_mode, trim_in?, trim_out? }`. Returns `{ isolation_id, job_id }`. Registered via `plugin_api.register_rest_endpoint`.
- `GET /api/projects/:name/audio-isolations?entityType=...&entityId=...` — list runs for an entity (for populating the panel). Returns `{ isolations: [{id, status, model, range_mode, trim_in, trim_out, created_at, stems: [{pool_segment_id, stem_type, duration_seconds, pool_path}]}] }`.

**Unchanged:**
- `GET /api/projects/:name/files/{path}` — range-request streaming of any pool file (used by stem ▶ playback and drag-source-path inference).
- `GET /api/projects/:name/audio-clips/:id/peaks` — still the primary peaks route for timeline audio_clip rendering.

---

## Implementation

### Directory Layout

**Backend** (`scenecraft-engine/src/scenecraft/`):
```
plugin_api.py                       # host API surface (landed in task 101)
plugin_host.py                      # static PluginHost registry (landed in task 101)

plugins/isolate_vocals/
  plugin.yaml                       # manifest (docs-only for MVP)
  __init__.py                       # exports activate(api) + run
  isolate_vocals.py                 # kickoff + job worker
  model.py                          # DFN3 loader + inference (lazy)
  README.md
  tests/test_isolate_vocals.py
```

**Frontend** (`scenecraft/src/`):
```
lib/plugin-api.ts                   # host API surface (landed in task 101)
lib/plugin-host.ts                  # registry (landed in task 101)

plugins/isolate-vocals/
  plugin.yaml                       # manifest mirror
  index.ts                          # activate(host) + IsolateVocalsRunForm + panel descriptor
  IsolateVocalsRunForm.tsx          # inline Run form (range toggle + ETA + Run button)
  AudioIsolationsPanel.tsx          # the panel component
  isolate-vocals-client.ts          # REST helpers + WS job subscription

components/editor/
  AudioLane.tsx (modified)          # accept drag payload `application/x-scenecraft-stem`
                                    #   + overwrite-with-split logic on drop
```

### Schema Additions (new)

Applied via idempotent migrations in `db.py::_ensure_schema`:

```sql
CREATE TABLE IF NOT EXISTS audio_isolations (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    model TEXT NOT NULL,
    range_mode TEXT NOT NULL,
    trim_in REAL,
    trim_out REAL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_isolations_entity
    ON audio_isolations(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS isolation_stems (
    isolation_id TEXT NOT NULL REFERENCES audio_isolations(id),
    pool_segment_id TEXT NOT NULL REFERENCES pool_segments(id),
    stem_type TEXT NOT NULL,
    PRIMARY KEY (isolation_id, pool_segment_id)
);
CREATE INDEX IF NOT EXISTS idx_isolation_stems_run
    ON isolation_stems(isolation_id);
CREATE INDEX IF NOT EXISTS idx_isolation_stems_segment
    ON isolation_stems(pool_segment_id);
```

No changes to `pool_segments` (stem-specific metadata lives on the junction). The `audio_candidates` table from task-100 remains (for future generated-audio) but is NOT written by this operation.

New db.py helpers:
- `add_audio_isolation(project_dir, *, entity_type, entity_id, model, range_mode, trim_in, trim_out) -> isolation_id`
- `update_audio_isolation_status(project_dir, isolation_id, status, error=None)`
- `add_isolation_stem(project_dir, isolation_id, pool_segment_id, stem_type)`
- `get_isolations_for_entity(project_dir, entity_type, entity_id) -> list[dict]` — joined with stems
- `get_isolation_stems(project_dir, isolation_id) -> list[dict]`

### Plugin Manifest

`plugins/isolate_vocals/plugin.yaml`:

```yaml
name: isolate-vocals
version: 0.2.0
displayName: "Isolate Vocals"
description: "Separate a voice-over-noise audio source into vocal and background stems using DeepFilterNet3."
publisher: scenecraft
license: MIT

activationEvents:
  - onCommand:isolate-vocals.run
  - onContextMenu:audio_clip
  - onContextMenu:transition

contributes:
  operations:
    - id: isolate-vocals.run
      label: "Isolate vocals"
      entityTypes: [audio_clip, transition]
      handler: "backend:isolate_vocals.run"
      panel: "frontend:isolate_vocals.AudioIsolationsPanel"   # inline run form lives inside
      outputs:
        - kind: pool_segment
          stem_type_enum: [vocal, background]

  contextMenus:
    - entityType: audio_clip
      items:
        - operation: isolate-vocals.run
          label: "Isolate vocals…"
          icon: wave
          reveals: panel:audio-isolations           # opens the panel focused on this source
    - entityType: transition
      items:
        - operation: isolate-vocals.run
          label: "Isolate vocals from audio track…"
          icon: wave
          reveals: panel:audio-isolations
```

### Backend Handler Sketch

```python
# plugins/isolate_vocals/isolate_vocals.py

def run(entity_type: str, entity_id: str, context: dict) -> dict:
    """Kick off an isolation job. Returns {isolation_id, job_id} or {error}.

    context keys:
      - project_dir (Path)
      - project_name (str)
      - range_mode: 'full' | 'subset'
      - trim_in / trim_out: seconds (None for 'full')
    """
    if entity_type not in ("audio_clip", "transition"):
        return {"error": f"unsupported entity_type: {entity_type}"}

    range_mode = context.get("range_mode", "subset")
    trim_in = context.get("trim_in")
    trim_out = context.get("trim_out")

    source_path = _resolve_source_path(context["project_dir"], entity_type, entity_id)
    if not source_path or not source_path.exists():
        return {"error": "source audio not found"}

    isolation_id = plugin_api.add_audio_isolation(
        context["project_dir"],
        entity_type=entity_type, entity_id=entity_id,
        model="deepfilternet3",
        range_mode=range_mode, trim_in=trim_in, trim_out=trim_out,
    )
    job_id = plugin_api.job_manager.create_job("isolate_vocals", total=100, meta={
        "isolationId": isolation_id, "entityType": entity_type, "entityId": entity_id,
    })

    def _work():
        from .model import denoise_wav
        try:
            # 1. ffmpeg: slice + decode source to wav_in
            wav_in = _extract_source_wav(source_path, range_mode, trim_in, trim_out)
            plugin_api.job_manager.update_progress(job_id, 20, "denoising")

            # 2. DFN3: wav_in → wav_vocal (speech-enhanced)
            wav_vocal = denoise_wav(wav_in)
            plugin_api.job_manager.update_progress(job_id, 70, "computing residual")

            # 3. Residual: wav_background = wav_in − wav_vocal (time-domain subtraction via numpy)
            wav_bg = _subtract_audio(wav_in, wav_vocal)
            plugin_api.job_manager.update_progress(job_id, 85, "saving")

            # 4. Register each stem as a pool_segment + isolation_stems junction row
            vocal_seg_id = _save_stem(wav_vocal, stem_type="vocal", context=context)
            bg_seg_id = _save_stem(wav_bg, stem_type="background", context=context)

            plugin_api.add_isolation_stem(context["project_dir"], isolation_id, vocal_seg_id, "vocal")
            plugin_api.add_isolation_stem(context["project_dir"], isolation_id, bg_seg_id, "background")

            plugin_api.update_audio_isolation_status(
                context["project_dir"], isolation_id, "completed"
            )
            plugin_api.job_manager.complete_job(job_id, {
                "isolation_id": isolation_id,
                "stems": [
                    {"stem_type": "vocal", "pool_segment_id": vocal_seg_id},
                    {"stem_type": "background", "pool_segment_id": bg_seg_id},
                ],
            })
        except Exception as e:
            plugin_api.update_audio_isolation_status(
                context["project_dir"], isolation_id, "failed", error=str(e)
            )
            plugin_api.job_manager.fail_job(job_id, str(e))

    threading.Thread(target=_work, daemon=True).start()
    return {"isolation_id": isolation_id, "job_id": job_id}
```

Source resolution (`_resolve_source_path`):
- For `audio_clip`: use `get_audio_clip_effective_path` (task-100 helper) — resolves the clip's selected pool_segment or falls back to `source_path`.
- For `transition`: extract the selected video candidate's audio via ffmpeg to a staged wav in `audio_staging/`. Same approach as task-56 scoped.

### Peaks Endpoint

`GET /api/projects/:name/pool/:seg_id/peaks?resolution=N`:

```python
def _handle_pool_peaks(self, project_name: str, seg_id: str):
    project_dir = work_dir / project_name
    seg = get_pool_segment(project_dir, seg_id)
    if not seg:
        return self._error(404, "NOT_FOUND", f"pool segment not found: {seg_id}")
    pool_path = project_dir / seg["poolPath"]
    if not pool_path.exists():
        return self._error(404, "NOT_FOUND", "file missing on disk")
    resolution = int(self._qs_get("resolution", "400"))

    from scenecraft.audio.peaks import compute_peaks
    data = compute_peaks(
        pool_path,
        source_offset=0,
        duration=seg.get("durationSeconds") or 0,
        resolution=resolution,
        project_dir=project_dir,
    )
    self.send_response(200)
    self.send_header("Content-Type", "application/octet-stream")
    self.send_header("X-Peak-Resolution", str(resolution))
    self.send_header("X-Peak-Duration", f"{seg.get('durationSeconds') or 0:.6f}")
    self._cors_headers()
    self.end_headers()
    self.wfile.write(data)
```

`compute_peaks` was hardened against long-source OOM in a prior fix (streaming bucket decode). This endpoint benefits from the same hardening.

### Chat Tool Wrapper

```python
ISOLATE_VOCALS_TOOL = {
    "name": "isolate_vocals",
    "description": (
        "Separate a voice-over-noise audio source into vocal + background stems "
        "using DeepFilterNet3. Works on an audio_clip or a transition. Returns a "
        "new audio_isolations run id with stem pool_segment ids. Slow (~realtime "
        "on CPU). Requires user confirmation."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "entity_type": {"type": "string", "enum": ["audio_clip", "transition"]},
            "entity_id":   {"type": "string"},
            "range_mode":  {"type": "string", "enum": ["full", "subset"], "default": "subset"},
            "trim_in":     {"type": "number"},
            "trim_out":    {"type": "number"},
        },
        "required": ["entity_type", "entity_id"],
    },
}
```

Added to `_DESTRUCTIVE_TOOL_PATTERNS` via the existing `"isolate_"` prefix — elicitation auto-gates. `_format_destructive_summary` case shows source entity, range, estimated duration.

### Drag-to-Timeline (task 104b)

Panel attaches native HTML5 drag handlers on each stem row; sets payload:

```typescript
e.dataTransfer.setData('application/x-scenecraft-stem', JSON.stringify({
  pool_segment_id: stem.pool_segment_id,
  stem_type: stem.stem_type,
  duration_seconds: stem.duration_seconds,
  pool_path: stem.pool_path,
  source_label: run.source_label,
}))
e.dataTransfer.effectAllowed = 'copy'
```

`AudioLane.tsx` (modified) listens for `dragover` + `drop` with this payload. On drop:

```typescript
async function handleStemDrop(e: DragEvent, track: AudioTrack) {
  const payload = JSON.parse(e.dataTransfer.getData('application/x-scenecraft-stem'))
  if (!payload) return
  const cursor_x = pixelsToSeconds(e.clientX - trackLaneLeft)
  const drop_start = cursor_x
  const drop_end = drop_start + payload.duration_seconds

  // Resolve overlaps with existing clips on this track
  const conflicts = track.clips.filter(c => !(c.end_time <= drop_start || c.start_time >= drop_end))
  await resolveOverlapsWithSplit(projectName, track.id, conflicts, drop_start, drop_end)

  // Create the new clip
  await postAddAudioClip(projectName, {
    track_id: track.id,
    source_path: payload.pool_path,
    start_time: drop_start,
    end_time: drop_end,
    name: `${payload.source_label} · ${payload.stem_type}`,
  })
}
```

`resolveOverlapsWithSplit` is the overwrite-with-split logic described earlier. Wrap the whole thing in `POST /batch-audio-clip-ops` (new) that does the multi-op in one undo group, or chain individual mutations and rely on client-side undo groups (less clean).

---

## Benefits

- **Validates plugin seams.** First real plugin exercises `plugin.yaml`, `plugin-api`, `PluginHost`, `operations`, `contextMenus`, panel contribution, and drag-to-timeline all at once.
- **User value now.** Cleaner dialogue on Oktoberfest/interview audio without leaving the editor. Both the vocal AND the residual ambience are usable.
- **Extractable later.** When the real loader ships, the plugin's filesystem dir, its `plugin.yaml`, its `activate()` export, and its API calls are already in the right shape — no refactor of plugin code.
- **Low model cost.** DFN3 is ~2.3 MB, MIT, CPU-realtime. Residual computation is numpy, no extra ML.
- **Multi-stem future-proof.** The `audio_isolations` + `isolation_stems` schema supports any N-stem model without migration. Adding MDX23C-InstVoc-HQ later (for music sources) or Demucs-6s later (for drums/bass/guitar/piano) is additive — same tables, same panel, new model option in the run form.
- **No timeline reconciliation at run time.** Source is unchanged; stems appear in the panel. The user chooses when and how to put them on the timeline via drag.

---

## Trade-offs

- **Residual ≠ source-separated background.** `source − vocal` produces a real residual but it includes DFN3's artifacts (anything DFN3 removed is in the background; anything it couldn't remove also bleeds into the vocal). For genuinely clean instrumental/background stems, a true source-separation model (MDX23C / Demucs) is eventually needed. Flagged as follow-up.
- **DFN3 is speech-biased.** Works great for dialogue-over-crowd/HVAC/wind. Less great for "clean up the guitar in this messy band recording" (use Demucs later for that).
- **Overwrite-with-split is opinionated.** Users coming from non-NLE tools might expect "fail with a warning" instead. The overwrite semantics match DaVinci Resolve / Premiere's default modifier-free drop, so it's mainstream but not universal. If complaints surface, add a modifier (Shift-drop = reject, plain drop = overwrite).
- **Manifest is documentation, not runtime config (MVP).** `plugin.yaml` isn't parsed; if it drifts from `activate()` + `PluginHost` wiring, nothing breaks but the docs become misleading. Mitigation: yaml-vs-registry consistency test.
- **Seam is informal.** Plugin *could* still import app internals directly. Mitigation: `plugin-api` re-exports the allowed surface; lint rule can follow when the surface is stable.
- **No delete/hide button for stems in MVP.** Stems accumulate; cleanup relies on the existing pool GC path. If a project generates dozens of runs, the panel scroll gets long. Addable later without schema change.
- **No confirm modal in the panel.** The inline Run button is click-to-kick-off, no second step. This matches the panel-as-entry-point UX but means mis-clicks cost a ~5 min job. Mitigation: the Run button's disabled/enabled state gates on "source selected + range valid", so it's hard to fire accidentally.

---

## Dependencies

- **Runtime:** Python 3.10+, DeepFilterNet3 (`pip install deepfilternet`, lazy-downloaded on first use), ffmpeg (system binary, already used elsewhere), numpy (already a dep).
- **Frontend:** No new deps. Reuses existing `<audio>` element, range-request streaming, dockview panel system, drag-and-drop infra.
- **Backend internal:** existing JobManager, `compute_peaks`, `pool_segments` helpers. New `audio_isolations` + `isolation_stems` tables + helpers.
- **Plugin scaffolding:** `plugin_api.py`, `plugin_host.py`, `lib/plugin-api.ts`, `lib/plugin-host.ts` — all landed in task 101.
- **Related designs:** [`local.contribution-points.md`](local.contribution-points.md), [`local.audio-tracks-and-clips.md`](local.audio-tracks-and-clips.md) (the underlying audio_clips/audio_tracks tables from M9).
- **Reference:** `~/bytv.md` (stem ontology; future ML chain for music-source expansion).

---

## Testing Strategy

### Unit (backend)
- DB helpers: `add_audio_isolation` / `update_status` / `add_isolation_stem` / `get_isolations_for_entity` / `get_isolation_stems` — round-trip.
- `_classify_media_type` still classifies `.wav` as `audio` (regression).
- Mocked DFN3 client: `isolate_vocals.run()` returns `{isolation_id, job_id}`; poll job to completion; assert `audio_isolations.status='completed'`, two `isolation_stems` rows, two `pool_segments` rows with `kind='generated'`.
- Residual math: feed a known input where vocal=A and background=B, confirm `wav_vocal ≈ A` and `wav_bg ≈ B` within a tolerance.
- Subset range: assert stem duration = trim_out − trim_in.

### Unit (frontend)
- `PluginHost.register(isolateVocals)` collects the panel descriptor.
- `AudioIsolationsPanel` renders empty state, in-progress state, completed-run list.
- Drag payload shape verified in a test that fires `dragstart` and inspects `dataTransfer`.
- Overwrite-with-split: given three positions (left-edge, right-edge, fully-inside), assert correct clip mutations.

### Integration
- REST: `POST /plugins/isolate-vocals/run` → job runs → `GET /audio-isolations?entityType=audio_clip&entityId=...` returns the run + stems.
- REST: `GET /pool/:seg_id/peaks` returns float16 bytes for a freshly-created stem segment.
- Chat tool: `isolate_vocals` fires elicitation; accept runs the job; decline leaves state unchanged.

### E2E
- Right-click an audio_clip → "Isolate vocals…" → panel opens → Run → progress toast → two stems appear → drag the vocal stem onto an empty audio lane → new clip appears + new track auto-created.
- Overwrite-with-split E2E: drop a stem that partially overlaps an existing clip; confirm the existing clip gets trimmed and the stem clip lands cleanly.

---

## Migration Path

1. **Schema migration (new task 100b)** — add `audio_isolations` + `isolation_stems` tables + indexes via `_ensure_schema`. Idempotent. No data migration.
2. **Backend plugin (task 102 redesigned)** — build `plugins/isolate_vocals/` module: manifest, `run` handler, DFN3 wrapper, residual logic, registration.
3. **Frontend plugin (task 103 redesigned)** — build `plugins/isolate-vocals/`: manifest mirror, `IsolateVocalsRunForm`, `AudioIsolationsPanel`, client helpers.
4. **AudioIsolationsPanel + panel registration (task 104 redesigned)** — hook panel into dockview registry; wire context-sensitive rendering; stem rows with waveforms via the new `/pool/:seg_id/peaks` route.
5. **Drag-to-timeline + overwrite-with-split (new task 104b)** — modify `AudioLane.tsx` to accept the stem drag payload; implement overlap resolution.
6. **Chat tool (task 105 redesigned)** — `isolate_vocals` wrapper with range params and elicitation gate.
7. **Tests** per the testing strategy above.

No backward-compat concerns — this is net-new functionality. The v1 `audio_candidates` table (from task-100) stays in the schema for future generated-audio features; nothing in this plugin writes to it.

---

## Key Design Decisions

### Scope & Output Shape

| Decision | Choice | Rationale |
|---|---|---|
| Output shape | N stems per run (not single candidate) | User wants to browse + drag stems; the candidate pattern doesn't fit. |
| Source is unchanged by a run | Yes | Zero timeline reconciliation; source stays pristine while user iterates. |
| Run grouping | `audio_isolations` table + `isolation_stems` junction | Clean 1:N from source to runs; junction allows future stem-reuse across runs. |
| `stem_type` lives on junction | Yes | Same pool_segment could be classified differently in another run; row data stays portable. |
| Candidate pattern (task-100) | Kept in DB, NOT used by this operation | Reserved for future generated-audio; isolation stems are deliberately separate. |

### Stem Ontology & Model

| Decision | Choice | Rationale |
|---|---|---|
| MVP stem labels | `vocal`, `background` | Matches bytv pipeline; "isolate" framing satisfied (not just denoise). |
| Expansion labels | `kick`, `snare`, `toms`, `hh`, `ride`, `crash`, `bass`, `guitar`, `piano`, `other` | Forward-compat with bytv's MDX23C-DrumSep + Demucs-6s downstream chain. |
| Free-form stem_type | Allowed with soft validation | Future models / experiments; warn on unknown, don't reject. |
| Model (MVP) | **DeepFilterNet3** | Right tool for dialogue-over-noise (Oktoberfest, interviews). MDX23C is music-only. Ships small (~2.3MB), MIT, CPU-realtime. |
| Background stem derivation | `source − vocal` (time-domain subtraction) | Gives a real residual with no second model. Numpy one-liner. |
| Model selector in dialog (MVP) | Hidden (DFN3 only) | Expose when a second model (MDX23C) is added; deferred. |

### Range & Entity

| Decision | Choice | Rationale |
|---|---|---|
| Input entity types (MVP) | `audio_clip` + `transition` | Cleaning a video transition's dialogue is common; both in-scope. |
| Range modes | `full` + `subset` | Covers "snippet I'm working on" and "clean everything so I can re-edit". |
| Default range | `subset` | Matches user intent when a clip is selected. |
| Sample rate | Preserve source's rate | Avoid double-resample artifacts. |

### Panel & Interaction

| Decision | Choice | Rationale |
|---|---|---|
| Panel | New `AudioIsolationsPanel` (dockview) | Dedicated surface; doesn't compete with AudioClipPanel (deferred). |
| Panel role | Both viewer AND kickoff entry point | Single-location workflow matches DaVinci Resolve's Audio Clean Feed pattern. |
| Panel context | Sensitive to selected audio_clip / transition | No global isolations library for MVP; scoped to the entity in view. |
| Confirm modal (UI) | None — inline Run button in the panel | Panel context already shows everything a modal would. |
| Confirm modal (chat tool) | Kept (elicitation) | Chat actions lack visual context; a one-line confirm is cheap safety. |
| Delete / hide in panel | Not in MVP | Rely on existing pool GC. |
| Failure handling | Toast + persistent failed-run card with retry | User can see why a job failed without opening logs. |
| Concurrency | Parallel | OS scheduler; revisit if users complain about contention. |

### Drag-to-Timeline

| Decision | Choice | Rationale |
|---|---|---|
| Drop on empty lane | Creates new audio_track + audio_clip | Matches existing pool-drag-to-timeline UX. |
| Drop on existing track (no overlap) | Insert new clip | Standard NLE behavior. |
| Drop on existing track (overlap) | **Overwrite-with-split** | Dropped stem wins; existing clip trimmed/consumed/split. |
| Drop on transition's audio region | Deferred (P2) | Requires more design around transition-audio semantics. |
| Clip name template | `{source.label} · {stem_type}` | Identifies source + stem without the noise of model name. |

### Routes & Schema

| Decision | Choice | Rationale |
|---|---|---|
| Peaks for stems | New `GET /pool/:seg_id/peaks` | Stems aren't audio_clips; can't reuse the clip-keyed peaks route. |
| Peaks for audio_clips | **Unchanged** — keep `/audio-clips/:id/peaks` | No canonicalization refactor; Option A (minimal) wins. |
| `pool_segments.kind` for stems | `'generated'`, `created_by='isolate-vocals'` | Provenance in existing column; media type derived from extension (`.wav`). |

### Plugin Scaffolding (carried forward from clarification-8)

| Decision | Choice | Rationale |
|---|---|---|
| Manifest filename | `plugin.yaml` | Distinguishes from `package.json` / `pyproject.toml`. |
| Directory naming | hyphen (frontend), underscore (backend) | Matches each ecosystem's convention. |
| PluginHost | Static registry, no dynamic load | MVP. Seam is ready for a real loader. |
| plugin-api module | Explicit host surface, re-exports only | Lint-able boundary; extractable plugin later. |

---

## Future Considerations

- **MDX23C-InstVoc-HQ as a second operation** (`separate-music-vocals.run`) — for music sources. Different model, different entity types in panel (matches bytv's top-level split).
- **Full bytv pipeline** — MDX23C-DrumSep (kick/snare/toms/hh/ride/crash) and Demucs-6s (bass/guitar/piano/other) as additional operations producing their own stem types. Panel handles arbitrary stem lists.
- **Stem delete/hide button in panel** — once users start accumulating runs, add soft-delete + bulk cleanup UI.
- **Drop onto a transition's audio region** — replace transition's auto-extracted audio with a stem directly, instead of creating a new audio_clip.
- **Real plugin loader** — scan `node_modules/@scenecraft-plugins/*` + `~/.scenecraft/plugins/*`; parse `plugin.yaml`; validate contributions; call `activate()` in a permission-scoped context. This plugin's code loads unchanged.
- **Lint rule: plugins can't import app internals** — enforce `plugin-api` as the only import path from `src/plugins/**` once the surface is stable.
- **Stem reuse / caching** — if the same (source, range, model) is requested twice, skip the work and reattach existing stems to a new `audio_isolations` row. Junction already supports it.
- **Batch operations** — right-click multiple audio_clips → "Isolate vocals on all". The JobManager already supports concurrent jobs.
- **Chat tool post-run actions** — after `isolate_vocals` completes, allow chat to follow up with "drop the vocal stem on track A3 at 0:00" via a subsequent tool call.

---

**Status**: Design Specification (v2)
**Recommendation**: Re-plan M11 tasks 100b, 102, 103, 104, 104b, 105 against this design; task 101 (plugin host scaffolding) is unaffected and can proceed in parallel.
**Related Documents**:
- [Clarification 9: Audio Isolation — Stems, Range, and Panel](../clarifications/clarification-9-audio-isolation-stems-and-panel.md) (Completed — source of truth for v2 decisions)
- [Clarification 8: Audio Isolation Plugin (v1 scope)](../clarifications/clarification-8-audio-isolation-plugin.md) (Completed — plugin scaffolding decisions still valid)
- [Contribution Points](local.contribution-points.md) — extends with `operations` + `contextMenus`
- [Audio Tracks and Clips](local.audio-tracks-and-clips.md) — M9 foundation for `audio_clips` / `audio_tracks`
- `~/bytv.md` — reference pipeline / stem ontology
