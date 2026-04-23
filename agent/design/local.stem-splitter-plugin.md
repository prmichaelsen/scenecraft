# Stem Splitter Plugin

**Concept**: Port beatlab's GPU-accelerated multi-model stem pipeline (11 named stems via MDX23C + Demucs) into a first-party scenecraft-engine plugin; deprecate the M11 `isolate_vocals` MVP on launch.
**Created**: 2026-04-23
**Status**: Proposal

---

## Overview

M11 shipped `isolate_vocals` — a 2-stem (vocal + background) CPU-only plugin built on DeepFilterNet3 + a time-domain residual. It validated the plugin architecture but is intentionally narrow: one model, one pair of stems, seconds-to-minutes on CPU.

The separate beatlab project (`../davinci-beat-lab`) has a **different, richer** pipeline: three models chained (MDX23C-InstVoc → MDX23C-DrumSep → Demucs htdemucs_6s) produce **11 named stems** — `vocals`, `kick`, `snare`, `hh`, `ride`, `crash`, `toms`, `bass`, `guitar`, `piano`, `other`. Beatlab runs it on an ephemeral Vast.ai GPU (RTX PRO 6000 WS, ~$1/hr); a 5-minute source completes in minutes instead of ~2h on CPU. The handoff at `agent/reports/handoff-stem-isolation-remote-2026-04-23.md` describes the current state, open integration questions, and two backend bugs that gate productization.

This design **ports** that pipeline into a new `stem_splitter` plugin inside scenecraft-engine, following the M11 architecture exactly (same `audio_isolations` + `isolation_stems` schema, same panel, same drag-to-timeline), while adding three new concerns the M11 scope didn't have:

1. **Remote GPU execution** — scenecraft-engine gains a Vast.ai manager + SSH/rsync orchestration.
2. **Undo-exempt writes** — a stem_splitter run spends real money; pressing Ctrl+Z must not silently delete paid work.
3. **Any-length sources** — long sources split into overlapping chunks, per-chunk stems stitch back with crossfades into one run's worth of output.

When this lands, `isolate_vocals` gets marked deprecated. Its schema rows stay valid (they carry `model='deepfilternet3'` and stem_type values `vocal`/`background`); new work routes through `stem_splitter`.

---

## Problem Statement

- **M11 is too narrow for rich audio work.** 2 stems is enough for dialogue clean-up but not for per-instrument timeline editing, per-stem effect routing, stem-specific lipsync, or compositional remixing — all of which are on the scenecraft roadmap.
- **Source separation is CPU-prohibitive.** The 3-model pipeline takes ~2h for 5 min of audio on a laptop. That's a background job, not a user-facing operation.
- **Beatlab built the solution but in the wrong repo.** The GPU + Vast.ai orchestration lives in a separate tool. Scenecraft users can't access it from the editor. Copy-pasting outputs through a filesystem is not a UX.
- **Running two parallel plugins would fragment the UI.** If `isolate_vocals` stays and a new `stem_splitter` lands, users have two operations that do adjacent things on the same surface. Unifying is cleaner than coexistence.
- **Undo semantics for paid operations are wrong.** M11 wraps the entire run in `undo_begin`; Ctrl+Z reverts the audio_isolations + isolation_stems + pool_segments rows (files stay on disk). For DFN3 (CPU, free, fast) that's reasonable — rerunning is cheap. For stem_splitter (GPU, ~$0.50 per invocation, minutes to wait), a stray Ctrl+Z that erases stems is a foot-gun.

---

## Solution

### Approach

1. **Port beatlab's pipeline verbatim.** `beatlab/stems.py` (the 3-model orchestration + embedded remote-driver script) and `beatlab/render/cloud.py` (`VastAIManager`) copy into `scenecraft-engine/src/scenecraft/plugins/stem_splitter/`. Internal API shape stays the same; the plugin layer adapts the outputs into the M11 schema.
2. **Reuse the M11 schema.** One `audio_isolations` row per run; 11 `isolation_stems` rows per completed run. `stem_type_enum` widens from `[vocal, background]` to the 11-stem vocabulary. No new tables.
3. **Reuse the M11 panel.** `AudioIsolationsPanel` already shows runs + stems + drag handles; the only change is grouping the 11 stems visually (vocals / drums / melodic+other).
4. **New: undo-exempt write primitive.** Add a `persistent_write` helper in `db.py` that temporarily disables `undo_state.active` around a function's writes, so stem_splitter inserts do not enter the undo log. Single Ctrl+Z skips past them.
5. **New: source chunking.** When a source exceeds a threshold (initial value 10 min), split into overlapping chunks (e.g., 30 s overlap), run the 3-model pipeline per chunk, stitch per-stem outputs back with equal-power crossfades at chunk boundaries. Result is one contiguous stem per stem_type spanning the full source.
6. **New: GPU lifecycle.** `keep_alive` defaults ON; a background idle-timer destroys the instance after N minutes (default 20). Explicit `POST /plugins/stem_splitter/release` for manual teardown.

