# WebSocket Job Event Protocol

**Concept**: Discriminated WebSocket event envelope for long-running jobs — a `jobType` discriminator present on every event plus an optional typed `payload` per job kind. Unifies progress streaming across imagen, veo, extend-video, render, lipsync, and future job types.
**Created**: 2026-04-21
**Status**: Design Specification

---

## Overview

Scenecraft has a shared WebSocket event protocol for long-running backend jobs (`job_started`, `job_progress`, `job_completed`, `job_failed`). The protocol is emitted centrally by a single `JobManager` in `ws_server.py` and consumed by `JobStateContext` on the frontend, which feeds a unified `StatusBar` job-progress display and several per-panel async-action consumers.

As more job types have come online (imagen candidates, veo videos, extend_video, chat-initiated variants) and more types are planned (render in M12, lipsync in M8), the current flat-fields shape is starting to show strain:

- Progress/completion/failed events don't carry `jobType` — consumers must maintain a `jobId → jobType` map to route events
- All structured metadata is crammed into a single `detail: string` field, which makes rich UI (frame counts, multi-step progress bars) impossible
- Each new job type either pollutes the common envelope with optional fields or smuggles data through `detail` / `meta`

This design formalizes a **discriminated-union envelope** — every event carries its `jobType`, and an optional typed `payload` holds job-kind-specific detail. Additive migration: existing consumers keep working unchanged, new consumers opt into the richer shape.

---

## Problem Statement

The protocol as of 2026-04-21 has three concrete gaps:

1. **Missing type discriminator on most events**. Only `job_started` carries `jobType`. `job_progress`/`job_completed`/`job_failed` don't, so consumers must remember the type of every job from its `job_started` event. This makes reconnect/replay scenarios fragile and forces every consumer to own a `jobId → jobType` map.

2. **No structured payload**. All per-job metadata lives in a free-form `detail: string` (`"Step 2 of 5: Rendering"`) or in `meta: Record<string, unknown>` on `job_started` only. A render queue row that wants to show `{step_index, step_total, step_name, frames_done, frames_total}` has nowhere to put it; stuffing it into `detail` forces string-parsing in the frontend.

3. **Cross-cutting churn on each new job type**. The Render Workspace (M12) and Lip-Sync (M8) both need multi-step structured progress. Without a shared extension point, each milestone would either invent its own bespoke event type or add one-off optional fields to the common envelope, both of which compound over time.

**Consequences of leaving this alone**:
- Every new job type adds friction for frontend consumers
- `StatusBar` remains the only unified consumer because richer UIs are too expensive to build on string parsing
- Reconnect/replay gets more brittle as consumer count grows

---

## Solution

A **discriminated-union envelope** with two additive changes to the existing protocol:

1. **Propagate `jobType` onto every event**. Every emission site passes the job's type through to every event (not just `job_started`), so consumers don't need to maintain a lookup.
2. **Add `payload?: object`** — an optional, type-specific bag of fields indexed by `jobType`. Each job kind owns its own payload shape.

Existing fields (`jobId`, `completed`, `total`, `detail`, `meta`, `result`, `error`) keep their exact current semantics. Backward-compatible: consumers that don't read `jobType` or `payload` keep working; new consumers opt in.

### Envelope

```ts
type JobEvent =
  | { type: 'job_started';   jobId: string; jobType: JobType; total: number; meta: Record<string, unknown>; payload?: JobStartedPayload[JobType] }
  | { type: 'job_progress';  jobId: string; jobType: JobType; completed: number; total: number; detail: string; payload?: JobProgressPayload[JobType] }
  | { type: 'job_completed'; jobId: string; jobType: JobType; result: unknown; payload?: JobCompletedPayload[JobType] }
  | { type: 'job_failed';    jobId: string; jobType: JobType; error: string; payload?: JobFailedPayload[JobType] }
  | { type: 'job_canceled';  jobId: string; jobType: JobType }
```

- `type` = event kind (started/progress/completed/failed/canceled)
- `jobType` = domain kind (render / imagen / veo / lipsync / ...)
- Both are discriminators: event kind tells you which timeline phase you're in; job type tells you what the work is
- `payload` is optional and indexed by `jobType` for type-safe access
- `progress` is **derived** by consumers as `completed / total` (already the frontend convention) — kept as two fields for wire compatibility with existing code

