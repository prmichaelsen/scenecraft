# Task 102: Backend isolate-vocals Plugin (DFN3 + Residual, Multi-Stem)

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md) — Architecture / Backend Handler Sketch / Peaks Endpoint
**Estimated Time**: 7 hours
**Dependencies**: [Task 100b: isolations schema](task-100b-isolations-schema.md), [Task 101: Plugin host scaffolding](task-101-plugin-host-scaffolding.md)
**Status**: Not Started

---

## Objective

Build the backend isolate-vocals plugin: DeepFilterNet3 enhancement + numpy residual subtraction to emit **two stems** (`vocal` + `background`) per run. Output is grouped under one `audio_isolations` row and fanned out via `isolation_stems`. Supports both `audio_clip` and `transition` as source entities. Registers a REST kickoff route and a new pool peaks route.

Implements in `scenecraft-engine/src/scenecraft/plugins/isolate_vocals/` and adds `GET /api/projects/:name/pool/:seg_id/peaks` to `api_server.py`.

---

## Steps

### 1. Directory & manifest

Create `scenecraft-engine/src/scenecraft/plugins/isolate_vocals/plugin.yaml`:

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
      panel: "frontend:isolate_vocals.AudioIsolationsPanel"
      outputs:
        - kind: pool_segment
          stem_type_enum: [vocal, background]

  contextMenus:
    - entityType: audio_clip
      items:
        - operation: isolate-vocals.run
          label: "Isolate vocals…"
          icon: wave
          reveals: panel:audio-isolations
    - entityType: transition
      items:
        - operation: isolate-vocals.run
          label: "Isolate vocals from audio track…"
          icon: wave
          reveals: panel:audio-isolations
```

### 2. `plugins/isolate_vocals/__init__.py`

```python
"""isolate-vocals plugin: DFN3 + residual multi-stem audio isolation."""

from scenecraft.plugin_host import PluginHost, OperationDef
from . import isolate_vocals as impl


def activate(plugin_api):
    PluginHost.register_operation(OperationDef(
        id="isolate-vocals.run",
        label="Isolate vocals",
        entity_types=["audio_clip", "transition"],
        handler=impl.run,
    ))
    plugin_api.register_rest_endpoint(
        r"^/api/projects/[^/]+/plugins/isolate-vocals/run$",
        impl.handle_rest,
    )


run = impl.run
```

### 3. `plugins/isolate_vocals/isolate_vocals.py`

The run handler. Creates an `audio_isolations` row, kicks off a thread, writes two stems as pool_segments, links them via `isolation_stems`, updates the run status.

```python
"""isolate-vocals: DFN3 vocal extraction + numpy residual → background."""

import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


