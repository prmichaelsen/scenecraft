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
- **M11's undo treatment is wrong in general (not just for stem_splitter).** M11 added `audio_isolations` + `isolation_stems` to `_undo_tracked_tables` by reflex, violating the scenecraft convention that generation-output tables (`pool_segments`, `tr_candidates`, etc.) stay outside undo. Ctrl+Z on a run today deletes the metadata rows but leaves the WAV files on disk → orphans. Bug-fix task filed in `agent/tasks/unassigned/task-fix-audio-isolations-undo-tracking.md`; stem_splitter depends on it landing first.

---

## Solution

### Approach

1. **Port beatlab's pipeline verbatim.** `beatlab/stems.py` (the 3-model orchestration + embedded remote-driver script) and `beatlab/render/cloud.py` (`VastAIManager`) copy into `scenecraft-engine/src/scenecraft/plugins/stem_splitter/`. Internal API shape stays the same; the plugin layer adapts the outputs into the M11 schema.
2. **Reuse the M11 schema.** One `audio_isolations` row per run; 11 `isolation_stems` rows per completed run. `stem_type_enum` widens from `[vocal, background]` to the 11-stem vocabulary. No new tables.
3. **Reuse the M11 panel.** `AudioIsolationsPanel` already shows runs + stems + drag handles; the only change is grouping the 11 stems visually (vocals / drums / melodic+other).
4. **Undo convention alignment.** Generation outputs live in non-undo-tracked tables — the scenecraft convention for `pool_segments`, `tr_candidates`, `audio_candidates`, etc. `audio_isolations` + `isolation_stems` belong in the same group but were incorrectly added to `_undo_tracked_tables` by M11 task-100b; that's a standalone bug fix (`agent/tasks/unassigned/task-fix-audio-isolations-undo-tracking.md`) that stem_splitter depends on. Once fixed, stem_splitter's finalize writes simply don't enter the undo log — no special primitive, no bypass mechanism. Ctrl+Z has nothing to undo because runs aren't editorial actions; they're artifacts.
5. **New: source chunking.** When a source exceeds a threshold (initial value 10 min), split into overlapping chunks with a 30 s default crossfade (user-adjustable in an Advanced disclosure, bounded [5, 60] s), run the 3-model pipeline per chunk, stitch per-stem outputs back with equal-power crossfades at chunk boundaries. Chunk-boundary seek: 30 s window centered on the nominal split point, picks the lowest-activity point within that range. Result is one contiguous stem per stem_type spanning the full source.
6. **New: host-level GPU lifecycle.** `keep_alive` defaults ON with a user-facing toggle in the Run form. A background idle-timer destroys the instance after 1 hour of no activity. Release endpoint is **host-level** (`POST /api/gpu/release`) not plugin-scoped — future plugins that share GPU provisioning won't each bring their own release path. Settings panel exposes a generic "Release GPU" CTA that lists active instances; the Run form's info popover links to it (opens Settings + focuses the anchor).

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
| REST path (run) | `/api/projects/:name/plugins/stem_splitter/run` |
| REST path (cancel) | `/api/projects/:name/plugins/stem_splitter/cancel` |
| REST path (release GPU) | `/api/gpu/release` (host-level, not plugin-scoped) |
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

**None.** The fix lives in the separate bug-fix task (`task-fix-audio-isolations-undo-tracking`): remove `audio_isolations` from `_undo_tracked_tables` and drop the composite-PK `isolation_stems` undo triggers. After that fix:

- `pool_segments` — not tracked (pre-existing)
- `audio_isolations` — not tracked (after the fix)
- `isolation_stems` — not tracked (after the fix)

All three of stem_splitter's finalize write targets sit outside the undo log by virtue of table choice. No contextmanager, no bypass primitive, no `undo_begin` wrapping. The plugin just inserts and the rows don't appear in any undo_group. Ctrl+Z has nothing to undo because nothing editorial happened.

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

            # 5. Finalize — writes are outside the undo log by virtue of
            # table choice (pool_segments, audio_isolations, isolation_stems
            # are all non-undo-tracked after the bug-fix task).
            now_iso = _now_iso()
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

### Removal of `isolate_vocals`

On stem_splitter launch, `isolate_vocals` is removed wholesale — no plugin module, no chat tool, no UI surface, no deprecation affordance. Legacy `audio_isolations` rows with `model='deepfilternet3'` continue to render in the panel because their stems already live in `pool_segments` (model-agnostic data); users see their 2 legacy stems and never know a plugin transition happened.

