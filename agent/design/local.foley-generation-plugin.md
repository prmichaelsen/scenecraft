# Foley Generation Plugin

**Concept**: scenecraft's first video-conditioned paid-API generation plugin — a foley (sound-effects) generator backed by MMAudio via Replicate, supporting both text-to-FX (t2fx) and video-to-FX (v2fx) modes from a single chat tool and panel. Introduces a typed `plugin_api.providers.<provider>` namespace as the long-term successor to M16's generic `call_service()` shim.
**Created**: 2026-04-24
**Status**: Design Specification
**Supersedes**: Nothing. Complements `local.audio-isolation-plugin.md` (first plugin, source-only), `local.stem-splitter-plugin.md` (future unification with GPU stem path), and the M16 `generate-music` plugin (first paid-API plugin, text-only).

---

## Overview

This document describes the architecture and design decisions for `generate-foley` — the second paid-API generation plugin in scenecraft. Unlike `generate-music` (text-only, single modality) the foley plugin exposes both text-prompt and video-conditioned generation, dispatches via a typed provider namespace on `plugin_api`, and uses selection state (not a UI toggle) to pick between modes.

The plugin generates short foley events — gunshots, door slams, footsteps, ambience — as new `pool_segments`, styled **orange** on the timeline, dragged by the user onto any existing audio track. In v2fx mode it accepts a user-specified in/out range on a selected transition candidate's video, pre-trims the clip server-side, and passes it to MMAudio for synchronized foley generation.

All requirements, per-decision rationale, and rejected alternatives are captured in [`clarification-12-foley-generation-plugin.md`](../clarifications/clarification-12-foley-generation-plugin.md). This design is the distilled canonical reference; the clarification is the decision log.

---

## Problem Statement

- **User-level problem.** Foley is a foundational part of film/video post-production — the physical, punctate sounds (footsteps, impacts, cloth, props) that ground on-screen action. Open-source AI foley models now exist (MMAudio, HunyuanVideo-Foley, FoleyCrafter) that can synthesize usable foley from text prompts or directly from video. scenecraft has no in-editor path to generate this; users must round-trip to external tools.
- **Modality gap.** The existing `generate-music` plugin is text-only (Musicful API). No existing plugin exercises the **video-conditioning** surface, which is where AI foley delivers its killer feature — synchronizing to on-screen events the user already sees.
- **Deployment constraint.** scenecraft boxes do not have persistent GPU. Deployment is ephemeral Vast.ai or local CPU. A plugin that runs models locally isn't tractable — the provider must be a hosted API. Replicate hosts MMAudio at `zsxkib/mmaudio`.
- **Provider-shim regret.** M16 introduced `plugin_api.call_service(service_name, request)` — a string-keyed generic dispatcher. That shape treats paid providers as opaque strings and pushes per-provider concerns (auth, polling, backoff, spend attribution) into each plugin. A second paid-API plugin is the right moment to generalize into a typed provider surface before the pattern calcifies.
- **Duration mismatch with music.** Foley is **punctate** (bursts) not **continuous** (music). A 2-minute scene doesn't want 2 minutes of foley; it wants a 0.5s pistol shot placed at the right moment. The M16 duration model (auto-match source length) is wrong for foley and needs replacement.

---

## Solution

### Approach