def run(entity_type: str, entity_id: str, context: dict) -> dict:
    """Returns {isolation_id, job_id} on kickoff, or {error}.

    context keys:
      - project_dir (Path)
      - project_name (str)
      - range_mode: 'full' | 'subset'
      - trim_in (float | None), trim_out (float | None)
    """
    from scenecraft import plugin_api

    if entity_type not in ("audio_clip", "transition"):
        return {"error": f"unsupported entity_type: {entity_type}"}

    project_dir: Path = context["project_dir"]
    project_name: str = context.get("project_name", "")
    range_mode = context.get("range_mode", "full")
    trim_in = context.get("trim_in")
    trim_out = context.get("trim_out")

    source_path = _resolve_source_path(project_dir, entity_type, entity_id)
    if source_path is None or not source_path.exists():
        return {"error": "source audio not found"}

    isolation_id = plugin_api.add_audio_isolation(
        project_dir,
        entity_type=entity_type,
        entity_id=entity_id,
        model="deepfilternet3",
        range_mode=range_mode,
        trim_in=trim_in,
        trim_out=trim_out,
    )
    job_id = plugin_api.job_manager.create_job(
        "isolate_vocals",
        total=100,
        meta={
            "isolationId": isolation_id,
            "entityType": entity_type,
            "entityId": entity_id,
            "project": project_name,
            "plugin": "isolate-vocals",
        },
    )

    def _work():
        try:
            plugin_api.update_audio_isolation_status(project_dir, isolation_id, "running")

            # 1. Stage + decode source to canonical WAV
            pool_dir = project_dir / "pool" / "segments"
            pool_dir.mkdir(parents=True, exist_ok=True)
            tmp_in = pool_dir / f"_tmp_isolate_in_{isolation_id}.wav"
            _extract_source_wav(source_path, tmp_in, range_mode, trim_in, trim_out)
            plugin_api.job_manager.update_progress(job_id, 20, "source decoded")

            # 2. DFN3 → vocal (same duration as tmp_in, speech-enhanced)
            from .model import denoise_wav
            tmp_vocal = pool_dir / f"_tmp_isolate_vocal_{isolation_id}.wav"
            denoise_wav(tmp_in, tmp_vocal)
            plugin_api.job_manager.update_progress(job_id, 65, "vocal extracted")

            # 3. Residual: background = source − vocal (time-domain subtraction)
            tmp_bg = pool_dir / f"_tmp_isolate_bg_{isolation_id}.wav"
            _subtract_audio_wav(tmp_in, tmp_vocal, tmp_bg)
            plugin_api.job_manager.update_progress(job_id, 80, "residual computed")

            # 4. Pre-generate pool_segment UUIDs (pattern from chat_generation.py)
            vocal_seg_id = uuid.uuid4().hex
            bg_seg_id = uuid.uuid4().hex
            vocal_out = pool_dir / f"{vocal_seg_id}.wav"
            bg_out = pool_dir / f"{bg_seg_id}.wav"
            tmp_vocal.rename(vocal_out)
            tmp_bg.rename(bg_out)
            tmp_in.unlink(missing_ok=True)

            # 5. Register both as pool_segments + junction rows (inside one undo group)
            dur = _wav_duration_seconds(vocal_out)
            now_iso = datetime.now().astimezone().isoformat()
            plugin_api.undo_begin(project_dir, f"Isolate vocals: {entity_type} {entity_id}")

            _insert_pool_segment(project_dir, vocal_seg_id, f"pool/segments/{vocal_seg_id}.wav",
                                 duration=dur, created_by="isolate-vocals", created_at=now_iso)
            _insert_pool_segment(project_dir, bg_seg_id, f"pool/segments/{bg_seg_id}.wav",
                                 duration=dur, created_by="isolate-vocals", created_at=now_iso)

            plugin_api.add_isolation_stem(project_dir, isolation_id, vocal_seg_id, "vocal")
            plugin_api.add_isolation_stem(project_dir, isolation_id, bg_seg_id, "background")

            plugin_api.update_audio_isolation_status(project_dir, isolation_id, "completed")

            plugin_api.job_manager.complete_job(job_id, {
                "isolation_id": isolation_id,
                "stems": [
                    {"stem_type": "vocal",      "pool_segment_id": vocal_seg_id, "pool_path": f"pool/segments/{vocal_seg_id}.wav"},
                    {"stem_type": "background", "pool_segment_id": bg_seg_id,    "pool_path": f"pool/segments/{bg_seg_id}.wav"},
                ],
            })
        except Exception as e:
            import sys
            print(f"[isolate-vocals] failed: {e}", file=sys.stderr)
            plugin_api.update_audio_isolation_status(
                project_dir, isolation_id, "failed", error=str(e)
            )
            plugin_api.job_manager.fail_job(job_id, str(e))

    threading.Thread(target=_work, daemon=True).start()
    return {"isolation_id": isolation_id, "job_id": job_id}


def handle_rest(path: str, project_dir: Path, project_name: str, body: dict) -> dict:
    """POST /api/projects/:name/plugins/isolate-vocals/run"""
    entity_type = body.get("entity_type") or "audio_clip"
    entity_id = body.get("entity_id")
    if not entity_id:
        return {"error": "missing entity_id"}
    context = {
        "project_dir": project_dir,
        "project_name": project_name,
        "range_mode": body.get("range_mode", "full"),
        "trim_in": body.get("trim_in"),
        "trim_out": body.get("trim_out"),
    }
    return run(entity_type, entity_id, context)
```

### 4. Source resolution + ffmpeg helpers

Same module, private helpers:

```python
def _resolve_source_path(project_dir: Path, entity_type: str, entity_id: str) -> Path | None:
    """audio_clip → its effective source (selected pool_segment or source_path).
       transition → extract the selected video candidate's audio to audio_staging/."""
    from scenecraft import plugin_api

    if entity_type == "audio_clip":
        clip = plugin_api.get_audio_clip(project_dir, entity_id)
        if not clip:
            return None
        rel = plugin_api.get_audio_clip_effective_path(project_dir, clip)
        return project_dir / rel

    if entity_type == "transition":
        # Extract audio from the transition's selected video candidate
        # (pool_segment.poolPath) into audio_staging/, return that wav.
        # Shape mirrors existing staged-audio flow.
        ...

    return None


def _extract_source_wav(src: Path, out: Path, range_mode, trim_in, trim_out) -> None:
    """ffmpeg: mono 48kHz PCM. If range_mode='subset', apply -ss trim_in -to trim_out."""

def _subtract_audio_wav(src_wav: Path, vocal_wav: Path, out_wav: Path) -> None:
    """Load both as float32 numpy arrays (same sample rate, same length),
       write (src - vocal) to out_wav as 16-bit PCM."""

def _wav_duration_seconds(p: Path) -> float:
    """ffprobe or soundfile-based duration read."""

def _insert_pool_segment(project_dir: Path, seg_id: str, pool_path: str, *,
                         duration: float, created_by: str, created_at: str) -> None:
    """Direct INSERT into pool_segments (kind='generated') bypassing add_pool_segment
       so we can use a pre-generated seg_id. Uses _retry_on_locked."""
```

### 5. `plugins/isolate_vocals/model.py`

Lazy DFN3 loader + inference — unchanged from prior plan. Input: mono WAV. Output: same-duration speech-enhanced WAV.

```python
"""DeepFilterNet3 loader + denoise."""

