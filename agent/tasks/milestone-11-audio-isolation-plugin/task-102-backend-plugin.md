# Task 102: Backend isolate-vocals Plugin

**Milestone**: [M11 - Audio Isolation Plugin](../../milestones/milestone-11-audio-isolation-plugin.md)
**Design Reference**: [local.audio-isolation-plugin.md](../../design/local.audio-isolation-plugin.md)
**Estimated Time**: 6 hours
**Dependencies**: [Task 100: Schema & helpers](task-100-schema-and-helpers.md), [Task 101: Plugin host scaffolding](task-101-plugin-host-scaffolding.md)
**Status**: Not Started

---

## Objective

Build the backend side of the isolate-vocals plugin: DeepFilterNet3 integration, threaded job kickoff, REST endpoint, and `PluginHost` registration. Output appends a new `audio_candidate` and auto-selects it.

Implements in `scenecraft-engine/src/scenecraft/plugins/isolate_vocals/`.

---

## Steps

### 1. Directory & manifest

Create `scenecraft-engine/src/scenecraft/plugins/isolate_vocals/plugin.yaml`:

```yaml
name: isolate-vocals
version: 0.1.0
displayName: "Isolate Vocals"
description: "Strip background noise from an audio clip using DeepFilterNet3."
publisher: scenecraft
license: MIT

activationEvents:
  - onCommand:isolate-vocals.run
  - onContextMenu:audio_clip

contributes:
  operations:
    - id: isolate-vocals.run
      label: "Isolate vocals"
      entityTypes: [audio_clip]                 # MVP: audio_clip only
      handler: "backend:isolate_vocals.run"
      ui: "frontend:isolate_vocals.Dialog"
      output: audio_candidate

  contextMenus:
    - entityType: audio_clip
      items:
        - operation: isolate-vocals.run
          label: "Isolate vocals…"
          icon: wave
```

### 2. `plugins/isolate_vocals/__init__.py`

```python
"""isolate-vocals plugin: DeepFilterNet3-based audio denoising."""

from scenecraft.plugin_host import PluginHost, OperationDef
from . import isolate_vocals as impl


def activate(plugin_api):
    """Called once by PluginHost.register at server startup."""
    PluginHost.register_operation(OperationDef(
        id="isolate-vocals.run",
        label="Isolate vocals",
        entity_types=["audio_clip"],
        handler=impl.run,
    ))
    plugin_api.register_rest_endpoint(
        r"^/api/projects/[^/]+/plugins/isolate-vocals/run$",
        impl.handle_rest,
    )


# Public re-exports for the host / tests
run = impl.run
```

### 3. `plugins/isolate_vocals/isolate_vocals.py`

The kickoff helper — patterned on `chat_generation.py`'s `start_keyframe_generation`.

```python
"""Kickoff helper for the isolate-vocals operation."""

import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


def run(entity_type: str, entity_id: str, context: dict) -> dict:
    """Kick off a denoise job. Returns {job_id, audio_clip_id} or {error}.

    context expected keys:
      - project_dir: Path
      - project_name: str
    """
    from scenecraft import plugin_api
    from scenecraft.plugin_host import PluginHost  # noqa

    if entity_type != "audio_clip":
        return {"error": f"unsupported entity_type for MVP: {entity_type}"}

    project_dir: Path = context["project_dir"]
    project_name: str = context.get("project_name", "")

    clip = plugin_api.get_audio_clip(project_dir, entity_id)
    if not clip:
        return {"error": f"audio_clip not found: {entity_id}"}

    src = plugin_api.get_audio_clip_effective_path(project_dir, clip)
    src_path = project_dir / src
    if not src_path.exists():
        return {"error": f"source file not found: {src}"}

    # Pre-generate pool_segment UUID so we can write the file straight to its final path
    seg_id = uuid.uuid4().hex
    pool_dir = project_dir / "pool" / "segments"
    pool_dir.mkdir(parents=True, exist_ok=True)
    out_filename = f"{seg_id}.wav"   # WAV for MVP simplicity; mp3 transcode can follow later
    out_path = pool_dir / out_filename

    job_id = plugin_api.job_manager.create_job(
        "isolate_vocals",
        total=100,
        meta={"audioClipId": entity_id, "project": project_name, "plugin": "isolate-vocals"},
    )

    def _work():
        try:
            from .model import denoise_wav
            plugin_api.job_manager.update_progress(job_id, 5, "loading model")

            # 1. ffmpeg: source → wav_in (temp)
            tmp_wav = pool_dir / f"_tmp_isolate_{seg_id}.wav"
            plugin_api.extract_audio_as_wav(src_path, tmp_wav, sample_rate=48000)
            plugin_api.job_manager.update_progress(job_id, 20, "denoising")

            # 2. DFN3: wav_in → wav_out
            denoise_wav(tmp_wav, out_path)
            tmp_wav.unlink(missing_ok=True)
            plugin_api.job_manager.update_progress(job_id, 80, "saving")

            # 3. Register as pool_segment + candidate + auto-select
            # Write SQL directly (pre-generated UUID means add_pool_segment can't be used as-is)
            from scenecraft.db import get_db, _retry_on_locked
            now_iso = datetime.now().astimezone().isoformat()

            def _insert_seg():
                conn = get_db(project_dir)
                conn.execute(
                    """INSERT INTO pool_segments
                       (id, pool_path, kind, created_by, created_at)
                       VALUES (?, ?, 'generated', 'isolate-vocals', ?)""",
                    (seg_id, f"pool/segments/{out_filename}", now_iso),
                )
                conn.commit()
            _retry_on_locked(_insert_seg)

            plugin_api.undo_begin(project_dir, f"Isolate vocals: {entity_id}")
            plugin_api.add_audio_candidate(
                project_dir,
                audio_clip_id=entity_id,
                pool_segment_id=seg_id,
                source="plugin",
            )
            plugin_api.assign_audio_candidate(project_dir, entity_id, seg_id)

            plugin_api.job_manager.complete_job(job_id, {
                "audio_clip_id": entity_id,
                "pool_segment_id": seg_id,
                "pool_path": f"pool/segments/{out_filename}",
            })
        except Exception as e:
            import sys
            print(f"[isolate-vocals] failed: {e}", file=sys.stderr)
            plugin_api.job_manager.fail_job(job_id, str(e))

    threading.Thread(target=_work, daemon=True).start()
    return {"job_id": job_id, "audio_clip_id": entity_id, "pool_segment_id": seg_id}


def handle_rest(path: str, project_dir: Path, project_name: str, body: dict) -> dict:
    """POST /api/projects/:name/plugins/isolate-vocals/run — thin wrapper over run()."""
    entity_id = body.get("audio_clip_id") or body.get("entity_id")
    if not entity_id:
        return {"error": "missing audio_clip_id"}
    return run("audio_clip", entity_id, {"project_dir": project_dir, "project_name": project_name})
```

