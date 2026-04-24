# Task 144: Backend Plugin Module

**Milestone**: [M18](../../milestones/milestone-18-foley-generation-plugin.md)
**Design Reference**: [`local.foley-generation-plugin.md`](../../design/local.foley-generation-plugin.md) — "Plugin module"
**Clarification**: [`clarification-12-foley-generation-plugin.md`](../../clarifications/clarification-12-foley-generation-plugin.md) — Items 2, 3, 6, 10
**Estimated Time**: 6 hours
**Dependencies**: task-142 (Replicate provider), task-143 (foley schema)
**Status**: Not Started

---

## Objective

Implement the backend `generate-foley` plugin: run handler, v2fx pre-trim step, pool_segment hashing + insert, sidecar table writes, status lifecycle, and startup-hook for disconnect-survival. The plugin delegates all Replicate concerns to `plugin_api.providers.replicate.run_prediction`; its scope is foley-specific business logic + state management.

---

## Context

The plugin translates a `GenerateFoleyRequest` (from REST/WS/chat) into:
1. A `generate_foley__generations` row (status = pending)
2. Optional pre-trim of the source video to `[in, out]` (v2fx only)
3. A `plugin_api.providers.replicate.run_prediction(model='zsxkib/mmaudio', input=..., source='generate_foley')` call
4. A hashed pool_segment insert via `plugin_api.add_pool_segment`
5. A `generate_foley__tracks` junction row
6. Status transition to completed, WS completion event

Error paths cascade through status='failed' with captured error message.

---

## Steps

### 1. Module layout

```
scenecraft-engine/src/scenecraft/plugins/generate_foley/
├── __init__.py          # exports for plugin_host registration
├── plugin.yaml          # backend manifest mirror (metadata only; frontend manifest is canonical)
├── generate_foley.py    # run handler + startup hook
└── pretrim.py           # ffmpeg-based source video trimmer
```

### 2. `run` handler

```python
# generate_foley.py
def run(*, job_id: str, request: GenerateFoleyRequest) -> None:
    """Main entrypoint invoked by the JobManager."""
    gen_id = _create_generation_row(request)
    plugin_api.emit_job_event(job_id, 'job_started',
                              {'generation_id': gen_id, 'mode': request.mode})

    try:
        _set_status(gen_id, 'running', started_at=now())

        video_arg: Path | None = None
        if request.mode == 'v2fx':
            plugin_api.emit_job_event(job_id, 'job_progress', {'stage': 'pretrim'})
            video_arg = pretrim.trim_to_range(
                source_candidate_id=request.source_candidate_id,
                in_seconds=request.source_in_seconds,
                out_seconds=request.source_out_seconds,
            )

        plugin_api.emit_job_event(job_id, 'job_progress', {'stage': 'predicting'})
        result = plugin_api.providers.replicate.run_prediction(
            model='zsxkib/mmaudio',
            input={
                'prompt': request.prompt or '',
                'duration': request.duration_seconds,
                'video': video_arg,
                'negative_prompt': request.negative_prompt or 'music',
                'cfg_strength': request.cfg_strength or 4.5,
                'seed': request.seed,
            },
            source='generate_foley',
        )

        plugin_api.emit_job_event(job_id, 'job_progress', {'stage': 'downloading'})
        pool_segment_id = plugin_api.add_pool_segment(
            bytes_=result.output_bytes,
            kind='generated',
            variant_kind='foley',
            context_entity_type=request.entity_type,
            context_entity_id=request.entity_id,
            derived_from=_source_pool_segment_id(request),
            generation_params={
                'provider': 'replicate',
                'model': 'zsxkib/mmaudio',
                'prompt': request.prompt,
                'cfg_strength': request.cfg_strength,
                'seed': request.seed,
                'mode': request.mode,
            },
            created_by='plugin:generate-foley',
        )

        _insert_track(
            generation_id=gen_id,
            pool_segment_id=pool_segment_id,
            variant_index=0,
            replicate_prediction_id=result.prediction_id,
            duration_seconds=request.duration_seconds,
            spend_ledger_id=result.spend_ledger_id,
        )
        _set_status(gen_id, 'completed', completed_at=now())
        plugin_api.emit_job_event(job_id, 'job_completed',
                                   {'generation_id': gen_id,
                                    'pool_segment_id': pool_segment_id})

    except ReplicateDownloadFailed as e:
        _set_status(gen_id, 'failed',
                    error=f'Prediction charged ({e.spend_ledger_id}), download failed. Retry will re-charge.',
                    completed_at=now())
        plugin_api.emit_job_event(job_id, 'job_failed', {'error': str(e)})

    except ReplicatePredictionFailed as e:
        _set_status(gen_id, 'failed',
                    error=f'MMAudio prediction failed: {e.error}',
                    completed_at=now())
        plugin_api.emit_job_event(job_id, 'job_failed', {'error': str(e)})

    except Exception as e:
        _set_status(gen_id, 'failed', error=str(e), completed_at=now())
        plugin_api.emit_job_event(job_id, 'job_failed', {'error': str(e)})
        raise
```