1. **Pick MMAudio as the model** — only open-source model that covers both t2fx and v2fx natively in a single weight set. CC-BY-NC license is acceptable under current non-commercial posture. HunyuanVideo-Foley (Apache 2.0) is the fallback if licensing tightens.
2. **Run via Replicate** — BYO `REPLICATE_API_TOKEN`. `zsxkib/mmaudio` on Replicate solves the no-GPU deployment constraint and inherits M16's BYO-key + `spend_ledger` billing pattern.
3. **Introduce `plugin_api.providers.replicate`** — a typed provider module on `plugin_api` that owns all provider-specific concerns (HTTP, polling, backoff, auth, spend_ledger, disconnect-survival, output download). Plugins call `plugin_api.providers.replicate.run_prediction(model=..., input=..., source=...)` and get back completed output. This is task-1 of the milestone, not a separate refactor.
4. **Selection-driven mode dispatch** — no UI radio toggle. Mode is inferred from what's selected in the editor. Nothing selected → t2fx. Transition + tr_candidate → v2fx. Transition without candidate → t2fx with a warning banner.
5. **Emit to `pool_segments` only** — no new candidate type, no `audio_candidates` row for foley. The output is a standalone audio asset; user drags it onto any audio track. Follows the music-gen pattern, not the transition-candidate pattern.
6. **Duration presets match foley's punctate nature** — Burst (2s) / Sequence (8s) / Ambience (30s) + slider override, 1s–30s range. Replaces music's "match source length" model.
7. **In/out range for v2fx** — Pattern B UX: user positions playhead, clicks `Set in`, re-positions, clicks `Set out`. Most-recent-click-wins invalidation (if user sets `out` ≤ `in`, `in` clears; and vice versa) — no silent reordering. Backend pre-trims source video to `[in, out]` before dispatching, because the cog forces `duration = video.duration_sec` when video is present.
8. **Schema mirrors `generate_music` exactly** — `generate_foley__generations` + `generate_foley__tracks` junction. Forward-looking multi-variant (`count=N`) comes free via the junction; MVP enforces `count == 1`.

### Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  FRONTEND (scenecraft/src/)                                              │
│  ┌─────────────────┐                                                     │
│  │ plugin-host.ts  │ ← static registry: [isolate_vocals, generate_music, │
│  └────────┬────────┘                            generate_foley]          │
│           │ reads                                                        │
│  ┌────────▼──────────────────┐   ┌─────────────────────────────────────┐ │
│  │ plugins/generate-foley/   │   │  lib/plugin-api.ts                  │ │
│  │   plugin.yaml             │   │  (registration helpers, WS job      │ │
│  │   index.ts  (descriptor)  │◄──┤   client, dialog host, toast,       │ │
│  │   FoleyGenerationsPanel   │   │   drag-payload helper, etc.)        │ │
│  │   client.ts               │   └─────────────────────────────────────┘ │
│  └───────────────────────────┘                                           │
│           │ registers                                                    │
│  ┌────────▼──────────────────────────────────────────────────┐           │
│  │  FoleyGenerationsPanel (plain React in PanelRegistry)    │           │
│  │   ├── selection-driven mode (nothing / tr+cand / tr)     │           │
│  │   ├── kickoff form: prompt, duration preset+slider,      │           │
│  │   │    Set-in/Set-out (v2fx), neg-prompt, cfg, seed      │           │
│  │   └── run list → per-generation card → drag pool to lane │           │
│  └──────────────────────────────────────────────────────────┘           │
└──────────┬───────────────────────────────────────────────────────────────┘
           │ REST + WS (/ws/jobs)