### 4. `plugins/isolate_vocals/model.py`

DeepFilterNet3 loader + inference. Lazy — model loads on first call, cached for the process lifetime.

```python
"""DeepFilterNet3 loader and denoise inference."""

from pathlib import Path

_model = None
_df_state = None


def _ensure_model():
    global _model, _df_state
    if _model is not None:
        return
    # pip install deepfilternet  (weights lazy-download on first construct)
    from df.enhance import init_df, enhance, load_audio, save_audio
    _model_ref, _df_state_ref, _ = init_df()  # downloads weights on first call
    globals()["_model"] = (_model_ref, enhance, load_audio, save_audio)
    globals()["_df_state"] = _df_state_ref


def denoise_wav(in_path: Path, out_path: Path) -> None:
    """Read a WAV, run DFN3 enhancement, write a WAV."""
    _ensure_model()
    (model_ref, enhance, load_audio, save_audio) = _model
    audio, _sr = load_audio(str(in_path), sr=_df_state.sr())
    enhanced = enhance(model_ref, _df_state, audio)
    save_audio(str(out_path), enhanced, _df_state.sr())
```

Notes:
- The `df` package (DeepFilterNet3's Python module) handles weight downloading on first `init_df()`
- If `df` is not installed, the `ImportError` is surfaced via the job's `fail_job` — the error message tells the user `pip install deepfilternet`
- GPU usage: DFN3 auto-detects; no explicit device code needed

### 5. pyproject.toml

Add `deepfilternet` as an optional dep. Example:

```toml
[project.optional-dependencies]
plugins = [
    "deepfilternet>=0.5.6",
]
```

Document in plugin README that users run `pip install scenecraft-engine[plugins]`.

### 6. Wire into api_server.py

Uncomment the plugin import from task 101:

```python
from scenecraft.plugins import isolate_vocals
PluginHost.register(isolate_vocals)
```

And add route dispatch for plugin-registered routes inside the request handler (after all built-in routes):

```python
# Plugin-registered POST routes
result = PluginHost.dispatch_rest(path, project_dir, m.group(1), self._read_json_body() or {})
if result is not None:
    return self._json_response(result)
```

### 7. Tests

`plugins/isolate_vocals/tests/test_isolate_vocals.py`:

- Mock `model.denoise_wav` so tests don't require the DFN3 binary (use a fake that copies input to output)
- Fixture audio_clip with a small WAV source
- Invoke `run("audio_clip", clip_id, context)` → verify `{job_id, audio_clip_id, pool_segment_id}`
- Poll `job_manager.get_job(job_id)` until completed
- Assert:
  - File at `pool/segments/{seg_id}.wav` exists
  - `pool_segments` row created with `kind='generated'` and `created_by='isolate-vocals'` (NB: `kind` is provenance, not media type — 'audio' is NOT a valid value)
  - `audio_candidates` row created with `source='plugin'`
  - `audio_clips.selected` is set to the new pool_segment_id
  - `undo_groups` has a matching "Isolate vocals: ..." entry
- Error paths: missing clip, missing source file, model raises → `fail_job` surfaces

---

## Verification

- [ ] `plugins/isolate_vocals/plugin.yaml` matches the design's manifest shape
- [ ] `activate(plugin_api)` registers the operation and the REST route
- [ ] `run(...)` kicks off a thread, returns `{job_id, audio_clip_id, pool_segment_id}`
- [ ] On completion: pool_segment row + audio_candidate row + audio_clips.selected all updated
- [ ] On failure: `job_manager.fail_job` called; no partial state
- [ ] POST `/api/projects/:name/plugins/isolate-vocals/run` routes through `PluginHost.dispatch_rest`
- [ ] DeepFilterNet3 weights lazy-download on first real call (test with mock so CI doesn't need network)
- [ ] All tests pass with the mock model client
- [ ] Error message is friendly when `deepfilternet` isn't installed