### Architecture

```
┌───────────────────────── scenecraft (frontend) ─────────────────────────┐
│  AudioIsolationsPanel  ← reused; 11-stem grouping layout                 │
│  IsolateVocalsRunForm  → rename to StemSplitterRunForm (or generalize)   │
│  AudioLane drop         ← reused; same overwrite-with-split              │
│  chat-tool UI           ← reused elicitation; summary expands to 11 stems │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ REST + WS (unchanged)
┌──────────────────────────────────▼──────────────────────────────────────┐
│                     scenecraft-engine (backend)                          │
│                                                                           │
│   plugins/stem_splitter/                                                  │
│     plugin.yaml          ← 11-stem outputs in manifest                   │
│     __init__.py          ← activate/deactivate; registers operation      │
│     stem_splitter.py     ← run() + handle_rest(); orchestration          │
│     remote.py            ← VastAIManager (ported from beatlab)           │
│     chunker.py           ← long-source split + crossfade stitching       │
│     models.py            ← embedded remote-driver script (3-model chain) │
│     tests/                                                                │
│                                                                           │
│   db.py                                                                   │
│     persistent_write(...) ← NEW: undo-exempt write primitive             │
│     audio_isolations      ← existing (M11 schema)                        │
│     isolation_stems       ← existing (stem_type widens to 11)            │
│                                                                           │
│   api_server.py                                                           │
│     POST /plugins/stem_splitter/run       (plugin-registered)            │
│     POST /plugins/stem_splitter/release   (plugin-registered)            │
└───────────────────────────────────────────────────────────────────────────┘
                                   │ SSH + rsync
┌──────────────────────────────────▼──────────────────────────────────────┐
│                       Vast.ai ephemeral instance                         │
│   pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime                          │
│   + build-essential (install-time; fixes beatlab's missing-gcc bug)      │
│   + audio-separator (MDX23C models)                                      │
│   + demucs (htdemucs_6s)                                                 │
│                                                                           │
│   /workspace/run_stem_split.py   (embedded driver; streams progress)     │
└───────────────────────────────────────────────────────────────────────────┘
```

### Naming Convention (matches M11)

| Concern | Value |
|---|---|
| Plugin name (manifest + Python module) | `stem_splitter` (snake) |
| Operation id (internal PluginHost registry) | `stem_splitter.run` (dot-separated) |
| Chat tool name (Claude API surface) | `stem_splitter__run` (`__` separator; dots forbidden by tool-name regex) |
| REST path | `/api/projects/:name/plugins/stem_splitter/run` |
| Release path | `/api/projects/:name/plugins/stem_splitter/release` |
| Panel id (PluginHost.registerPanel) | reuses `audio_isolations` (same UX surface) |

### Stem Vocabulary

```
stem_type ∈ {
  vocals,                               # MDX23C-InstVoc
  kick, snare, hh, ride, crash, toms,   # MDX23C-DrumSep (from instrumental)
  bass, guitar, piano, other            # Demucs htdemucs_6s (from instrumental)
}
```

Panel groups these into three sections for rendering:
- **Vocals** (1): `vocals`
- **Drums** (6): `kick`, `snare`, `hh`, `ride`, `crash`, `toms`
- **Melodic + other** (4): `bass`, `guitar`, `piano`, `other`

Legacy M11 rows keep their values (`vocal`, `background`) — no migration.

---

## Implementation

### Directory Layout

```
scenecraft-engine/src/scenecraft/
  plugins/
    stem_splitter/
      __init__.py
      plugin.yaml
      stem_splitter.py        # run() + handle_rest() + orchestration
      remote.py               # VastAIManager (ported)
      models.py               # embedded remote-driver script + wiring
      chunker.py              # long-source split + stitching
      README.md
      tests/
        __init__.py
        test_stem_splitter.py
        test_chunker.py
        test_remote_mocked.py
  db.py                       # + persistent_write helper

scenecraft/src/
  plugins/
    stem_splitter/
      plugin.yaml
      index.ts                # activate/deactivate; registers panel + op + context menus
      StemSplitterRunForm.tsx # inline Run form (extends/replaces IsolateVocalsRunForm)
      stem-splitter-client.ts # REST + WS helpers
      __tests__/
```