No "Use Stem Splitter instead" nudge, no badge, no panel banner — the user never cared which plugin ran, they cared about stems on the timeline. That story is unchanged.

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
| E11 | runs-not-in-undo-log | 1 completed run | inspect undo_log | `no-undo_log-entries-for-pool_segments-inserts`, `no-undo_log-entries-for-audio_isolations-insert`, `no-undo_log-entries-for-isolation_stems-inserts`, `Ctrl+Z-reverts-prior-editorial-action-if-any` |
| E12 | re-run-no-dedup | prior completed run for same clip | kickoff again | `new-run-row`, `stems-regenerated-not-reused` |
| E13 | does-not-write-audio_candidates | any run | completion | `audio_candidates-table-unchanged`, `audio_clips.selected-untouched` |
| E14 | does-not-auto-fallback-to-cpu | remote fails | | `no-silent-local-execution`, `status-failed`, `user-must-opt-in-for-local-if-exposed` |
| E15 | no-warm-without-keep-alive | kickoff with `keep_alive=false` | completion | `destroy_instance-called`, `no-instance-left-running` |
| E16 | vast-rate-limit-429 | throttled REST | internal poll | `retry-with-backoff`, `uses-ssh-info-cache`, `no-unbounded-poll` |
| E17 | provision-timeout | create-instance hangs | past threshold | `fail-with-provision-timeout`, `partial-instance-destroyed` |
| E18 | cancel-stops-run-and-marks-status | run in progress | POST `/plugins/stem_splitter/cancel` | `remote-driver-receives-SIGTERM`, `audio_isolations-status-cancelled`, `no-stems-written-to-pool_segments`, `job_cancelled-WS-event-fired`, `gpu-instance-stays-warm-per-keep_alive`, `no-spend-refund` (negative) |

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

- **Chunking introduces seam artifacts.** Even with equal-power crossfade, a transient on a chunk boundary can show up as a short phase anomaly on per-drum stems. Mitigation: 30 s low-activity search window around the split point picks the least-bad boundary; user-adjustable overlap duration (Advanced) gives power users a knob.
- **GPU cost leakage.** `keep_alive` default-ON is convenient for back-to-back runs but costs $1/hr idle. Mitigation: 1-hour idle timer + host-level Release GPU endpoint + user toggle in Run form + clear info popover explaining the tradeoff in non-technical language.
- **SSH/rsync coupling.** Scenecraft-engine now has a runtime dep on an SSH client + rsync being installed on the host. Containerized deployments will need to bake these in.
- **Rate-limited Vast REST.** Beatlab's workarounds (backoff + SSH-info cache) port over, but any future "poll instance status" flow needs to respect the 2 req/s ceiling.
- **Cost estimation is approximate.** `duration_seconds × GPU_price_per_sec × 1.5–2.5× factor` yields a range; actual time depends on model warm-up, network, and queue. Show the range in elicitation, no threshold-based warnings (users calibrate from the dollar amount).
- **Cancel wastes the partial GPU spend.** Cancelling mid-run doesn't refund the minutes already billed. Acceptable trade: users who cancel recognize they're giving up whatever was spent in exchange for not watching a botched run finish.
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