### Per-type payload shapes

```ts
// Rationale: each job type owns its own payload; new types don't touch existing ones.

type RenderProgressPayload = {
  step_index: number          // 1-based
  step_total: number
  step_name: string           // "Rendering" | "Reencoding" | "Muxing"
  step_progress: number       // 0..1 within current step
  frames_done?: number
  frames_total?: number
  eta_seconds?: number
}

type RenderCompletedPayload = {
  output_path: string
  duration_seconds: number
  bytes: number
}

type ImagenProgressPayload = {
  candidates_done: number
  candidates_total: number
  prompt_preview?: string
}

type LipsyncProgressPayload = {
  step_name: 'whisperx' | 's2s' | 'sync'
  segments_done: number
  segments_total: number
}
```

Job types with no structured progress beyond `completed/total` (e.g., simple counter-style jobs) omit `payload` entirely and rely on the universal fields plus `detail`.

### Universal progress primitive remains `completed / total`

- `detail: string` stays as the human-readable label used by the unified `StatusBar` — emitters should populate it even when they also fill `payload`, so type-agnostic consumers render sensibly (`"Step 1 of 2 · Rendering · 150/300 frames"`)
- `completed / total` remains the universal percentage-bar primitive
- Rich/typed UI reads from `payload`

This dual-layer approach means a generic "jobs in flight" list (`StatusBar`) keeps working for every job type without any changes, while a dedicated Render Queue row that knows about render payloads can render step indicators, frame counts, and ETA.

---

## Implementation

### Backend — `JobManager` extension

In `scenecraft-engine/src/scenecraft/ws_server.py`:

1. Thread `jobType` through `JobManager.__init__` / per-job registration state so the manager owns the `jobId → jobType` map (instead of every consumer).
2. Update `emit_progress`, `emit_completed`, `emit_failed`, `emit_canceled` methods to include `jobType` automatically (looked up from registered job state).
3. Add an optional `payload: dict | None = None` kwarg to each emission method.
4. Update `JobManager.start_job` (or equivalent) to record the `jobType` on registration and optionally carry a starting payload.

Rough shape:

```python
class JobManager:
    def __init__(self, ws_broadcaster):
        self._ws = ws_broadcaster
        self._jobs: dict[str, dict] = {}  # jobId -> {jobType, ...}

    def start(self, job_id: str, job_type: str, *, total: int, meta: dict, payload: dict | None = None):
        self._jobs[job_id] = {"jobType": job_type}
        self._ws.send({
            "type": "job_started",
            "jobId": job_id,
            "jobType": job_type,
            "total": total,
            "meta": meta,
            **({"payload": payload} if payload is not None else {}),
        })

    def progress(self, job_id: str, *, completed: int, total: int, detail: str, payload: dict | None = None):
        job_type = self._jobs[job_id]["jobType"]
        self._ws.send({
            "type": "job_progress",
            "jobId": job_id,
            "jobType": job_type,
            "completed": completed,
            "total": total,
            "detail": detail,
            **({"payload": payload} if payload is not None else {}),
        })

    # ...completed, failed, canceled analogously
```

Every emission site (imagen, veo, extend_video, chat_generation, future render worker) already passes a `jobType` today — just threaded through the state now instead of passed per-event.

### Backend — per-emitter contract