### Schema Additions

Only one change to `db.py` — a new helper, **no new tables**:

```python
@contextmanager
def persistent_write(project_dir: Path):
    """Block any write executed inside this contextmanager from entering
    the undo log. Used by plugins whose operations produce irreversible
    real-world side effects (GPU spend, external API calls) that the user
    must not inadvertently undo.

    Implementation: sets `undo_state.active = 0` on entry, restores prior
    value on exit. Works because every undo trigger is gated on
    `(SELECT value FROM undo_state WHERE key='active') = 1`.
    """
```

stem_splitter wraps its finalization writes (pool_segments, audio_isolations, isolation_stems) inside `with persistent_write(project_dir): ...`.

### Backend Handler Sketch

```python
# plugins/stem_splitter/stem_splitter.py

def run(entity_type: str, entity_id: str, context: dict) -> dict:
    """Kick off a stem-split. Returns {isolation_id, job_id} or {error}.

    context keys:
      - project_dir, project_name
      - keep_alive: bool (default True)
    """
    if entity_type != "audio_clip":
        return {"error": f"unsupported entity_type: {entity_type}"}

    # Pre-flight: credentials, source presence
    if not os.environ.get("VASTAI_API_KEY"):
        return {"error": "VASTAI_API_KEY not configured on server"}

    project_dir = context["project_dir"]
    source_path = _resolve_source_path(project_dir, entity_type, entity_id)
    if source_path is None:
        return {"error": "source audio not found"}

    # audio_isolations row (outside persistent_write — status transitions ARE
    # informational and can be reconstructed; the irreversible part is the
    # stems themselves).
    isolation_id = plugin_api.add_audio_isolation(
        project_dir, entity_type=entity_type, entity_id=entity_id,
        model="stem_splitter.v1", range_mode="full",
        trim_in=None, trim_out=None,
    )
    job_id = plugin_api.job_manager.create_job("stem_splitter", total=100, meta={...})

    def _work():
        try:
            plugin_api.update_audio_isolation_status(project_dir, isolation_id, "running")

            # 1. Chunk if necessary
            from .chunker import split_if_long
            chunks = split_if_long(source_path, max_chunk_seconds=600, overlap_seconds=30)
            plugin_api.job_manager.update_progress(job_id, 5, "source prepared")

            # 2. Provision / reuse GPU instance
            from .remote import get_or_create_stem_instance
            instance = get_or_create_stem_instance(keep_alive=context.get("keep_alive", True))
            plugin_api.job_manager.update_progress(job_id, 10, "instance ready")

            # 3. Per-chunk pipeline
            chunk_stems: list[dict[str, Path]] = []
            for i, chunk in enumerate(chunks):
                result = _run_pipeline_on_chunk(instance, chunk)  # 3 models
                chunk_stems.append(result)
                # 10 + (i/len) * 80 so progress reaches ~90% by last chunk
                plugin_api.job_manager.update_progress(
                    job_id, 10 + int((i + 1) / len(chunks) * 80),
                    f"chunk {i+1}/{len(chunks)} done",
                )

            # 4. Stitch per-stem across chunks
            from .chunker import stitch_chunks
            final_stems = stitch_chunks(chunk_stems, overlap_seconds=30)
            plugin_api.job_manager.update_progress(job_id, 95, "stitching complete")

            # 5. PERSISTENT WRITE — the paid-work protection
            now_iso = _now_iso()
            with persistent_write(project_dir):
                stems_out = []
                for stem_type, local_wav in final_stems.items():
                    seg_id = uuid.uuid4().hex
                    final_path = project_dir / "pool" / "segments" / f"{seg_id}.wav"
                    shutil.move(str(local_wav), str(final_path))
                    _insert_pool_segment(
                        project_dir, seg_id=seg_id,
                        pool_path=f"pool/segments/{seg_id}.wav",
                        duration=_wav_duration(final_path),
                        byte_size=final_path.stat().st_size,
                        created_by="stem_splitter", created_at=now_iso,
                        label=f"stem_splitter · {stem_type}",
                        generation_params={...},
                    )
                    plugin_api.add_isolation_stem(project_dir, isolation_id, seg_id, stem_type)
                    stems_out.append({
                        "stem_type": stem_type,
                        "pool_segment_id": seg_id,
                        "pool_path": f"pool/segments/{seg_id}.wav",
                    })
                plugin_api.update_audio_isolation_status(project_dir, isolation_id, "completed")

            plugin_api.job_manager.complete_job(job_id, {
                "isolation_id": isolation_id, "stems": stems_out,
            })
        except Exception as e:
            plugin_api.update_audio_isolation_status(project_dir, isolation_id, "failed", error=str(e))
            plugin_api.job_manager.fail_job(job_id, str(e))

    threading.Thread(target=_work, daemon=True).start()
    return {"isolation_id": isolation_id, "job_id": job_id}
```