┌──────────▼───────────────────────────────────────────────────────────────┐
│  BACKEND (scenecraft-engine/src/scenecraft/)                             │
│  ┌─────────────────┐                                                     │
│  │ plugin_host.py  │ ← static registry (adds generate_foley)             │
│  └────────┬────────┘                                                     │
│           │ reads                                                        │
│  ┌────────▼──────────────────┐   ┌─────────────────────────────────────┐ │
│  │ plugins/generate_foley/   │   │  plugin_api.py                      │ │
│  │   plugin.yaml             │   │   ├── providers/                    │ │
│  │   __init__.py             │◄──┤   │     ├── __init__.py             │ │
│  │   generate_foley.py       │   │   │     └── replicate.py  ★ NEW     │ │
│  │   pretrim.py (ffmpeg)     │   │   ├── (existing helpers)            │ │
│  └───────────────────────────┘   │   └── call_service()  (deprecated)  │ │
│           │                      └─────────────────────────────────────┘ │
│           │ calls plugin_api.providers.replicate.run_prediction(...)     │
│           │ writes                                                       │
│  ┌────────▼────────────────────────────────────────────────────┐         │
│  │  project.db:                                                │         │
│  │    generate_foley__generations                              │         │
│  │    generate_foley__tracks  ──→  pool_segments               │         │
│  │                                                             │         │
│  │  server.db:                                                 │         │
│  │    spend_ledger (source='generate_foley', unit='prediction')│         │
│  └─────────────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────────┘
```

The **★ NEW** component is `plugin_api.providers.replicate` — a typed provider module that all current and future Replicate-backed plugins consume. The rest of the plugin follows the established pattern set by `generate-music` and `isolate-vocals`.

---

## Key Design Decisions

*(Distilled from [`clarification-12-foley-generation-plugin.md`](../clarifications/clarification-12-foley-generation-plugin.md). Format: decision | why.)*

### Model: MMAudio via Replicate
**Why**: Only open-source foley model covering both t2fx and v2fx in one weight set. Replicate hosting eliminates the no-GPU constraint. CC-BY-NC is tolerable under current non-commercial posture; HunyuanVideo-Foley (Apache 2.0) is the fallback if posture changes.

### Mode is selection-driven, not toggle-driven
**Why**: scenecraft already routes UX off of selection (current-candidate, selected-transition, etc.). A mode toggle would add redundant state. "Transition + candidate selected" naturally maps to v2fx because the conditioning video is already determined by the selection.

### Warning banner (not auto-pick) on transition-without-candidate
**Why**: Silent auto-picking of the "active" candidate would surprise users; disabling the Generate button would block legitimate t2fx use. Falling back to t2fx with an explanatory banner keeps the plugin usable and communicates intent.

### Duration: Burst/Sequence/Ambience presets + slider, 1–30s
**Why**: Foley is punctate, not continuous — music-gen's "match source length" is wrong here. Three presets match the three dominant foley classes. 1s is MMAudio's cog-level floor (`ge=1`); 30s is a product-side ceiling because MMAudio quality degrades past ~10–12s.

### v2fx duration = (out − in), never source length
**Why**: The cog overrides user duration with source video length when video is present. Pre-trimming source to the user's in/out range upstream is the only path that honors user intent. It also lets users generate short foley from a specific moment in a long clip without truncating the source.

### In/out UX: Pattern B (playhead + buttons)
**Why**: Re-uses the existing timeline + playhead — no new video preview component needed. Pattern matches `I` / `O` muscle memory from Premiere/Resolve/FCP. Most-recent-click-wins rule (user-specified) avoids silent reordering surprise.

### Output routes to `pool_segments` only, no `audio_candidates`
**Why**: Foley is a **new audio asset**, not a variant of an existing entity. The candidate pattern (`tr_candidates`, `audio_candidates`) is for operations that modify existing entities (lipsync on a character, alternative videos for a transition). Generation goes to pool, drag places it. Matches music-gen; doesn't match transition-gen.

### Typed `plugin_api.providers.replicate` instead of `call_service()`
**Why** (user directive): A string-keyed generic dispatcher treats providers as opaque. Each plugin ends up duplicating auth, polling, backoff, spend-ledger wiring. A typed per-provider surface localizes all provider concerns in the core, leaving plugins to express only model choice and input shape. Music-gen's eventual migration to `plugin_api.providers.musicful.*` is out of scope for this milestone but is the long-term direction.

### Schema mirrors `generate_music__generations` + `__tracks` exactly
**Why** (corrected after audit): No existing generator uses a `batch_id` column. Grouping is always via natural keys. Music's `__generations` + `__tracks` is the closest match to foley's semantics (net-new audio asset, drag-placed). Mirroring it gives forward-looking multi-variant for free via the junction.

### Single unified chat tool `generate_foley`
**Why**: Matches `generate_music` pattern. t2fx vs. v2fx is a trivial backend branch (`source_candidate_id is None`). Simpler tool surface for the LLM. One elicitation gate.

### No companion chat tools (list, retry, balance)
**Why**: Panel UX covers discovery and retry. Account balance is a provider concern, not a plugin concern — if exposed to chat later, it lives on `plugin_api.providers.replicate.get_balance()` and is surfaced via a generic "provider status" tool, not per-plugin.

### Clip color: orange
**Why**: Complements existing `variant_kind` → color palette (music=purple, lipsync=teal, default=blue). Warm tone reads as "organic/physical." No industry convention exists.

### Marker-driven foley explicitly dropped (not deferred)
**Why**: The fx-track-based hit-marker infrastructure this would have built on was removed entirely from scenecraft. Nothing to defer to.

---

## Implementation

### Schema

Two plugin-owned tables in `project.db`:

```sql
CREATE TABLE IF NOT EXISTS generate_foley__generations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,

    mode TEXT NOT NULL CHECK (mode IN ('t2fx', 'v2fx')),
    prompt TEXT,
    duration_seconds REAL,
    source_candidate_id TEXT,
    source_in_seconds REAL,
    source_out_seconds REAL,

    model TEXT NOT NULL,
    negative_prompt TEXT,
    cfg_strength REAL,
    seed INTEGER,

    entity_type TEXT CHECK (entity_type IN ('transition') OR entity_type IS NULL),
    entity_id TEXT,

    variant_count INTEGER NOT NULL DEFAULT 1,

    status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
    error TEXT,

    started_at TEXT,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS generate_foley__tracks (
    generation_id TEXT NOT NULL REFERENCES generate_foley__generations(id),
    pool_segment_id TEXT NOT NULL REFERENCES pool_segments(id),
    variant_index INTEGER NOT NULL,
    replicate_prediction_id TEXT NOT NULL,
    duration_seconds REAL,
    spend_ledger_id TEXT,
    PRIMARY KEY (generation_id, pool_segment_id)
);