Each emitter remains responsible for its own payload shape:
- `render_worker` populates `RenderProgressPayload` each emit
- `chat_generation.py` may populate `ImagenProgressPayload` (optional — pre-existing behavior preserved if it doesn't)
- `lipsync` worker (future M8) populates `LipsyncProgressPayload`

### Frontend — `JobStateContext` extension

In `scenecraft/src/contexts/JobStateContext.tsx`:

1. Extend the `JobMessage` type union to include `jobType` on all events and optional `payload`.
2. Store `jobType` + most-recent `payload` on each `JobEntry`:
   ```ts
   interface JobEntry<T extends JobType = JobType> {
     jobId: string
     jobType: T
     entityKey: string
     status: 'running' | 'completed' | 'failed' | 'canceled'
     progress: number                     // 0..1 (completed / total)
     detail: string
     payload: JobProgressPayload[T] | null
     result?: unknown
     startedAt: string
     completedAt?: string
   }
   ```
3. Expose a `useJobByType<T>(jobType: T)` selector that narrows payload types.

### Frontend — consumers

- **`StatusBar`** unchanged — continues reading `progress` + `detail`, gets free step-name display because backend emitters put the label in `detail`.
- **`RenderQueuePanel` (M12)** subscribes via `useJobByType('render')`; each row renders `RenderProgressPayload` natively (step indicator, frame counter, ETA).
- **Future** per-type renderers (`LipsyncJobRow`, `ImagenJobRow`) follow the same pattern.

Per-type row renderers can be colocated with their owning panel, not centralized — each job type's UI ships with its feature.

---

## Benefits

- **Self-identifying events**: Every event carries `jobType`; no consumer needs a `jobId → jobType` map.
- **Typed payloads**: New job types add arbitrary structured detail without polluting the shared envelope.
- **Backward-compatible**: Additive only; existing consumers (notably `StatusBar` and the async-action panel hooks) keep working unchanged.
- **Coherent UI surface**: Generic consumers use `completed/total` + `detail`; rich consumers use `payload`.
- **Scales with job-type count**: New kinds (render, lipsync, audio isolation) drop in without touching the envelope.
- **Reconnect-safe**: Because `jobType` travels on every event, a late-joining client can classify in-flight jobs without needing the original `job_started`.

---

## Trade-offs

- **Payload shape is untyped on the wire**. JSON doesn't enforce per-`jobType` payload schemas. Mitigation: TypeScript on the frontend, typed dataclasses on the backend, shared type definitions referenced by both.
- **Duplicate representation**. Some fields are expressible both in `detail` (string) and `payload` (structured). Rule: emitter populates both — `detail` is the human-readable fallback, `payload` is the structured truth. Consumers should prefer `payload` when available.
- **`jobType` registry drift**. The set of valid `jobType` values lives in both backend and frontend; they can drift silently. Mitigation: a single shared `JobType` enum/list checked in one place (or a type file with matching values in both repos).
- **Payload explosion risk**. Each job type can grow its payload indefinitely. Mitigation: keep payloads tight; anything event-specific (not job-lifecycle-wide) should stay in `detail` or be a separate derived event.
- **Minor breaking change for strict-typed consumers**. Consumers that assert exhaustive envelope shape will need to accept the new fields. In practice the only consumer today is `JobStateContext`, updated in this design.

---

## Dependencies

- Current `JobManager` in `scenecraft-engine/src/scenecraft/ws_server.py` (~lines 52–84)
- Current `JobStateContext` in `scenecraft/src/contexts/JobStateContext.tsx`
- Current `StatusBar` in `scenecraft/src/components/editor/StatusBar.tsx` (unaffected, but referenced)
- No new libraries required.
- No network or service dependencies.

---

## Testing Strategy

**Backend** (`scenecraft-engine/tests/test_job_manager_typed.py`):
- `JobManager.start()` stores `jobType`; subsequent `progress`/`completed`/`failed` events all include it
- Optional `payload` round-trips through the envelope unchanged
- Unknown `jobType` values don't crash (the manager is dumb — it just passes through)
- Reconnect scenario: replaying events to a fresh subscriber carries `jobType` on every message

**Frontend** (`scenecraft/src/contexts/__tests__/JobStateContext.test.tsx`):
- `job_progress` with `payload` sets `JobEntry.payload` correctly
- Missing `payload` leaves `JobEntry.payload` as `null`
- Changing `jobType` between events for the same `jobId` is forbidden — the first event's type wins; a mismatched type is logged and dropped
- `useJobByType<'render'>()` narrows payload type at compile time

**Cross-cutting**:
- Existing imagen/veo/extend_video jobs continue to work without any payload (verified by unchanged integration tests)
- A render worker test (M12 Task 108) verifies the render payload shape is parsed correctly by `RenderQueuePanel`

---

## Migration Path

Fully additive; no coordinated breakage required.

1. **Backend extension** (one change): update `JobManager` to propagate `jobType` onto every event and accept an optional `payload` kwarg.
2. **Frontend extension** (one change): update `JobStateContext` type union to accept the new fields; store them on `JobEntry`.
3. **Existing emitters stay as-is**. imagen/veo/chat_generation/extend_video keep their current calls — they get `jobType` on every event for free once step (1) lands.
4. **New emitters opt into payloads**. The render worker (M12 Task 108) is the first to emit structured `payload`. Lipsync (M8 Task 64) is next. Existing emitters can opt into payloads incrementally when their UIs get upgraded.
5. **No deprecation** of `detail`, `completed`, `total`, `meta`, `result`, `error`. They remain first-class.

No data migration. No version bump. Consumers not updated on deploy day keep functioning normally.

---

## Key Design Decisions

### Envelope shape

| Decision | Choice | Rationale |
|---|---|---|
| Add `jobType` to every event | Yes — not just `job_started` | Consumers shouldn't need a `jobId → jobType` map; makes reconnect/replay robust |
| Structured payload mechanism | Optional `payload?: object` field, typed per-`jobType` | Clean discriminated-union pattern; doesn't pollute the common envelope |
| Backward compat | Additive-only (no rev) | Minimizes blast radius; existing emitters (~17 sites) stay untouched; one backend edit point |
| Where `progress` lives | Derived `completed / total` stays universal; rich detail in `payload` | Keeps `StatusBar` working without changes; lets rich UIs bypass string-parsing |
| Relationship between `detail` and `payload` | Both populated; `detail` is the human label, `payload` is the structured truth | Generic consumers (StatusBar) get nice strings for free; typed consumers prefer `payload` |

### Ownership

| Decision | Choice | Rationale |
|---|---|---|
| Who tracks `jobType` | Backend `JobManager` — threaded through `start()` / state, not passed per-emit | Consistent, less chance of typos; single source of truth |
| Who defines payload shapes | The feature that emits them (e.g. render worker defines `RenderProgressPayload`) | Each milestone owns its contract; no central god-type |
| Type safety | TypeScript on frontend, typed dataclasses / dicts on backend | No on-wire schema enforcement, but compile-time safety on each side |

### Out of scope

- Per-type payload validation on the wire (JSON schema etc.) — deliberately not taken. Observation: the bug surface for mistyped payloads is small because each payload is produced by one emitter and consumed by one renderer.
- Event-level retries / acks / ordering guarantees — unchanged from current protocol.
- Protocol versioning — not needed because the change is fully additive.

---

## Future Considerations

- **`jobType` enum centralization**. Currently ~9 values scattered across emission sites. A shared enum or manifest (even a type file shared between backend and frontend) would prevent drift. Candidate follow-up.
- **Typed emitter helpers**. Backend convenience: `render_manager.progress(job_id, step=1, step_total=2, step_name="Rendering", frames_done=150, frames_total=300)` that builds the payload internally. Reduces boilerplate in the worker.
- **Per-job-type subscription filtering**. A frontend consumer could subscribe only to a specific `jobType` to reduce context churn. Easy if the transport supports it; otherwise client-side filter.
- **Auditing / job history UI**. Once every event self-identifies, a historical timeline of completed jobs (with their payloads) becomes trivial.
- **Cancellation events**. `job_canceled` was added to the envelope here; emission sites for cancellation should be surveyed in a follow-up (right now most emitters don't emit it, they just stop emitting progress).

---

**Status**: Design Specification
**Recommendation**: Implement the backend extension and frontend type update as a shared task referenced by M12 Task 108 (first consumer) and future M8 lipsync tasks. No separate milestone required.
**Related Documents**:
- [Render Workspace design](local.render-workspace.md) — first typed payload consumer (M12)
- [Characters & Lip-Sync design](local.characters-and-lipsync.md) — second typed payload consumer (M8)
- `JobManager` (backend): `scenecraft-engine/src/scenecraft/ws_server.py`
- `JobStateContext` (frontend): `scenecraft/src/contexts/JobStateContext.tsx`
- `StatusBar` (unified consumer, unchanged): `scenecraft/src/components/editor/StatusBar.tsx`