### Remote Execution (Ported from beatlab)

`remote.py` lifts `VastAIManager` from `beatlab/render/cloud.py` with three material changes:

1. **`ssh_run` must surface exit codes.** Beatlab's version silently returns stdout even when the remote command failed — that's the root cause of the "silent install failure" bug. Port raises on non-zero exit and returns the stdout alongside the exit code.
2. **Install step includes `apt-get install -y build-essential`** before `pip install demucs` so `diffq`'s C extension builds successfully.
3. **Rate-limited API wrapper.** The 429 backoff + SSH-info caching that beatlab added in-session carries over verbatim.

The idle-teardown timer is new. It's a daemon thread started on instance creation; it polls a "last-used" timestamp updated by each run and destroys the instance when `now - last_used > idle_threshold`. `POST /plugins/stem_splitter/release` short-circuits the timer.

### Chunking (`chunker.py`)

```python
def split_if_long(
    source_wav: Path,
    *,
    max_chunk_seconds: int = 600,
    overlap_seconds: int = 30,
) -> list[Path]:
    """If source duration ≤ max_chunk_seconds, return [source].
    Otherwise split into overlapping chunks of (max, overlap) via ffmpeg
    -ss/-t. Returns chunk paths in time order."""

def stitch_chunks(
    chunk_stems: list[dict[str, Path]],
    *,
    overlap_seconds: int,
) -> dict[str, Path]:
    """For each stem_type present in every chunk, concatenate the per-chunk
    WAVs with equal-power crossfade at chunk boundaries (sine/cosine pair).
    Returns a single stitched WAV path per stem_type."""
```

Chunk boundaries are always at silence-preferred zero-crossings where possible; the equal-power crossfade hides any residual phase jump.

### UI Changes

The frontend changes are minimal because the M11 scaffolding generalizes:

- `AudioIsolationsPanel` stays. Its `StemRow` grouping gains a small enhancement: when the run's stems include the 11-stem vocabulary, render with collapsible vocals/drums/melodic sections; when they include the legacy 2-stem vocabulary, render flat (current behavior).
- `IsolateVocalsRunForm` generalizes into `StemSplitterRunForm` (or both coexist temporarily behind a plugin prop). Gains a **keep GPU warm** toggle.
- The plugin dir is new: `scenecraft/src/plugins/stem_splitter/`. Registration via PluginHost.register, same lifecycle hooks (dispose pattern).

### Chat Tool

`stem_splitter__run` mirrors `isolate_vocals__run`:

```python
STEM_SPLITTER_TOOL = {
    "name": "stem_splitter__run",
    "description": (
        "Split an audio_clip into 11 named stems (vocals, kick, snare, hh, ride, "
        "crash, toms, bass, guitar, piano, other) using a GPU-backed multi-model "
        "pipeline. Slow (~minutes), costs real money (~$0.50/run). User-confirmed. "
        "Use get_audio_clips or sql_query to find entity ids first."
    ),
    "input_schema": { ... },
}
```

Destructive-pattern match is already broad enough (`stem_` matches any future stem-* tool via the same `_DESTRUCTIVE_TOOL_PATTERNS` mechanism).

### Deprecation of `isolate_vocals`

On stem_splitter launch:

1. Add `deprecated: true` to `plugins/isolate_vocals/plugin.yaml`.
2. Chat tool `isolate_vocals__run` stays registered but emits a `deprecation_warning` in its tool description.
3. UI: `AudioIsolationsPanel`'s Run form shows a **"Use Stem Splitter instead"** link when an `isolate_vocals`-era run is selected.
4. Legacy `audio_isolations` rows with `model='deepfilternet3'` continue to render correctly (their stem_types stay `vocal`/`background`).
5. Two milestones later, consider removing the plugin entirely.

---

## Behaviors (proofed in design session)

Proofed inline against the user in the session preceding this doc. Rows are labelled for the spec phase.

### Base Cases