### 3. `pretrim.py`

```python
def trim_to_range(*, source_candidate_id: str,
                  in_seconds: float,
                  out_seconds: float) -> Path:
    """Pre-trim the source candidate's video to [in, out].

    Resolves source_candidate_id → tr_candidates row → pool_segment_id → pool_path.
    Writes trimmed clip to a temp file and returns the path.

    Uses ffmpeg -ss in -to out -c copy when keyframe-aligned (fast), else re-encodes.
    """
    ...
```

Implementation notes:
- Default to `-c copy` (stream copy, no re-encode) — fastest path
- If `-c copy` produces a clip with the wrong start frame (common when `in_seconds` isn't on a keyframe), fall back to re-encode with `-ss in -to out -c:v libx264 -preset ultrafast`
- Write to `tempfile.TemporaryDirectory()`; caller is responsible for cleanup after provider call completes
- Validate `in_seconds < out_seconds` and `(out - in) <= 30` (product-side ceiling); raise `ValueError` if violated

### 4. `_source_pool_segment_id` helper

```python
def _source_pool_segment_id(request: GenerateFoleyRequest) -> str | None:
    """For v2fx, look up the tr_candidate → pool_segment_id for derived_from.
    Returns None for t2fx."""
    if request.mode == 't2fx':
        return None
    return _query_tr_candidate_pool_segment(request.source_candidate_id)
```

### 5. Startup hook for disconnect-survival

```python
# __init__.py or a dedicated startup module
def on_startup() -> None:
    """Scan for in-flight generations and reattach polling via the provider."""
    rows = db.query(
        'SELECT id, (SELECT replicate_prediction_id FROM generate_foley__tracks '
        'WHERE generation_id = g.id LIMIT 1) AS pred_id '
        'FROM generate_foley__generations g WHERE status IN ("pending", "running")'
    )
    for row in rows:
        if row['pred_id']:
            plugin_api.providers.replicate.attach_polling(
                prediction_id=row['pred_id'],
                source='generate_foley',
                on_complete=lambda result, gen_id=row['id']: _resume(gen_id, result),
            )
        # else: the prediction wasn't created yet — mark failed
```

Register this hook in `plugin_host.py`'s backend registry for invocation on server start.

### 6. Retry endpoint handler

A retry creates a NEW `generate_foley__generations` row with the same params as the original. Does NOT reuse the original prediction_id. User-initiated only (no automatic retry).

### 7. Tests

- t2fx happy path: prompt only → pool_segment created, variant_kind='foley', derived_from=NULL, context=NULL
- v2fx happy path: pre-trim called, video passed to provider, derived_from populated, context set
- v2fx with out ≤ in: pre-trim raises ValueError before provider call
- Replicate prediction failed: generation row marked failed with error; NO pool_segment created
- Replicate download failed: generation row marked failed with "prediction charged" message; NO pool_segment created; spend_ledger still has the row from provider
- Retry creates a new generation_id, a new prediction, a new charge
- Startup scan reattaches polling for `status IN ('pending','running')` rows

---

## Verification

- [ ] `plugins/generate_foley/` directory created with all three files
- [ ] `run` handler executes t2fx path end-to-end in tests
- [ ] `run` handler executes v2fx path end-to-end with pre-trim
- [ ] Pre-trim falls back to re-encode when stream copy produces wrong start frame
- [ ] Status transitions `pending → running → completed` on success
- [ ] Status transitions to `failed` with meaningful error on all three failure paths
- [ ] `pool_segments` row has all correct fields populated (variant_kind, context, derived_from, generation_params, created_by, kind)
- [ ] `__tracks` junction row written with variant_index=0, correct prediction_id + spend_ledger_id
- [ ] Startup hook reattaches in-flight predictions without re-creation
- [ ] Real-API smoke test (gated env var) produces a working t2fx + v2fx generation

---

## Expected Output

```
scenecraft-engine/src/scenecraft/plugins/generate_foley/
├── __init__.py
├── plugin.yaml
├── generate_foley.py
└── pretrim.py

scenecraft-engine/tests/plugins/generate_foley/
├── test_generate_foley.py
└── test_pretrim.py
```

---

## Notes

- The plugin never imports `scenecraft.db` directly — all DB writes go through `plugin_api.add_pool_segment`, and direct table inserts for plugin-owned tables use the db handle exposed via `plugin_api.plugin_db('generate_foley')` or equivalent (match M16's pattern).
- Keep `run` thread-safe: multiple concurrent generations should not share state.
- Pre-trim writes to a tempdir that cleans up when the `run` function exits (context manager).

---

**Next Task**: [task-145](task-145-backend-rest-and-ws.md) — Backend REST + WS
