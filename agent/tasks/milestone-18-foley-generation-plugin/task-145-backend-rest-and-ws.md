# Task 145: Backend REST + WS

**Milestone**: [M18](../../milestones/milestone-18-foley-generation-plugin.md)
**Design Reference**: [`local.foley-generation-plugin.md`](../../design/local.foley-generation-plugin.md) — "REST endpoints"
**Clarification**: [`clarification-12-foley-generation-plugin.md`](../../clarifications/clarification-12-foley-generation-plugin.md) — Item 5
**Estimated Time**: 3 hours
**Dependencies**: task-144 (backend plugin module)
**Status**: Not Started

---

## Objective

Expose the foley plugin's three REST endpoints and the JobManager WS events required by the frontend panel and chat tool.

---

## Steps

### 1. Routes

Register under `/api/projects/:project/plugins/generate-foley/*` using the same routing pattern as M16 music-gen:

```
POST   /run                                     → start a generation
GET    /generations?entityType=&entityId=       → list (optionally filtered)
POST   /generations/:id/retry                   → re-run with same params
```

### 2. POST /run

**Request body**:

```json
{
  "prompt": "footsteps on gravel",
  "duration_seconds": 2,
  "source_candidate_id": null,
  "source_in_seconds": null,
  "source_out_seconds": null,
  "negative_prompt": "music",
  "cfg_strength": 4.5,
  "seed": null,
  "entity_type": null,
  "entity_id": null,
  "count": 1
}
```

**Validation**:
- `count == 1` (MVP) — reject with 400 if not
- If `source_candidate_id` is provided: `source_in_seconds` and `source_out_seconds` are required; `source_out_seconds > source_in_seconds`; `(source_out_seconds - source_in_seconds) <= 30`
- `duration_seconds` when provided: `1 <= duration <= 30`
- `entity_type`: if provided, must be `'transition'` (MVP only supports this)

**Response** (202 Accepted):

```json
{
  "generation_id": "fgen_01HXXX...",
  "job_id": "job_01HXXX...",
  "status": "pending"
}
```

Kick off the JobManager task that invokes `generate_foley.run(job_id, request)`.

### 3. GET /generations

Query params:
- `entityType` (optional): `'transition'` or omitted
- `entityId` (optional): UUID; requires `entityType`
- `limit` (optional, default 50)
- `offset` (optional, default 0)

**Response**:

```json
{
  "generations": [
    {
      "id": "fgen_01HXXX...",
      "created_at": "2026-04-24T22:15:30Z",
      "mode": "v2fx",
      "prompt": "door slam",
      "duration_seconds": 2,
      "source_candidate_id": "trc_01HYYY...",
      "source_in_seconds": 12.3,
      "source_out_seconds": 14.3,
      "status": "completed",
      "entity_type": "transition",
      "entity_id": "tr_01HZZZ...",
      "tracks": [
        {
          "variant_index": 0,
          "pool_segment_id": "ps_01H...",
          "replicate_prediction_id": "pred_XXX",
          "duration_seconds": 2.0
        }
      ]
    },
    ...
  ]
}
```

When `entityType` + `entityId` provided, filter by those fields on `generate_foley__generations`. When omitted, return all for the project newest-first.

### 4. POST /generations/:id/retry

- Look up the original generation by id
- Reject with 404 if not found
- Reject with 400 if `status` is `'pending'` or `'running'` (already in flight)
- Create a new `generate_foley__generations` row with identical params (prompt, mode, duration, source_*, model params, entity_*)
- Kick off a new JobManager task
- Return 202 with the new generation_id + job_id

### 5. WS events on /ws/jobs

The JobManager already broadcasts these; plugin just emits them via `plugin_api.emit_job_event(job_id, event_name, payload)`:

```
job_started       → {generation_id, mode}
job_progress      → {stage: 'pretrim' | 'predicting' | 'downloading'}
job_completed     → {generation_id, pool_segment_id}
job_failed        → {generation_id, error}
```

Frontend's panel subscribes via the existing `/ws/jobs` channel.

### 6. Auth + active-org resolution

Reuse the double-gate middleware from M16 (`X-Scenecraft-API-Key` + session). Active-org resolution follows M16's order: header `X-Scenecraft-Org` → session `last_active_org` → single-org → HTTP 400. No new auth surface introduced.

### 7. Tests

- POST /run with valid t2fx body → 202 + generation_id
- POST /run with valid v2fx body (in/out, source_candidate_id) → 202 + generation_id
- POST /run with `count=2` → 400 (MVP enforces 1)
- POST /run with v2fx missing in/out → 400
- POST /run with `(out - in) > 30` → 400
- GET /generations (no filter) → all generations newest-first
- GET /generations?entityType=transition&entityId=X → filtered
- POST /generations/:id/retry on completed → 202 + new generation_id
- POST /generations/:id/retry on in-flight → 400
- POST /generations/:id/retry on non-existent → 404
- WS events emitted at expected points during run lifecycle

---

## Verification

- [ ] All three endpoints registered and responding
- [ ] Request body validation matches spec
- [ ] Tracks array populated correctly in GET response
- [ ] Retry endpoint creates a new generation row with identical params
- [ ] WS events fire at each lifecycle stage
- [ ] Double-gate auth middleware protects all endpoints
- [ ] No breaking changes to existing M16 endpoints

---

## Expected Output

```
scenecraft-engine/src/scenecraft/api/plugins/
└── generate_foley_routes.py                (new)

scenecraft-engine/tests/api/
└── test_generate_foley_routes.py           (new)
```

---

**Next Task**: [task-146](task-146-frontend-plugin-module.md) — Frontend plugin module