| # | Name | Given | When | Then (assertion slugs) |
|---|------|-------|------|------------------------|
| B1 | kickoff-from-audio-clip | valid audio_clip, `VASTAI_API_KEY` set | POST `/plugins/stem_splitter/run` | `returns-isolation-id-and-job-id`, `audio_isolations-row-inserted-pending`, `no-stems-yet` |
| B2 | progress-phase-events | run in progress | each model phase completes on remote | `job_progress-instvoc`, `job_progress-drumsep`, `job_progress-demucs`, `job_progress-stitch` |
| B3 | completion-writes-11-stems | pipeline done, chunks stitched | finalization | `11-isolation_stems-rows`, `11-pool_segments-rows-generated`, `11-files-on-disk`, `audio_isolations-status-completed`, `job_completed-with-stems-array-len-11` |
| B4 | panel-renders-grouped-stems | completed run on selected clip | open AudioIsolationsPanel | `11-stem-rows-visible`, `grouped-vocals-drums-melodic`, `each-row-has-peaks-canvas`, `each-row-draggable` |
| B5 | drag-stem-to-timeline | any stem row | drag + drop on audio lane | `mime-application-x-scenecraft-stem`, `same-overwrite-with-split-path-as-M11`, `single-undo-group-for-drop` |
| B6 | chat-tool-dispatch | destructive elicitation accepted | `stem_splitter__run` via chat | `summary-includes-stem-count-eta-cost`, `routes-via-PluginHost.get_operation`, `result-returns-isolation_id-plus-11-stems` |
| B7 | keep-alive-reuses-instance | prior run left warm instance | second kickoff within idle window | `existing-instance-reused`, `no-create_instance-call`, `faster-wall-time-than-B1` |
| B8 | idle-teardown-fires | warm instance idle past threshold | timer elapses | `destroy_instance-called`, `next-run-provisions-fresh` |
| B9 | explicit-release-endpoint | warm instance exists | POST `/plugins/stem_splitter/release` | `destroy_instance-called`, `200-success`, `registry-empty` |
| B10 | source-path-effective | audio_clip has selected pool_segment candidate | kickoff | `uses-get_audio_clip_effective_path`, `uploads-candidate-not-raw-source` |
| B11 | long-source-chunking | audio_clip > 10 min | kickoff | `source-split-into-overlapping-chunks`, `each-chunk-through-3-model-pipeline`, `stems-stitched-with-equal-power-crossfade`, `N-final-stems-match-source-duration-within-tolerance`, `single-audio_isolations-row-not-one-per-chunk` |

### Edge Cases

| # | Name | Given | When | Then |
|---|------|-------|------|------|
| E1 | missing-vast-credential | `VASTAI_API_KEY` unset | kickoff | `sync-error-credential-missing`, `no-audio_isolations-row`, `no-job-created` |
| E2 | no-gpu-offer | no offers ≤ $3/hr / ≥16GB VRAM | kickoff | `sync-error-no-gpu-available`, `no-instance-created` |
| E3 | remote-install-fails | unexpected dep error | kickoff → install step | `fail_job-with-install-error`, `audio_isolations-status-failed`, `ssh_run-propagated-exit-code-nonzero` |
| E4 | remote-driver-crash | driver errors mid-run | non-zero exit | `fail_job`, `no-partial-stems-written-to-db`, `status-failed-with-stderr-tail` |
| E5 | rsync-network-drop | download in progress | network drops | `retry-with-backoff`, `fail-cleanly-past-timeout`, `no-orphan-pool-files` |
| E6 | concurrent-runs-share-instance | run A in progress | run B kickoff | `shares-VastAIManager-registry`, `serial-queue-on-instance`, `single-gpu-provisioned` |
| E7 | ws-disconnect-during-run | client WS drops mid-run | | `run-survives-disconnect` (M11 parity), `audio_isolations-completes`, `reconnect-can-poll` |
| E8 | source-length-unrestricted | audio_clip of any duration (1s, 30min, 3hr) | kickoff | `no-length-based-errors`, `short-sources-skip-chunking`, `long-sources-use-B11-path` |
| E9 | source-no-audio-stream | video entity with silent/no audio track | kickoff | `sync-error-no-audio`, `no-rsync-upload` |
| E10 | plugin-deactivate-mid-run | HMR/deactivate fires, run in progress | `PluginHost.deactivate` | `run-survives-deactivate`, `disposables-run-LIFO`, `does-NOT-cancel-job` (negative) |
| E11 | undo-does-NOT-revert-run | 1 completed run | Ctrl+Z once | `undo-skips-stem_splitter-group`, `11-pool_segments-remain`, `11-isolation_stems-remain`, `audio_isolations-remains`, `prior-undoable-action-reverts-instead` (negative on the run) |
| E12 | re-run-no-dedup | prior completed run for same clip | kickoff again | `new-run-row`, `stems-regenerated-not-reused` |
| E13 | does-not-write-audio_candidates | any run | completion | `audio_candidates-table-unchanged`, `audio_clips.selected-untouched` |
| E14 | does-not-auto-fallback-to-cpu | remote fails | | `no-silent-local-execution`, `status-failed`, `user-must-opt-in-for-local-if-exposed` |
| E15 | no-warm-without-keep-alive | kickoff with `keep_alive=false` | completion | `destroy_instance-called`, `no-instance-left-running` |
| E16 | vast-rate-limit-429 | throttled REST | internal poll | `retry-with-backoff`, `uses-ssh-info-cache`, `no-unbounded-poll` |
| E17 | provision-timeout | create-instance hangs | past threshold | `fail-with-provision-timeout`, `partial-instance-destroyed` |
| E18 | does-not-call-undo_begin | any run | completion | `no-new-undo_groups-row-for-run-id` (negative), `stem-writes-not-present-in-undo_log` (negative) |