from pathlib import Path

_state = {"init": False}


def _ensure_model():
    if _state["init"]:
        return
    from df.enhance import init_df, enhance, load_audio, save_audio
    model, df_state, _ = init_df()
    _state.update(init=True, model=model, enhance=enhance, load=load_audio, save=save_audio, sr=df_state.sr(), df_state=df_state)


def denoise_wav(in_path: Path, out_path: Path) -> None:
    _ensure_model()
    audio, _ = _state["load"](str(in_path), sr=_state["sr"])
    enhanced = _state["enhance"](_state["model"], _state["df_state"], audio)
    _state["save"](str(out_path), enhanced, _state["sr"])
```

### 6. Peaks endpoint: `GET /pool/:seg_id/peaks`

In `api_server.py`, add route (before plugin dispatch):

```python
m = re.match(r"^/api/projects/([^/]+)/pool/([^/]+)/peaks$", path)
if m and self.command == "GET":
    return self._handle_pool_peaks(m.group(1), m.group(2))
```

Handler body per design doc §Peaks Endpoint — thin wrapper over `compute_peaks(pool_path, source_offset=0, duration=seg.durationSeconds, resolution, project_dir)`. 404 on missing seg or missing file. Response is `application/octet-stream` with `X-Peak-Resolution` and `X-Peak-Duration` headers, matching the audio-clip peaks response shape.

### 7. List runs endpoint: `GET /audio-isolations`

```python
m = re.match(r"^/api/projects/([^/]+)/audio-isolations$", path)
if m and self.command == "GET":
    entity_type = self._qs_get("entityType")
    entity_id = self._qs_get("entityId")
    rows = get_isolations_for_entity(project_dir, entity_type, entity_id)
    return self._json({"isolations": rows})
```

### 8. Wire plugin into api_server startup

Uncomment the stub from task 101:

```python
from scenecraft.plugins import isolate_vocals
PluginHost.register(isolate_vocals)
```

And make the plugin REST dispatch hook fire on POST paths that don't match built-in routes (design doc §Implementation).

### 9. pyproject.toml

Add `deepfilternet>=0.5.6` under `[project.optional-dependencies].plugins`. Document `pip install scenecraft-engine[plugins]` in the plugin README.

### 10. Tests

`plugins/isolate_vocals/tests/test_isolate_vocals.py`:
- Mock `model.denoise_wav` so tests don't hit DFN3 binaries (fake copies input to output → residual subtraction yields silence, but schema wiring is tested).
- `run('audio_clip', clip_id, context)` returns `{isolation_id, job_id}`.
- Poll `job_manager.get_job(job_id)` until terminal; assert `audio_isolations.status == 'completed'`, 2 `isolation_stems` rows, 2 `pool_segments` rows (`kind='generated'`, `created_by='isolate-vocals'`).
- Residual test: feed a synthetic source + known vocal; assert `_subtract_audio_wav` writes a WAV whose samples are `source − vocal` within rounding.
- Error paths: missing entity → `{error}`, missing source file → `fail_job` + `audio_isolations.status='failed'` with `error` populated.
- `transition` entity path: mocked `_resolve_source_path` returns a staged WAV; run completes same way.
- Undo: complete a run; undo the `Isolate vocals: ...` group; `audio_isolations` + both `isolation_stems` + both `pool_segments` rows get reverted.

`tests/test_pool_peaks_endpoint.py`:
- GET `/api/projects/:name/pool/:seg_id/peaks?resolution=400` returns 200, `application/octet-stream`, `X-Peak-Resolution: 400`, body size matches float16 layout for the given resolution.
- 404 on unknown seg_id.
- 404 when the file is missing on disk.

---

## Verification

- [ ] `plugins/isolate_vocals/plugin.yaml` matches v2 manifest (panel contribution, dual entity types, outputs spec)
- [ ] `activate(plugin_api)` registers the operation + the REST route
- [ ] `run(...)` returns `{isolation_id, job_id}`; progress ticks through 20/65/80/100
- [ ] Completion path: `audio_isolations` row status=completed, 2 `isolation_stems` rows, 2 `pool_segments` rows
- [ ] Failure path: status=failed, error populated, job fail_job called
- [ ] Residual subtraction produces samples within floating-point tolerance of `source − vocal`
- [ ] Both entity types (`audio_clip` and `transition`) resolve to a valid source WAV and complete a run
- [ ] `GET /pool/:seg_id/peaks` returns peaks bytes; 404 on missing/deleted seg
- [ ] `GET /audio-isolations?entityType=...&entityId=...` returns runs with nested stems
- [ ] POST `/api/projects/:name/plugins/isolate-vocals/run` routes through `PluginHost.dispatch_rest`
- [ ] DFN3 weights lazy-download on first real call (tests use mock model)
- [ ] Undo group round-trip: undo reverts all three tables; redo re-applies them
- [ ] No writes to `audio_candidates` or `audio_clips.selected` (confirm via test assertion)