CREATE INDEX IF NOT EXISTS idx_foley_gen_status ON generate_foley__generations(status);
CREATE INDEX IF NOT EXISTS idx_foley_gen_entity ON generate_foley__generations(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_foley_tracks_pool ON generate_foley__tracks(pool_segment_id);
```

Existing `pool_segments` columns consumed:
- `variant_kind = 'foley'` — drives orange clip color + pool filtering
- `context_entity_type = 'transition' | NULL`, `context_entity_id` — weak-ref to kickoff context (v2fx only)
- `derived_from` (FK to `pool_segments.id`) — strong-ref to source tr_candidate's pool_segment (v2fx only)
- `generation_params` (JSON) — `{provider: 'replicate', model: 'zsxkib/mmaudio', prompt, cfg_strength, seed, ...}`
- `created_by = 'plugin:generate-foley'`
- `kind = 'generated'`

### Provider module: `plugin_api.providers.replicate`

```python
# scenecraft-engine/src/scenecraft/plugin_api/providers/replicate.py (★ NEW)

from typing import Any

class ReplicateProvider:
    """Typed provider for Replicate-hosted models.

    Owns: auth, HTTP client, polling, backoff, spend_ledger, disconnect-survival.
    Plugins supply: model string + input dict + source tag.
    """

    def run_prediction(
        self,
        *,
        model: str,                       # e.g., "zsxkib/mmaudio"
        input: dict[str, Any],            # model-specific input
        source: str,                      # plugin id, for spend_ledger.source
        poll_interval: float = 5.0,
    ) -> dict[str, Any]:
        """Create a prediction, poll to completion, write spend_ledger on success,
        download output artifact(s) locally, and return {status, output_paths, raw}.

        Raises:
            ReplicateNotConfigured: if REPLICATE_API_TOKEN is missing
            ReplicatePredictionFailed: if the prediction returns status='failed'
            ReplicateDownloadFailed: if all download retries exhaust
        """
        ...

    def get_balance(self) -> float | None:
        """Optional: return Replicate account balance in USD. None if unavailable."""
        ...

    def attach_polling(self, prediction_id: str, source: str) -> None:
        """Re-attach polling to an in-flight prediction on box restart.

        Scanned on server start: any generation row with status IN ('pending','running')
        and a non-null replicate_prediction_id gets reattached.
        """
        ...
```

**Invariants** the provider enforces:
- `spend_ledger` is written iff Replicate returns `status='succeeded'` (Replicate's billing event, independent of our download).
- 429 response → exponential backoff (1s → 2s → 4s → fail) before surfacing to plugin.
- Download retries up to 3× with backoff before declaring failure.
- In-flight predictions survive WS/server restart; polling is reattached automatically.
- No raw DB access (R9a invariant): provider writes spend_ledger via `plugin_api.record_spend(...)`, not direct SQL.

### Plugin module: `plugins/generate_foley/generate_foley.py`

```python
from scenecraft.plugin_api import providers, add_pool_segment, emit_job_event
from scenecraft.plugins.generate_foley.pretrim import trim_video_to_range

def run(job_id: str, request: GenerateFoleyRequest) -> None:
    gen_id = create_generation_row(request)           # status='pending'
    emit_job_event(job_id, 'job_started', {'generation_id': gen_id})

    # Pre-trim source if v2fx
    video_arg = None
    if request.mode == 'v2fx':
        video_arg = trim_video_to_range(
            request.source_candidate_id,
            request.source_in_seconds,
            request.source_out_seconds,
        )

    update_generation_status(gen_id, 'running')

    # Delegate to typed provider
    result = providers.replicate.run_prediction(
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

    # Hash + insert to pool, link via __tracks
    pool_seg_id = add_pool_segment(
        bytes_=result.output_bytes,
        variant_kind='foley',
        context_entity_type=request.entity_type,
        context_entity_id=request.entity_id,
        derived_from=request.source_candidate_pool_segment_id,  # v2fx only
        generation_params={
            'provider': 'replicate',
            'model': 'zsxkib/mmaudio',
            'prompt': request.prompt,
            'cfg_strength': request.cfg_strength,
            'seed': request.seed,
        },
        created_by='plugin:generate-foley',
    )
    insert_track(gen_id, pool_seg_id, variant_index=0,
                 replicate_prediction_id=result.prediction_id,
                 spend_ledger_id=result.spend_ledger_id)
    update_generation_status(gen_id, 'completed')
    emit_job_event(job_id, 'job_completed', {'pool_segment_id': pool_seg_id})
```

### REST endpoints

```
POST   /api/projects/:project/plugins/generate-foley/run
GET    /api/projects/:project/plugins/generate-foley/generations?entityType=&entityId=
POST   /api/projects/:project/plugins/generate-foley/generations/:id/retry
```

WS events on `/ws/jobs`:
- `job_started` — `{job_id, generation_id}`
- `job_progress` — `{job_id, stage: 'pretrim'|'predicting'|'downloading'}`
- `job_completed` — `{job_id, generation_id, pool_segment_id}`
- `job_failed` — `{job_id, generation_id, error}`

### Chat tool surface

```python
generate_foley(
    prompt: str,
    duration: float | None = None,
    source_candidate_id: str | None = None,
    in_seconds: float | None = None,
    out_seconds: float | None = None,
    negative_prompt: str | None = None,
    cfg_strength: float | None = None,
    seed: int | None = None,
    count: int = 1,   # MVP enforces count == 1
) -> dict
```

Elicitation gate via `_DESTRUCTIVE_TOOL_PATTERNS` (costs money). Request/response includes `generation_id` for downstream queries.

### Frontend panel contract

- `FoleyGenerationsPanel` (plain React, `PanelRegistry`-registered, not a dockview panel)
- Selection-aware: reads current transition + tr_candidate from editor state
- Form fields: prompt (textarea), duration preset radio (Burst/Sequence/Ambience) + slider 1–30s (hidden in v2fx), Set-in/Set-out buttons (v2fx only), negative_prompt, cfg_strength, seed, Generate button
- Warning banner when transition selected but no candidate picked
- Run history: newest-first cards per `generate_foley__generations` row; each card shows prompt, mode, duration, status, Generate-Retry button, and (on success) the resulting pool_segment with a drag handle
- Drag handle emits `application/x-scenecraft-stem` payload with `stem_type='foley'` (consistent with M16 music's drag payload)

---

## Benefits

- **First video-conditioned paid-API plugin** — validates the v2fx code path across the stack (selection → pre-trim → provider → pool → drag)
- **Typed provider surface** — future Replicate-backed plugins (video upscaling, inpainting, etc.) inherit auth + polling + spend + download for free
- **Foley-appropriate duration model** — Burst/Sequence/Ambience mental model replaces music's continuous-length assumption
- **No new selection concept** — re-uses transition + tr_candidate selection; in/out range via playhead + buttons; no new timeline primitives
- **Forward-looking multi-variant** — `variant_count` + `__tracks` junction supports "generate 4 candidates" later without schema migration
- **Clean license escape hatch** — if CC-BY-NC becomes untenable, HunyuanVideo-Foley (Apache 2.0) is a drop-in replacement; the provider abstraction absorbs the model switch

---

## Trade-offs

- **Replicate lock-in for MVP** — no local GPU fallback. Users without Replicate credit can't use the plugin. Mitigation: license-fallback to HunyuanVideo-Foley is a deployment decision; Vast.ai path lands as a future milestone that adds a second backend under `plugin_api.providers.*`.
- **Pre-trim adds latency** — v2fx incurs an ffmpeg pass before dispatching. Mitigation: pre-trim is fast (seconds for typical clips; `-c copy` when keyframe-aligned). Also avoidable by making the range slider default to 8s and snapping to keyframes.
- **Spend attribution edge case** — if download fails after Replicate succeeds, user is charged but gets nothing. Mitigation: 3× download retry with backoff; `error` message explicitly states "prediction charged" so user can decide whether to retry.
- **Duration quality cliff above ~12s** — MMAudio training distribution centers on 8s. Ambience mode (30s) may produce lower-quality output. Mitigation: 30s is a product ceiling; can loosen or tighten based on real-user QA feedback.
- **CC-BY-NC taint** — MMAudio weights are non-commercial. User's current posture makes this moot, but if scenecraft.online ever opens commercial access, plugin must switch to HunyuanVideo-Foley (or another Apache 2.0 model). Mitigation: the provider abstraction is model-agnostic; swap is one line in `generate_foley.py`.

---

## Dependencies

### Internal
- **M16 (`generate-music`)** — precedent for plugin structure, BYO-key pattern, `spend_ledger` schema, JobManager + WS patterns
- **M6 auth** — user sessions + per-user env vars (`REPLICATE_API_TOKEN` scoped to the authenticated user)
- **`pool_segments` schema** — must include `variant_kind`, `context_entity_*`, `derived_from`, `generation_params` columns (all already present post-M13/M16)
- **`spend_ledger`** — introduced by M16 task-127; reused unchanged
- **`audio_clips` / audio tracks** — drop target for generated foley; no plugin-side dependency beyond drag-payload contract

### External
- **Replicate API** — `zsxkib/mmaudio` model, predictions endpoint, polling endpoint, account balance endpoint (optional)
- **MMAudio weights** — CC-BY-NC 4.0, hosted by Replicate on user's behalf
- **ffmpeg** — required on the backend for source-video pre-trimming (already a beatlab/scenecraft dep)

### New Infrastructure Introduced
- **`plugin_api.providers` namespace** — typed per-provider modules. `replicate` is the first concrete implementation. Future: `musicful` (migration target for M16), `elevenlabs`, `openai`, etc.
- **`ReplicateProvider.attach_polling`** — startup hook to reattach polling for in-flight predictions. Scanned from `generate_foley__generations WHERE status IN ('pending','running')` on server start. Generalizable to any Replicate-backed plugin.

---

## Non-Goals (Explicit)

- Marker-driven foley (one burst per hit-marker composed into a sequence) — **dropped entirely**; hit-marker fx-track infrastructure was removed from scenecraft.
- Batch / multi-candidate generation (`count > 1`) — schema forward-looking, MVP enforces `count == 1`.
- Local GPU or CPU inference paths — deferred; Replicate-only for MVP.
- Migrating `generate-music` from `call_service()` to `plugin_api.providers.musicful.*` — separate follow-up milestone.
- User-facing license disclosure banner — deferred until multi-tenant scenecraft.online lands.
- Auto-creating a "Foley" audio track — drop onto any existing lane.
- Snap-to-hit-markers on drag — inherited from M7 when it ships; no plugin-side logic.

---

## Open Questions

None at design time. All decisions are pinned in the clarification. Implementation-level details (exact frontend layout, `ReplicateProvider` internal structure, ffmpeg command line for pre-trim) are deferred to task design.

---

## Cross-References

- [`clarification-12-foley-generation-plugin.md`](../clarifications/clarification-12-foley-generation-plugin.md) — full decision log, Q&A transcript
- [`clarification-10-musicful-music-generation-plugin.md`](../clarifications/clarification-10-musicful-music-generation-plugin.md) — M16 precedent (text-only paid-API plugin)
- [`clarification-8-audio-isolation-plugin.md`](../clarifications/clarification-8-audio-isolation-plugin.md) — first scenecraft plugin, establishes panel + drag patterns
- [`local.audio-isolation-plugin.md`](local.audio-isolation-plugin.md) — first-plugin architecture reference
- [`local.scenecraft-online-platform.md`](local.scenecraft-online-platform.md) — trust boundary, auth model, commercial-license future
- M16 milestone document (when created) — music-gen plugin tasks that foley tasks mirror