---

## Benefits

- **11-stem parity with beatlab** inside the scenecraft UX — users can finally split source audio per-instrument without leaving the editor.
- **Schema reuse.** Zero new tables; `isolation_stems` was designed to hold arbitrary stem_type values.
- **UI reuse.** `AudioIsolationsPanel`, stem drag, overwrite-with-split drop all work unchanged.
- **Proper undo semantics for paid work.** `persistent_write` is a db-layer primitive future plugins can use too (e.g., for externally-billed ops).
- **Any-length sources.** Chunking + stitching removes the soft 10-minute model limit that blocks long-source work.
- **Clear deprecation path.** `isolate_vocals` retires cleanly; legacy rows keep working.

---

## Trade-offs

- **Chunking introduces seam artifacts.** Even with equal-power crossfade, a transient on a chunk boundary can show up as a short phase anomaly on per-drum stems. Mitigation: prefer chunk boundaries at nearest silence ≤ 1s away; document the limitation; expose an override in the run form for users who want explicit boundaries.
- **`persistent_write` weakens the "everything is undoable" invariant.** The escape hatch is explicit and plugin-owned, but it means a reader can't assume every row in a project can be rolled back. Partial mitigation: `audio_isolations.generation_params` records `undo_exempt: true` so the fact is visible.
- **GPU cost leakage.** `keep_alive` default-ON is convenient for back-to-back runs but costs $1/hr idle. Mitigation: 20 min idle timer + explicit release endpoint + UI toggle.
- **SSH/rsync coupling.** Scenecraft-engine now has a runtime dep on an SSH client + rsync being installed on the host. Containerized deployments will need to bake these in.
- **Rate-limited Vast REST.** Beatlab's workarounds (backoff + SSH-info cache) port over, but any future "poll instance status" flow needs to respect the 2 req/s ceiling.
- **Cost estimation is hand-wavy.** `duration_seconds × some_constant × GPU_price_per_hour` is only approximate; actual time depends on model warm-up, network, and queue. Show a range, not a point estimate, in the elicitation.
- **11 stems is still a schema.** Different users will want different stem vocabularies; a future `stem_type` extensibility story (or per-model stem sets) is out of scope here.

---

## Dependencies

### External

- **Vast.ai API** — auth via `VASTAI_API_KEY`; 2 req/s per endpoint; 429 retry required.
- **pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime** Docker image on the remote.
- **audio-separator** (MDX23C wrapper) + **demucs** + **diffq** on the remote.
- **apt-get build-essential** on the remote for `diffq` C extension.

### Internal (scenecraft-engine)

- Existing: `audio_isolations`, `isolation_stems` tables; `PluginHost`; `job_manager`; `compute_peaks`.
- New: `persistent_write` contextmanager in `db.py`.
- New: `VastAIManager` (ported from beatlab with exit-code + install fixes).

### Internal (scenecraft)

- Existing: `AudioIsolationsPanel`, `AudioLane` drop handler, `PluginHost` (with dispose pattern + `registerPanel`), `plugin-api` (with `getSubscribeJob`).
- New: `plugins/stem_splitter/` directory (manifest, index, run form, client).

---

## Testing Strategy

### Backend