1. **Bug-fix prereq.** Land `agent/tasks/unassigned/task-fix-audio-isolations-undo-tracking.md` — removes `audio_isolations` from `_undo_tracked_tables`, drops the composite-PK triggers on `isolation_stems`, migrates existing project.dbs. This is a prerequisite; stem_splitter depends on the tables being outside undo.
2. **Backend prereq work.** Fix the beatlab-inherited bugs in the port: `ssh_run` exit-code propagation, `build-essential` install step, SSH-info cache + 429 backoff.
3. **Host-level GPU infrastructure.** Add `scenecraft.plugin_api.gpu` module with `release` endpoint + Settings panel CTA (generic "Release GPU"). First consumer is stem_splitter but the surface is shared-future.
4. **Ship stem_splitter plugin.** Full backend + frontend; lands as a new milestone (M17 or similar).
5. **Remove `isolate_vocals` entirely** on the same release — hide the switch from users per Q5. Legacy `audio_isolations` rows keep rendering; users never see the transition.

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
| Keep-alive default | ON, with a user-facing toggle in the Run form | Back-to-back runs are common; warm instance saves up to ~10 min per run. Toggle lets users opt out when one-off |
| Idle teardown threshold | 1 hour | Generous enough that batch sessions don't re-provision; cost ceiling ~$1 per idle hour |
| Release endpoint | Host-level: `POST /api/gpu/release` | GPU is a shared resource across future plugins; plugin-scoped release path would fragment |
| Settings "Release GPU" CTA | Generic (no plugin name) | Reusable when music-generation, color-grading, or other GPU-using plugins ship |
| Concurrency | Serialize on warm instance (shared VastAIManager registry) | Simpler + matches the single-user expected workload; parallel provisioning is a later optimization |
| CPU fallback | None (see Scope table) | |
| Cost surfacing | Show an estimated range in elicitation (duration × per-sec rate × 1.5–2.5× factor) | Point estimates would be misleading given queue + warm-up variance. No extra warning banner above threshold — users see the dollars, decide |
| Cancellation | `POST /plugins/stem_splitter/cancel` + UI button + `stem_splitter__cancel` chat tool | Long-running ops on wrong inputs need an escape hatch; cancel is non-elicitation-gated (reduces cost, doesn't add) |

### Undo

| Decision | Choice | Rationale |
|---|---|---|
| Where generation outputs live | Non-undo-tracked tables (`pool_segments`, `audio_isolations`, `isolation_stems` — after the bug-fix task) | Scenecraft convention. Generation outputs are artifacts, not editorial actions; reverting them orphans disk files |
| Special bypass primitive | None | Convention handles it via table choice; no `persistent_write` / `no_undo_log` contextmanager needed |
| Prereq: M11 undo-tracking bug fix | Separate task in unassigned/ (`task-fix-audio-isolations-undo-tracking.md`) | M11 added these tables to `_undo_tracked_tables` by mistake; must be fixed before stem_splitter ships |
| User-facing explanation | None | Nothing to explain — runs aren't user actions; undo doesn't apply. No "paid badge", no shield icon, no toast |

### Source Handling

| Decision | Choice | Rationale |
|---|---|---|
| Source length constraint | None | Chunking handles any length — short, long, multi-hour |
| Chunking threshold | 10 minutes | MDX23C / Demucs quality starts degrading past ~10 min input; matches common model guidance |
| Chunk overlap default | 30 seconds, user-adjustable in an Advanced disclosure (bounded [5, 60] s) | 30 s covers most seam artifacts; power users can tune per-run |
| Stitching method | Equal-power (sine/cosine) crossfade at chunk boundaries | Preserves RMS across the seam |
| Chunk-boundary seek window | 30 s window centered on the nominal split point, picks lowest-activity point within it | Wider window than silence-only finds low-activity pockets even in dense material; not user-configurable |

### Mid-Run Behavior

| Decision | Choice | Rationale |
|---|---|---|
| Cancellation | Supported via `POST /plugins/stem_splitter/cancel` + UI button + `stem_splitter__cancel` chat tool | Long runs on wrong params need an escape hatch — user shouldn't have to wait out a botched run; signals SIGTERM to remote, marks `status='cancelled'`, no spend refund |
| WS disconnect | Run continues; stems land in DB when complete | Matches M11 + feedback memory "don't cancel on WS close" |
| Plugin deactivate mid-run | Disposables fire in LIFO, but the job thread continues | Deactivate cleans registry state; ongoing work isn't a registry concern |

### Progress

| Decision | Choice | Rationale |
|---|---|---|
| Granularity | Phase-based (instvoc / drumsep / demucs / stitch) | Per-stem is 11 bumps of noise; phase is informative without being chatty |
| Per-chunk progress for long sources | Progress range split proportionally across chunks (e.g., 10 → 90% over N chunks) | Keeps the progress bar smooth; user sees forward motion |

---

## Open Questions

All 9 questions surfaced during design were resolved in the session with the user (see the Key Design Decisions tables for the chosen behavior); captured here briefly for provenance.

| Q | Topic | Resolution |
|---|-------|------------|
| Q1 | Cost surfacing | Range estimate (`$X.XX – $Y.YY`) in elicitation, computed from `duration × rate × 1.5–2.5× factor` |
| Q2 | `keep_alive` UI | User-facing toggle in Run form, default ON; info popover explains what a GPU is, why it takes up to 10 min to start fresh, what keeping it warm does, cost implication, and 1-hour auto-release |
| Q3 | Chunk overlap | Default 30 s, user-adjustable via Advanced disclosure, bounded [5, 60] s |
| Q4 | Boundary seek window | 30 s window centered on split point, pick lowest-activity point, not configurable |
| Q5 | `isolate_vocals` deprecation affordance | None — hide the switch entirely. Legacy rows render as plain data; users never see the transition |
| Q6 | `audio_isolations.model` version string | `{plugin_name}@{semver}` — e.g., `stem_splitter@1.0.0`. Source of truth is the plugin manifest's `version` field. Legacy rows stay as `deepfilternet3` |
| Q7 | Cancellation | Supported — `POST /plugins/stem_splitter/cancel` + UI button + `stem_splitter__cancel` chat tool. Not elicitation-gated |
| Q8 | "Paid / undo-exempt" badge | Dropped. Users won't expect generation outputs to undo; nothing to explain |
| Q9 | Long-source cost warning | No extra warning above Q1's baseline range. Users see the dollars, decide, proceed |

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