- **Unit (chunker.py)**: `split_if_long` for short (no-split), medium (2-chunk), long (N-chunk); `stitch_chunks` sample-level correctness with synthetic input; crossfade boundaries preserve RMS energy.
- **Unit (remote.py, mocked)**: `ssh_run` raises on non-zero exit; `get_or_create_stem_instance` reuses warm instance; idle timer destroys after threshold; `release` short-circuits timer.
- **Unit (stem_splitter.py)**: kickoff shapes, source resolution (reuse M11's `_resolve_source_path` test patterns), `persistent_write` path writes 11 rows without entering `undo_log`.
- **Integration (end-to-end with mocked remote)**: replace the remote pipeline with a fake that returns 11 silent WAVs of the right duration; exercise full orchestration incl. chunking + stitching + DB finalization.
- **Integration (undo skip)**: complete a run, create an undoable action after it, assert that `undo_execute` reverts the undoable action (not the stem_splitter run) and that a second `undo_execute` eventually runs out of undoable groups without touching the run.

### Frontend

- `AudioIsolationsPanel` renders 11 stems grouped; drag payload contents stay unchanged.
- `StemSplitterRunForm` kickoff POSTs expected body; `keep_alive` toggle flows through.
- `stem-splitter-client.ts` mocked fetch + mocked WS; completion payload with 11 stems flows into `onCompleted`.

### End-to-End (manual, once beatlab bugs are fixed)

1. Short source (30 s): complete run; 11 stems in panel; `audio_isolations.status='completed'` in DB.
2. Long source (25 min): chunked run; single audio_isolations row; 11 stitched stems of ~25 min each.
3. Keep-alive: two back-to-back runs; second is measurably faster; `create_instance` called once.
4. Release: manual release endpoint destroys instance; next run provisions fresh.
5. Undo: complete a run, then delete a keyframe, then Ctrl+Z. Keyframe restores; stem rows persist.

---

## Migration Path

1. **Backend prereq work.** Fix the beatlab-inherited bugs in the port: `ssh_run` exit-code propagation, `build-essential` install step, SSH-info cache + 429 backoff.
2. **Schema micro-change.** Add `persistent_write` to `db.py`. No SQL migration.
3. **Ship stem_splitter plugin.** Full backend + frontend; lands as a new milestone (M17 or similar).
4. **Deprecate `isolate_vocals`** on the same release: `deprecated: true` in manifest; chat tool description adds deprecation note; panel shows "Use Stem Splitter" affordance when an `isolate_vocals`-era run is selected.
5. **Soak period.** Keep both operations available for N milestones. Track usage; ensure no one relies on `isolate_vocals`-specific behavior we don't preserve (e.g., the residual `background` stem is not 1:1 replaceable by `stem_splitter`'s `other`).
6. **Remove `isolate_vocals` plugin** once soak passes.

---

## Key Design Decisions

### Scope & Architecture

| Decision | Choice | Rationale |
|---|---|---|
| Plugin model | Port beatlab pipeline into `stem_splitter` plugin following M11 architecture | Avoids two parallel overlapping plugins; reuses all panel/drag/chat infra |
| Schema | Reuse `audio_isolations` + `isolation_stems`; widen `stem_type` vocabulary to 11 | Schema was already designed for arbitrary N; no migration needed |
| Source entity types | `audio_clip` only for MVP | Matches M11 scope; other entity types are follow-up work |
| CPU fallback | Out of scope | 2h for 5 min audio is not user-facing; GPU-only keeps the UX story clean |
| Chat tool naming | `stem_splitter__run` | Matches the `{plugin}__{member}` convention (dots forbidden in Claude tool names) |

### Remote Execution

| Decision | Choice | Rationale |
|---|---|---|
| GPU provider | Vast.ai (inherited from beatlab) | Cheapest on-demand GPU option; `$1/hr` for RTX PRO 6000 WS |
| Keep-alive default | ON | Back-to-back runs are common; warm instance saves ~minutes per run |
| Idle teardown threshold | 20 minutes (configurable) | Balances cost ($0.33 for idle window) vs UX friction of re-provisioning |
| Concurrency | Serialize on warm instance (shared VastAIManager registry) | Simpler + matches the single-user expected workload; parallel provisioning is a later optimization |
| CPU fallback | None (see Scope table) | |
| Cost surfacing | Show an estimated range in elicitation (duration × per-sec rate) | Point estimates would be misleading given queue + warm-up variance |

### Undo Semantics

| Decision | Choice | Rationale |
|---|---|---|
| Undo behavior for stem_splitter runs | Exempt from undo | Paid GPU time; accidental Ctrl+Z erasing stems is a foot-gun |
| Implementation | New `persistent_write` contextmanager in `db.py` (toggles `undo_state.active=0` around writes) | Minimal change; reusable for future paid ops |
| M11 `isolate_vocals` undo behavior | Unchanged (still undoable) | DFN3 is CPU + free + fast; rerun is cheap |

### Source Handling

| Decision | Choice | Rationale |
|---|---|---|
| Source length constraint | None | Chunking handles any length |
| Chunking threshold | 10 minutes | MDX23C / Demucs quality starts degrading past ~10 min input; matches common model guidance |
| Chunk overlap | 30 seconds | Enough for crossfade to hide boundary artifacts; cheap on runtime |
| Stitching method | Equal-power (sine/cosine) crossfade at chunk boundaries | Preserves RMS across the seam |
| Chunk-boundary strategy | Prefer nearest silence within ±1 s of the split point | Minimizes transient cuts |

### Mid-Run Behavior

| Decision | Choice | Rationale |
|---|---|---|
| Cancellation | Not supported | Matches M11 "generation survives disconnect" pattern; user already paid |
| WS disconnect | Run continues; stems land in DB when complete | Matches M11 + feedback memory "don't cancel on WS close" |
| Plugin deactivate mid-run | Disposables fire in LIFO, but the job thread continues | Deactivate cleans registry state; ongoing work isn't a registry concern |

### Progress

| Decision | Choice | Rationale |
|---|---|---|
| Granularity | Phase-based (instvoc / drumsep / demucs / stitch) | Per-stem is 11 bumps of noise; phase is informative without being chatty |
| Per-chunk progress for long sources | Progress range split proportionally across chunks (e.g., 10 → 90% over N chunks) | Keeps the progress bar smooth; user sees forward motion |

---

## Open Questions

These surfaced during the behaviors-proofing session. Most are flagged for the pre-implementation clarification pass, not blockers for this design.

- **Q1**: Cost surfacing — show estimated `$X.XX – $Y.YY` range, or keep hand-wavy "a few dollars"? (Current design: range estimate from duration + rate.)
- **Q2**: Should the run form expose `keep_alive` as a user toggle, or is it always on with the idle timer as the only safety net? (Current design: toggle present, default on.)
- **Q3**: Chunk crossfade duration — is 30 s fixed, or user-adjustable? (Current design: fixed at 30 s; revisit if seam artifacts complain.)
- **Q4**: Should chunk boundary preference (silence-seek window) be configurable or hard-coded at ±1 s? (Current design: hard-coded for MVP.)
- **Q5**: On `isolate_vocals` deprecation, do we offer users a "re-run with Stem Splitter" action in the AudioIsolationsPanel for existing legacy runs? (Current design: yes, as a row-level affordance.)
- **Q6**: Should `audio_isolations.model` carry an additional sub-version string (`stem_splitter.v1`, `stem_splitter.v2`)? (Current design: yes, lets us migrate to newer model combos without schema change.)
- **Q7**: Do we expose a separate "cancel run" chat tool / REST endpoint? (Current design: no — matches M11 survive-disconnect semantics. If users ask for it after soak, revisit.)
- **Q8**: Does the panel need a "cost-paid" visual badge to make it clear which runs are undo-exempt? (Current design: yes — small `$` icon on the run card.)
- **Q9**: Long-source (>1h) UX — should the elicitation warn about cost before accepting, or just run? (Current design: warn with estimated cost; user can still accept.)

---

## Future Considerations

- **MDX23C v2 / newer stem models.** The plugin's `models.py` abstracts the 3-model pipeline behind a driver interface; swapping in a newer model set is a one-file change.
- **Stem-aware effect routing.** Per-stem gain, EQ, and compression presets can consume the `stem_type` column directly.
- **Stem-aware lipsync.** Only the `vocals` stem feeds ElevenLabs / sync.so lipsync — cleaner inputs, cheaper runs.
- **Streaming progress.** The current driver prints to stdout but doesn't emit structured events; later work can make the driver emit NDJSON progress over SSH/WS.
- **Parallel instance provisioning.** If single-user workloads grow, lift the "serialize on warm instance" constraint; VastAIManager can support a pool.
- **Stem bundle exports.** Ship a stems-zip download endpoint so users can round-trip to external DAWs.
- **Generalization across paid plugins.** `persistent_write` becomes the standard escape hatch for any plugin that talks to a billable API; formalize in the plugin-author docs.

---

**Status**: Proposal
**Recommendation**: Implement after the beatlab-inherited bugs (`build-essential`, `ssh_run` exit code) are fixed or confirmed-worked-around in the port. Size the work as a new milestone with ~8 tasks — roughly the same shape as M11 but with chunking + remote-execution adding complexity.
**Related Documents**:
- `agent/design/local.audio-isolation-plugin.md` — M11 precedent architecture
- `agent/clarifications/clarification-9-audio-isolation-stems-and-panel.md` — M11 scope clarifications that informed the panel / drag contract
- `agent/reports/handoff-stem-isolation-remote-2026-04-23.md` — beatlab → scenecraft handoff describing the source pipeline + known bugs
- `agent/milestones/milestone-11-audio-isolation-plugin.md` — M11 milestone doc (the plugin this design deprecates)
